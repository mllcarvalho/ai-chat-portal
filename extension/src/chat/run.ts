import * as crypto from 'node:crypto';
import {
  DEFAULT_PROVIDER,
  type AgentPreset,
  type ChatAttachment,
  type ChatErrorCode,
  type ChatFinishReason,
  type ChatMessage,
  type MessagePart,
  type Project,
  type Session,
  type SkillWithContent,
  type TokenUsage,
} from '@aiportal/shared';
import type { ChatStream } from './streamHub';
import { getAgent } from '../storage/agentStore';
import { sessionWorkspaceDir } from '../storage/paths';
import { getProject, projectDir } from '../storage/projectStore';
import { toSummary, updateSession } from '../storage/sessionStore';
import { getSkill, listSkills } from '../storage/skillStore';
import { registerRequest, releaseRequest } from './activeRequests';
import { resolveProvider } from './providers';
import type { TurnContext } from './providers/types';

export interface ChatRunArgs {
  session: Session;
  text: string;
  attachments?: ChatAttachment[];
  /** Editar/regenerar: descarta o histórico a partir desta mensagem do usuário. */
  retryFromMessageId?: string;
  /** Id (UUID) da mensagem do usuário gerado no cliente — UI e disco ficam com o mesmo id. */
  userMessageId?: string;
  requestId: string;
  sse: ChatStream;
}

/**
 * Ciclo de vida de uma resposta, independente de quem responde: persiste a
 * mensagem do usuário, monta o contexto, delega o turno ao provider da
 * sessão e persiste/anuncia o desfecho. Tudo o que é específico de um
 * backend mora em chat/providers/.
 */
export async function runChat(args: ChatRunArgs): Promise<void> {
  const { session, sse, requestId } = args;

  // 1. persiste a mensagem do usuário imediatamente
  const userParts: MessagePart[] = [];
  if (args.text) userParts.push({ type: 'text', text: args.text });
  for (const att of args.attachments ?? []) {
    userParts.push({ type: 'attachment', name: att.name, content: att.content });
  }
  const userMessage: ChatMessage = {
    // aceita o id gerado no cliente (UUID): se a conexão cair antes do meta,
    // a UI e o disco ainda concordam sobre qual mensagem é qual
    id:
      args.userMessageId && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(args.userMessageId)
        ? args.userMessageId
        : crypto.randomUUID(),
    role: 'user',
    parts: userParts,
    createdAt: new Date().toISOString(),
  };
  const applyUserTurn = (s: Session): void => {
    // editar/regenerar: reescreve a conversa a partir da mensagem indicada
    if (args.retryFromMessageId) {
      const idx = s.messages.findIndex(
        (m) => m.id === args.retryFromMessageId && m.role === 'user',
      );
      if (idx >= 0) {
        s.messages.splice(idx);
        // A sessão do lado da CLI (retomada com --resume) ainda contém o trecho
        // que acabou de ser apagado — o modelo lembraria do que o usuário
        // descartou. Começa uma sessão nova; o provider reenvia o histórico
        // que sobrou.
        s.providerSessionId = undefined;
      }
    }
    s.messages.push(userMessage);
    if (s.title === 'Nova conversa' && s.messages.length === 1) {
      const firstLine = args.text.split('\n')[0] || args.attachments?.[0]?.name || 'Nova conversa';
      s.title = firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
    }
  };
  applyUserTurn(session); // snapshot local usado para montar o prompt
  if (args.retryFromMessageId) session.providerSessionId = undefined;
  updateSession(session.id, applyUserTurn);
  // primeira troca da conversa: depois do done, o provider pode gerar o título
  const isFirstExchange = session.messages.length === 1;

  const assistantMessageId = crypto.randomUUID();
  sse.send('meta', { requestId, userMessageId: userMessage.id, assistantMessageId });

  const agent: AgentPreset | undefined = session.agentId ? getAgent(session.agentId) : undefined;
  const project: Project | undefined = session.projectId
    ? getProject(session.projectId)
    : undefined;
  // toda conversa tem uma pasta de trabalho: a do projeto, ou um workspace
  // próprio da sessão (criado sob demanda na primeira escrita/comando)
  const workRoot = project ? projectDir(project) : sessionWorkspaceDir(session.id);
  // toda skill vale das duas formas: ativada injeta o conteúdo no contexto…
  const instructionSkills = session.activeSkillIds
    .map((id) => getSkill(id))
    .filter((s): s is SkillWithContent => !!s);
  // …e qualquer skill visível para a sessão (globais + do projeto) pode ser
  // invocada por /comando, não só as ativadas — espelha o menu da UI
  const commandSkills = listSkills(session.projectId ?? undefined)
    .map((s) => getSkill(s.id))
    .filter((s): s is SkillWithContent => !!s);
  // skills vinculadas ao agente: garantidas no catálogo mesmo fora do escopo da sessão
  for (const id of agent?.skillIds ?? []) {
    if (commandSkills.some((s) => s.id === id)) continue;
    const skill = getSkill(id);
    if (skill) commandSkills.push(skill);
  }

  const provider = resolveProvider(session.provider ?? DEFAULT_PROVIDER);

  const assistantParts: MessagePart[] = [];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, requests: 0 };
  let finishReason: ChatFinishReason = 'stop';
  let chatError: { code: ChatErrorCode; message: string } | undefined;
  let respondedModelId: string | undefined;
  let providerSessionId: string | undefined;
  let afterDone: (() => Promise<void>) | undefined;

  // registrado colado no try/finally: qualquer saída passa pelo releaseRequest
  const cts = registerRequest(requestId);
  sse.onClose(() => cts.cancel());
  const ctx: TurnContext = {
    session,
    text: args.text,
    attachments: args.attachments ?? [],
    agent,
    project,
    workRoot,
    instructionSkills,
    commandSkills,
    requestId,
    assistantMessageId,
    sse,
    token: cts.token,
    parts: assistantParts,
    usage,
  };
  try {
    const result = await provider.runTurn(ctx);
    finishReason = result.finishReason;
    respondedModelId = result.modelId;
    providerSessionId = result.providerSessionId;
    afterDone = result.afterDone;
  } catch (err) {
    if (cts.token.isCancellationRequested) {
      finishReason = 'cancelled';
    } else {
      finishReason = 'error';
      chatError = provider.mapError(err);
      sse.send('error', chatError);
    }
  } finally {
    releaseRequest(requestId);
  }

  // tool call sem resultado (stop no meio das ferramentas, max_rounds, erro
  // mid-stream) não pode ir para o histórico: na próxima mensagem o
  // buildMessages reenviaria um ToolCallPart órfão e o backend do Copilot
  // rejeita a conversa inteira. Sintetiza o desfecho antes de persistir.
  const resolvedCallIds = new Set(
    assistantParts.flatMap((p) => (p.type === 'tool_result' ? [p.callId] : [])),
  );
  for (const part of [...assistantParts]) {
    if (part.type !== 'tool_call' || resolvedCallIds.has(part.callId)) continue;
    const synthetic: MessagePart = {
      type: 'tool_result',
      callId: part.callId,
      toolName: part.toolName,
      ok: false,
      content:
        finishReason === 'max_rounds'
          ? 'Ferramenta não executada: a resposta atingiu o limite de rodadas.'
          : 'Ferramenta não executada: a resposta foi interrompida antes da execução.',
      durationMs: 0,
    };
    assistantParts.push(synthetic);
    sse.send('tool_result', {
      callId: synthetic.callId,
      toolName: synthetic.toolName,
      ok: false,
      content: synthetic.content,
      durationMs: 0,
    });
  }

  // 2. persiste a resposta (mesmo parcial/com erro) sobre o estado mais novo
  // do disco — um rename/edição concorrente da mesma sessão não é sobrescrito
  let savedAssistant: ChatMessage | undefined;
  if (assistantParts.length || chatError) {
    savedAssistant = {
      id: assistantMessageId,
      role: 'assistant',
      parts: assistantParts,
      // ctx.respondedModelId sobrevive a um turno que lançou exceção
      modelId: respondedModelId ?? ctx.respondedModelId ?? session.modelId,
      ...(usage.requests ? { usage } : {}),
      createdAt: new Date().toISOString(),
      finishReason,
      ...(chatError ? { error: chatError } : {}),
    };
  }
  const updated = updateSession(session.id, (s) => {
    if (savedAssistant) s.messages.push(savedAssistant);
    // conversa da CLI: guarda o id do lado de lá para o próximo turno retomar
    if (providerSessionId && s.providerSessionId !== providerSessionId) {
      s.providerSessionId = providerSessionId;
    }
  });

  sse.send('done', {
    finishReason,
    updatedSession: toSummary(updated ?? session),
    ...(usage.requests ? { usage } : {}),
    ...(respondedModelId ? { modelId: respondedModelId } : {}),
  });

  // título gerado por modelo (como o Copilot): melhor esforço em background —
  // se terminar enquanto o stream espera o afterDone, a UI atualiza na hora
  if (isFirstExchange && finishReason !== 'error' && provider.generateTitle) {
    const assistantText = (savedAssistant?.parts ?? [])
      .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    void provider
      .generateTitle(ctx, assistantText)
      .then((title) => {
        if (!title) return;
        const renamed = updateSession(session.id, (s) => {
          s.title = title;
        });
        if (renamed) sse.send('session_update', { updatedSession: toSummary(renamed) });
      })
      .catch(() => {
        // melhor esforço: mantém o título derivado da primeira linha
      });
  }

  // medições que só existem depois do done (ex.: créditos do Copilot, que o
  // GitHub leva alguns segundos para contabilizar)
  if (afterDone) {
    try {
      await afterDone();
    } catch {
      // custo é cosmético: falhou, a mensagem fica sem o campo
    }
  }
  sse.close();
}

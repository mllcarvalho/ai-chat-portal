import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import type {
  AgentPreset,
  ChatAttachment,
  ChatErrorCode,
  ChatFinishReason,
  ChatMessage,
  MessagePart,
  Project,
  Session,
  SkillWithContent,
  TokenUsage,
} from '@aiportal/shared';
import type { SseStream } from '../server/sse';
import { getAgent } from '../storage/agentStore';
import { getConfig } from '../storage/configStore';
import { ensureDir, sessionWorkspaceDir } from '../storage/paths';
import { getProject, projectDir } from '../storage/projectStore';
import { saveSession, toSummary } from '../storage/sessionStore';
import { getSkill, listSkills } from '../storage/skillStore';
import {
  PROJECT_ONLY_TOOL_NAMES,
  dispatchBuiltinTool,
  isBuiltinTool,
  resolveInProject,
} from '../tools/builtinTools';
import { describeEnvForPrompt } from '../tools/envCheck';
import { callMcpTool } from '../tools/mcpManager';
import { executeCommand } from '../tools/runCommand';
import { getEnabledToolDefs } from '../tools/toolRegistry';
import { collectKnowledgeContext } from '../storage/knowledgeStore';
import { buildMessages, type ContextFile } from './messageBuilder';
import { registerRequest, releaseRequest } from './activeRequests';
import { waitForApproval } from './approvals';
import { waitForAnswer } from './questions';
import { runSubagent, type SubagentOutcome } from './subagent';
import { creditsRemaining } from '../server/routes/copilot';
import { withTimeout } from '../util';

const MAX_ROUNDS = 20;
/** Cada subagente é uma conversa própria no Copilot — teto por rodada. */
const MAX_SUBAGENTS_PER_ROUND = 8;
const TOOL_RESULT_CLAMP = 64 * 1024;
/** Limite por arquivo fixado no contexto da sessão. */
const CONTEXT_FILE_CLAMP = 64 * 1024;
/** Ferramentas que dependem da pasta de trabalho existir no disco. */
const WORKSPACE_FS_TOOLS = [
  'portal_write_file',
  'portal_read_file',
  'portal_list_files',
  'portal_edit_file',
  'portal_search_files',
  'portal_delete_file',
  'portal_move_file',
];

/** Lê os arquivos fixados no contexto da sessão; ignora os que sumiram do disco. */
function readContextFiles(session: Session, workRoot: string): ContextFile[] {
  if (!session.contextFiles?.length) return [];
  const result: ContextFile[] = [];
  for (const rel of session.contextFiles) {
    try {
      const file = resolveInProject(workRoot, rel);
      const content = fs.readFileSync(file, 'utf8');
      result.push({ path: rel, content: clamp(content, CONTEXT_FILE_CLAMP) });
    } catch {
      // arquivo removido/inacessível — segue sem ele
    }
  }
  return result;
}

/** Estimativa local usada quando countTokens falha (~3.5 chars/token). */
function estimateTokens(message: vscode.LanguageModelChatMessage): number {
  let chars = 0;
  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) chars += part.value.length;
    else chars += JSON.stringify(part).length;
  }
  return Math.ceil(chars / 3.5);
}

export interface ChatRunArgs {
  session: Session;
  text: string;
  modelId?: string;
  attachments?: ChatAttachment[];
  requestId: string;
  sse: SseStream;
}

function waitForModelChange(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      listener.dispose();
      resolve();
    }, timeoutMs);
    const listener = vscode.lm.onDidChangeChatModels(() => {
      clearTimeout(timer);
      listener.dispose();
      resolve();
    });
  });
}

const NO_MODELS: readonly vscode.LanguageModelChat[] = [];

async function resolveModel(preferredId?: string): Promise<vscode.LanguageModelChat | undefined> {
  let models = await withTimeout(
    vscode.lm.selectChatModels({ vendor: 'copilot' }),
    10000,
    NO_MODELS,
  );
  if (!models.length) {
    // logo após o startup a lista pode estar vazia até o Copilot Chat ativar
    await waitForModelChange(3000);
    models = await withTimeout(
      vscode.lm.selectChatModels({ vendor: 'copilot' }),
      10000,
      NO_MODELS,
    );
  }
  if (!models.length) return undefined;
  return models.find((m) => m.id === preferredId) ?? models[0];
}

function mapError(err: unknown): { code: ChatErrorCode; message: string } {
  if (err instanceof vscode.LanguageModelError) {
    switch (err.code) {
      case 'NoPermissions':
        return {
          code: 'no_permissions',
          message:
            'O VS Code ainda não autorizou o portal a usar o Copilot. Confirme a permissão na janela do VS Code.',
        };
      case 'Blocked':
        return {
          code: 'quota',
          message: 'Requisição bloqueada pelo Copilot (cota excedida ou conteúdo filtrado).',
        };
      case 'NotFound':
        return { code: 'model_not_found', message: 'Modelo não encontrado no Copilot.' };
    }
  }
  return { code: 'internal', message: err instanceof Error ? err.message : String(err) };
}

function clamp(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… (resultado truncado)`;
}

export async function runChat(args: ChatRunArgs): Promise<void> {
  const { session, sse, requestId } = args;

  // 1. persiste a mensagem do usuário imediatamente
  const userParts: MessagePart[] = [];
  if (args.text) userParts.push({ type: 'text', text: args.text });
  for (const att of args.attachments ?? []) {
    userParts.push({ type: 'attachment', name: att.name, content: att.content });
  }
  const userMessage: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    parts: userParts,
    createdAt: new Date().toISOString(),
  };
  session.messages.push(userMessage);
  if (session.title === 'Nova conversa' && session.messages.length === 1) {
    const firstLine = args.text.split('\n')[0] || args.attachments?.[0]?.name || 'Nova conversa';
    session.title = firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
  }
  saveSession(session);

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

  const cts = registerRequest(requestId);
  sse.onClose(() => cts.cancel());

  // snapshot dos AI credits antes da 1ª requisição (corre em paralelo: o fetch
  // resolve muito antes de a primeira rodada do modelo ser cobrada)
  const creditsBefore = creditsRemaining();

  const assistantParts: MessagePart[] = [];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, requests: 0 };
  let finishReason: ChatFinishReason = 'stop';
  let chatError: { code: ChatErrorCode; message: string } | undefined;

  try {
    const model = await resolveModel(args.modelId ?? session.modelId ?? agent?.defaultModelId);
    if (!model) {
      throw vscode.LanguageModelError.NotFound(
        'Nenhum modelo do Copilot disponível. Verifique se o GitHub Copilot Chat está instalado e logado.',
      );
    }

    const { defs: toolDefs, droppedServers } = getEnabledToolDefs(session, agent);
    if (droppedServers.length) {
      sse.send('notice', {
        message:
          `A API do Copilot aceita no máximo 128 ferramentas por conversa — ` +
          `os MCPs ${droppedServers.join(', ')} ficaram de fora desta resposta. ` +
          `Desligue outros servidores MCP na página de MCPs para usá-los.`,
      });
    }

    // bases grandes: com as ferramentas de busca disponíveis, o preâmbulo
    // recebe só o índice e o modelo recupera o conteúdo sob demanda
    const knowledgeCtx = collectKnowledgeContext(
      session.projectId,
      agent?.knowledgeBaseIds,
      toolDefs.some((t) => t.name === 'portal_search_knowledge'),
    );

    const messages = buildMessages({
      session,
      project,
      agent,
      instructionSkills,
      commandSkills,
      canLoadSkills: toolDefs.some((t) => t.name === 'portal_load_skill'),
      knowledge: knowledgeCtx.snippets,
      knowledgeIndex: knowledgeCtx.index,
      contextFiles: readContextFiles(session, workRoot),
      envNote: describeEnvForPrompt(),
      racfUser: getConfig().racfUser,
      maxInputTokens: model.maxInputTokens,
    });

    // tokens por mensagem já contada (o array messages só recebe appends)
    const messageTokens: number[] = [];
    const countNewMessages = async (): Promise<number> => {
      for (let i = messageTokens.length; i < messages.length; i++) {
        try {
          messageTokens.push(await model.countTokens(messages[i], cts.token));
        } catch {
          messageTokens.push(estimateTokens(messages[i]));
        }
      }
      return messageTokens.reduce((a, b) => a + b, 0);
    };

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // cada rodada reenvia o histórico inteiro — soma o custo real de entrada
      usage.inputTokens += await countNewMessages();
      usage.requests++;
      const response = await model.sendRequest(
        messages,
        {
          justification: 'AI Product BMAD Chat — chat do analista',
          ...(toolDefs.length
            ? { tools: toolDefs, toolMode: vscode.LanguageModelChatToolMode.Auto }
            : {}),
        },
        cts.token,
      );

      let roundText = '';
      const roundCalls: vscode.LanguageModelToolCallPart[] = [];
      for await (const part of response.stream) {
        if (cts.token.isCancellationRequested) break;
        if (part instanceof vscode.LanguageModelTextPart) {
          roundText += part.value;
          sse.send('text', { delta: part.value });
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          roundCalls.push(part);
          sse.send('tool_call', { callId: part.callId, toolName: part.name, input: part.input });
        }
      }

      if (roundText) assistantParts.push({ type: 'text', text: roundText });
      for (const call of roundCalls) {
        assistantParts.push({
          type: 'tool_call',
          callId: call.callId,
          toolName: call.name,
          input: call.input,
        });
      }

      // saída da rodada: texto + tool calls geradas pelo modelo
      if (roundText) {
        try {
          usage.outputTokens += await model.countTokens(roundText, cts.token);
        } catch {
          usage.outputTokens += Math.ceil(roundText.length / 3.5);
        }
      }
      for (const call of roundCalls) {
        usage.outputTokens += Math.ceil(JSON.stringify(call.input ?? {}).length / 3.5);
      }

      if (cts.token.isCancellationRequested) {
        finishReason = 'cancelled';
        break;
      }
      if (!roundCalls.length) break;
      if (round === MAX_ROUNDS - 1) {
        finishReason = 'max_rounds';
        break;
      }

      // subagentes da rodada disparam TODOS agora, em paralelo (party mode do
      // BMAD: cada persona responde ao mesmo tempo); runSubagent nunca rejeita
      const subagentRuns = new Map<string, Promise<SubagentOutcome>>();
      for (const call of roundCalls) {
        if (call.name !== 'portal_spawn_subagent') continue;
        if (subagentRuns.size >= MAX_SUBAGENTS_PER_ROUND) {
          subagentRuns.set(
            call.callId,
            Promise.resolve({
              ok: false,
              content: `Limite de ${MAX_SUBAGENTS_PER_ROUND} subagentes por rodada atingido — divida em rodadas.`,
              usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
            }),
          );
          continue;
        }
        subagentRuns.set(
          call.callId,
          runSubagent({
            input: call.input,
            parentModel: model,
            token: cts.token,
            workRoot,
            projectId: project?.id ?? '',
            agentBaseIds: agent?.knowledgeBaseIds ?? [],
          }),
        );
      }

      // executa as demais tools sequencialmente e devolve os resultados ao modelo
      const resultParts: vscode.LanguageModelToolResultPart[] = [];
      for (const call of roundCalls) {
        if (cts.token.isCancellationRequested) {
          finishReason = 'cancelled';
          break;
        }
        const started = Date.now();
        let ok = true;
        let content: string;
        try {
          if (call.name === 'portal_run_command') {
            // comando de shell: pausa o stream até o usuário aprovar na UI
            const input = (call.input ?? {}) as { command?: unknown; timeoutSeconds?: unknown };
            const command = typeof input.command === 'string' ? input.command.trim() : '';
            if (!command) throw new Error('Campo "command" é obrigatório');
            sse.send('approval_request', {
              callId: call.callId,
              toolName: call.name,
              command,
              cwd: workRoot,
            });
            const verdict = await waitForApproval(requestId, call.callId, cts.token);
            if (verdict === 'approved') {
              ensureDir(workRoot);
              const outcome = await executeCommand(
                command,
                workRoot,
                cts.token,
                typeof input.timeoutSeconds === 'number' ? input.timeoutSeconds : undefined,
              );
              ok = outcome.ok;
              content = outcome.content;
            } else {
              ok = false;
              content =
                verdict === 'timeout'
                  ? 'A aprovação expirou sem resposta do usuário. Não tente o comando de novo; siga pela alternativa manual quando existir.'
                  : 'O usuário negou a execução deste comando. Não insista; siga pela alternativa manual quando existir.';
            }
          } else if (call.name === 'portal_spawn_subagent') {
            const outcome = await subagentRuns.get(call.callId)!;
            ok = outcome.ok;
            content = outcome.content;
            // o custo do subagente entra na conta da resposta
            usage.inputTokens += outcome.usage.inputTokens;
            usage.outputTokens += outcome.usage.outputTokens;
            usage.requests += outcome.usage.requests;
          } else if (call.name === 'portal_ask_user') {
            const input = (call.input ?? {}) as { question?: unknown; options?: unknown };
            const question = typeof input.question === 'string' ? input.question.trim() : '';
            if (!question) throw new Error('Campo "question" é obrigatório');
            const options = (Array.isArray(input.options) ? input.options : [])
              .filter((o): o is string => typeof o === 'string' && !!o.trim())
              .map((o) => o.trim())
              .slice(0, 6);
            sse.send('user_question', { callId: call.callId, toolName: call.name, question, options });
            const outcome = await waitForAnswer(requestId, call.callId, cts.token);
            if (outcome.kind === 'answered') {
              content = `Resposta do usuário: ${outcome.answer}`;
            } else {
              ok = false;
              content =
                outcome.kind === 'timeout'
                  ? 'A pergunta expirou sem resposta do usuário. Prossiga com a opção mais razoável e deixe explícito o que assumiu.'
                  : 'A pergunta foi cancelada.';
            }
          } else if (isBuiltinTool(call.name)) {
            if (!project && PROJECT_ONLY_TOOL_NAMES.includes(call.name)) {
              throw new Error('Esta ferramenta exige uma conversa de projeto');
            }
            if (WORKSPACE_FS_TOOLS.includes(call.name)) ensureDir(workRoot);
            const outcome = await dispatchBuiltinTool(
              call.name,
              call.input,
              workRoot,
              project?.id ?? '',
              agent?.knowledgeBaseIds ?? [],
            );
            ok = outcome.ok;
            content = outcome.content;
          } else {
            content = await callMcpTool(call.name, call.input as object);
          }
        } catch (err) {
          if (cts.token.isCancellationRequested) {
            finishReason = 'cancelled';
            break;
          }
          ok = false;
          content = err instanceof Error ? err.message : String(err);
        }
        content = clamp(content || '(sem saída)', TOOL_RESULT_CLAMP);
        const durationMs = Date.now() - started;
        sse.send('tool_result', { callId: call.callId, toolName: call.name, ok, content, durationMs });
        assistantParts.push({
          type: 'tool_result',
          callId: call.callId,
          toolName: call.name,
          ok,
          content,
          durationMs,
        });
        resultParts.push(
          new vscode.LanguageModelToolResultPart(call.callId, [
            new vscode.LanguageModelTextPart(content),
          ]),
        );
      }
      if (finishReason === 'cancelled') break;

      const assistantApiParts: Array<
        vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart
      > = [];
      if (roundText) assistantApiParts.push(new vscode.LanguageModelTextPart(roundText));
      assistantApiParts.push(...roundCalls);
      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantApiParts));
      messages.push(vscode.LanguageModelChatMessage.User(resultParts));
    }
  } catch (err) {
    if (cts.token.isCancellationRequested) {
      finishReason = 'cancelled';
    } else {
      finishReason = 'error';
      chatError = mapError(err);
      sse.send('error', chatError);
    }
  } finally {
    releaseRequest(requestId);
  }

  // 2. persiste a resposta (mesmo parcial/com erro)
  let savedAssistant: ChatMessage | undefined;
  if (assistantParts.length || chatError) {
    savedAssistant = {
      id: assistantMessageId,
      role: 'assistant',
      parts: assistantParts,
      modelId: args.modelId ?? session.modelId,
      ...(usage.requests ? { usage } : {}),
      createdAt: new Date().toISOString(),
      ...(chatError ? { error: chatError } : {}),
    };
    session.messages.push(savedAssistant);
  }
  saveSession(session);

  sse.send('done', {
    finishReason,
    updatedSession: toSummary(session),
    ...(usage.requests ? { usage } : {}),
  });

  // custo real da resposta: delta dos credits da licença entre início e fim.
  // A contabilização do GitHub leva alguns segundos, então o done sai antes e
  // o stream fica aberto só para o usage_update. Sem delta dentro da janela
  // (ilimitado, modelo incluído ou cobrança < 0,1), segue sem credits.
  if (usage.requests) {
    const before = await creditsBefore;
    if (before !== undefined) {
      for (const waitMs of [0, 1500, 2500, 4000]) {
        if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
        const after = await creditsRemaining();
        if (after !== undefined && after < before) {
          usage.credits = Math.round((before - after) * 1000) / 1000;
          break;
        }
      }
      if (usage.credits !== undefined) {
        if (savedAssistant) {
          savedAssistant.usage = usage;
          saveSession(session);
        }
        sse.send('usage_update', { messageId: assistantMessageId, usage });
      }
    }
  }
  sse.close();
}

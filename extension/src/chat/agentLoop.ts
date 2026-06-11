import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type {
  AgentPreset,
  ChatErrorCode,
  ChatFinishReason,
  ChatMessage,
  MessagePart,
  Project,
  Session,
  SkillWithContent,
} from '@aiportal/shared';
import type { SseStream } from '../server/sse';
import { getAgent } from '../storage/agentStore';
import { getProject, projectDir } from '../storage/projectStore';
import { saveSession, toSummary } from '../storage/sessionStore';
import { getSkill } from '../storage/skillStore';
import { dispatchBuiltinTool, isBuiltinTool } from '../tools/builtinTools';
import { callMcpTool } from '../tools/mcpManager';
import { getEnabledToolDefs } from '../tools/toolRegistry';
import { collectKnowledge } from '../storage/knowledgeStore';
import { buildMessages } from './messageBuilder';
import { registerRequest, releaseRequest } from './activeRequests';
import { withTimeout } from '../util';

const MAX_ROUNDS = 20;
const TOOL_RESULT_CLAMP = 64 * 1024;

export interface ChatRunArgs {
  session: Session;
  text: string;
  modelId?: string;
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
  const userMessage: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text: args.text }],
    createdAt: new Date().toISOString(),
  };
  session.messages.push(userMessage);
  if (session.title === 'Nova conversa' && session.messages.length === 1) {
    const firstLine = args.text.split('\n')[0];
    session.title = firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
  }
  saveSession(session);

  const assistantMessageId = crypto.randomUUID();
  sse.send('meta', { requestId, userMessageId: userMessage.id, assistantMessageId });

  const agent: AgentPreset | undefined = session.agentId ? getAgent(session.agentId) : undefined;
  const project: Project | undefined = session.projectId
    ? getProject(session.projectId)
    : undefined;
  const skills = session.activeSkillIds
    .map((id) => getSkill(id))
    .filter((s): s is SkillWithContent => !!s);
  const commandSkills = skills.filter((s) => s.kind === 'command');
  const instructionSkills = skills.filter((s) => s.kind === 'instruction');

  const cts = registerRequest(requestId);
  sse.onClose(() => cts.cancel());

  const assistantParts: MessagePart[] = [];
  let finishReason: ChatFinishReason = 'stop';
  let chatError: { code: ChatErrorCode; message: string } | undefined;

  try {
    const model = await resolveModel(args.modelId ?? session.modelId ?? agent?.defaultModelId);
    if (!model) {
      throw vscode.LanguageModelError.NotFound(
        'Nenhum modelo do Copilot disponível. Verifique se o GitHub Copilot Chat está instalado e logado.',
      );
    }

    const toolDefs = getEnabledToolDefs(session, agent);

    const messages = buildMessages({
      session,
      project,
      agent,
      instructionSkills,
      commandSkills,
      knowledge: collectKnowledge(session.projectId),
      maxInputTokens: model.maxInputTokens,
    });

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await model.sendRequest(
        messages,
        {
          justification: 'AI Chat Portal — chat do analista',
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

      if (cts.token.isCancellationRequested) {
        finishReason = 'cancelled';
        break;
      }
      if (!roundCalls.length) break;
      if (round === MAX_ROUNDS - 1) {
        finishReason = 'max_rounds';
        break;
      }

      // executa as tools sequencialmente e devolve os resultados ao modelo
      const resultParts: vscode.LanguageModelToolResultPart[] = [];
      for (const call of roundCalls) {
        const started = Date.now();
        let ok = true;
        let content: string;
        try {
          if (isBuiltinTool(call.name)) {
            if (!project) throw new Error('Ferramentas de arquivo exigem um projeto');
            const outcome = dispatchBuiltinTool(call.name, call.input, projectDir(project));
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
  if (assistantParts.length || chatError) {
    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      parts: assistantParts,
      modelId: args.modelId ?? session.modelId,
      createdAt: new Date().toISOString(),
      ...(chatError ? { error: chatError } : {}),
    };
    session.messages.push(assistantMessage);
  }
  saveSession(session);

  sse.send('done', { finishReason, updatedSession: toSummary(session) });
  sse.close();
}

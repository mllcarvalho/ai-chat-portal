import * as vscode from 'vscode';
import { listAgents } from '../storage/agentStore';
import { isBmadInstalled } from '../storage/paths';
import {
  MODEL_RETRIES,
  isTransientModelError,
  raceCancellation,
  retryDelayMs,
  sleep,
} from './retry';
import {
  BMAD_TOOL_NAMES,
  BUILTIN_TOOLS,
  SUBAGENT_TOOL_NAMES,
  dispatchBuiltinTool,
  readFileClamped,
  resolveInBmad,
  resolveInProject,
} from '../tools/builtinTools';

/**
 * Subagente (portal_spawn_subagent): uma conversa independente com o modelo,
 * com persona e tarefa próprias, disparada de dentro do agentLoop. Não fala
 * com o usuário nem escreve arquivos — recebe só ferramentas de leitura — e a
 * resposta final volta ao agente principal como resultado da ferramenta.
 * Sempre RESOLVE (nunca rejeita): erros viram { ok: false }, para o agentLoop
 * poder disparar vários em paralelo sem risco de rejeição não tratada.
 */

const SUBAGENT_MAX_ROUNDS = 8;
const SUBAGENT_TOOL_RESULT_CLAMP = 32 * 1024;
/** Teto de parede por tool: um builtin travado não pode congelar a rodada do agente principal. */
const SUBAGENT_TOOL_TIMEOUT_MS = 120_000;

export interface SubagentUsage {
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export interface SubagentOutcome {
  ok: boolean;
  content: string;
  usage: SubagentUsage;
}

interface SubagentInput {
  task: string;
  label?: string;
  personaPath?: string;
  personaAgent?: string;
  systemPrompt?: string;
  modelId?: string;
}

function parseInput(raw: unknown): SubagentInput {
  const args = (raw ?? {}) as Record<string, unknown>;
  const task = typeof args.task === 'string' ? args.task.trim() : '';
  if (!task) throw new Error('Campo "task" é obrigatório');
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return {
    task,
    label: str(args.label),
    personaPath: str(args.personaPath),
    personaAgent: str(args.personaAgent),
    systemPrompt: str(args.systemPrompt),
    modelId: str(args.modelId),
  };
}

/** Instruções da persona: texto direto, agente do portal ou arquivo (BMAD/workspace). */
function resolvePersona(input: SubagentInput, workRoot: string): string | undefined {
  if (input.systemPrompt) return input.systemPrompt;
  if (input.personaAgent) {
    const wanted = input.personaAgent.toLowerCase();
    const agent = listAgents().find(
      (a) => a.id === input.personaAgent || a.name.toLowerCase() === wanted,
    );
    if (!agent) {
      const known = listAgents().map((a) => `"${a.name}"`).join(', ');
      throw new Error(
        `Agente "${input.personaAgent}" não encontrado. Agentes do portal: ${known || '(nenhum)'}`,
      );
    }
    return `# Persona: ${agent.name}\n${agent.instructions}`;
  }
  if (input.personaPath) {
    // tenta a instalação BMAD primeiro (personas do party mode moram lá), depois a pasta de trabalho
    try {
      return readFileClamped(resolveInBmad(input.personaPath), input.personaPath);
    } catch {
      return readFileClamped(resolveInProject(workRoot, input.personaPath), input.personaPath);
    }
  }
  return undefined;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

async function countTokensSafe(
  model: vscode.LanguageModelChat,
  text: string,
  token: vscode.CancellationToken,
): Promise<number> {
  try {
    return await model.countTokens(text, token);
  } catch {
    return estimateTokens(text);
  }
}

function clamp(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… (resultado truncado)`;
}

export async function runSubagent(opts: {
  input: unknown;
  parentModel: vscode.LanguageModelChat;
  token: vscode.CancellationToken;
  workRoot: string;
  projectId: string;
  agentBaseIds: string[];
}): Promise<SubagentOutcome> {
  const usage: SubagentUsage = { inputTokens: 0, outputTokens: 0, requests: 0 };
  try {
    const input = parseInput(opts.input);
    const persona = resolvePersona(input, opts.workRoot);

    let model = opts.parentModel;
    if (input.modelId && input.modelId !== model.id) {
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      model = models.find((m) => m.id === input.modelId) ?? opts.parentModel;
    }

    const preamble = [
      'Você é um subagente do BMAD Product Studio: uma instância independente disparada pelo ' +
        'agente principal da conversa para cumprir a tarefa abaixo.',
      'Você NÃO fala com o usuário — sua resposta final é devolvida ao agente principal como ' +
        'resultado de ferramenta. Não faça perguntas; se faltar informação, diga o que assumiu.',
      'Responda em português brasileiro, a menos que a persona determine outra coisa. Seja direto: ' +
        'entregue o resultado pedido, sem preâmbulos.',
      'Se precisar se dirigir ao usuário final, use SOMENTE o nome que a tarefa informar; se a ' +
        'tarefa não der nome, não use nome nenhum — nunca invente nome, apelido ou cargo.',
      ...(persona
        ? [
            'Assuma integralmente a persona a seguir — voz, papel e regras — enquanto cumpre a tarefa:\n\n' +
              persona,
          ]
        : []),
    ].join('\n\n');

    const messages = [
      vscode.LanguageModelChatMessage.User(`<instruções>\n${preamble}\n</instruções>`),
      vscode.LanguageModelChatMessage.User(input.task),
    ];

    const toolDefs: vscode.LanguageModelChatTool[] = BUILTIN_TOOLS.filter(
      (t) =>
        SUBAGENT_TOOL_NAMES.includes(t.name) &&
        (!BMAD_TOOL_NAMES.includes(t.name) || isBmadInstalled()),
    ).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

    let fullText = '';
    for (let round = 0; round < SUBAGENT_MAX_ROUNDS; round++) {
      if (opts.token.isCancellationRequested) break;
      for (const message of messages) {
        // estimativa local: countTokens em paralelo com o loop principal derruba o custo/latência
        usage.inputTokens += estimateTokens(
          message.content
            .map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : JSON.stringify(p)))
            .join(''),
        );
      }
      let roundText = '';
      let roundCalls: vscode.LanguageModelToolCallPart[] = [];
      // erros transitórios do gateway valem retry aqui também — e como nada
      // deste stream vai à UI, é seguro descartar o parcial e recomeçar
      for (let attempt = 0; ; attempt++) {
        usage.requests++;
        try {
          const response = await model.sendRequest(
            messages,
            {
              justification: 'BMAD Product Studio — subagente',
              ...(toolDefs.length
                ? { tools: toolDefs, toolMode: vscode.LanguageModelChatToolMode.Auto }
                : {}),
            },
            opts.token,
          );
          // iteração manual com corrida de cancelamento: um for await ficaria
          // pendurado junto com o gateway e ignoraria o "Parar" do usuário
          const iterator = response.stream[Symbol.asyncIterator]();
          while (true) {
            const next = await raceCancellation(iterator.next(), opts.token);
            if (next.done || opts.token.isCancellationRequested) break;
            const part = next.value;
            if (part instanceof vscode.LanguageModelTextPart) roundText += part.value;
            else if (part instanceof vscode.LanguageModelToolCallPart) roundCalls.push(part);
          }
          break;
        } catch (err) {
          const canRetry =
            attempt < MODEL_RETRIES &&
            !opts.token.isCancellationRequested &&
            isTransientModelError(err);
          if (!canRetry) throw err;
          roundText = '';
          roundCalls = [];
          await sleep(retryDelayMs(err, attempt));
        }
      }
      if (roundText) {
        fullText += (fullText ? '\n\n' : '') + roundText;
        usage.outputTokens += await countTokensSafe(model, roundText, opts.token);
      }
      if (!roundCalls.length || opts.token.isCancellationRequested) break;

      const resultParts: vscode.LanguageModelToolResultPart[] = [];
      for (const call of roundCalls) {
        usage.outputTokens += estimateTokens(JSON.stringify(call.input ?? {}));
        let content: string;
        try {
          // cancelamento do usuário e timeout valem também dentro do subagente
          const outcome = await raceCancellation(
            dispatchBuiltinTool(
              call.name,
              call.input,
              opts.workRoot,
              opts.projectId,
              opts.agentBaseIds,
            ),
            opts.token,
            SUBAGENT_TOOL_TIMEOUT_MS,
          );
          content = outcome.content;
        } catch (err) {
          content = `Erro na ferramenta: ${err instanceof Error ? err.message : String(err)}`;
        }
        resultParts.push(
          new vscode.LanguageModelToolResultPart(call.callId, [
            new vscode.LanguageModelTextPart(clamp(content || '(sem saída)', SUBAGENT_TOOL_RESULT_CLAMP)),
          ]),
        );
      }
      const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> =
        [];
      if (roundText) assistantParts.push(new vscode.LanguageModelTextPart(roundText));
      assistantParts.push(...roundCalls);
      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
      messages.push(vscode.LanguageModelChatMessage.User(resultParts));
    }

    if (opts.token.isCancellationRequested) {
      return { ok: false, content: fullText || 'Subagente cancelado.', usage };
    }
    return {
      ok: true,
      content: fullText || '(o subagente terminou sem produzir texto)',
      usage,
    };
  } catch (err) {
    return {
      ok: false,
      content: `Subagente falhou: ${err instanceof Error ? err.message : String(err)}`,
      usage,
    };
  }
}

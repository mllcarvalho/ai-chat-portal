import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ChatErrorCode,
  ChatFinishReason,
  ChatMessage,
  ModelInfo,
  ProviderInfo,
  Session,
} from '@aiportal/shared';
import { getConfig } from '../../storage/configStore';
import { PROJECT_META_DIR, ensureDir } from '../../storage/paths';
import { updateSession } from '../../storage/sessionStore';
import {
  PROJECT_ONLY_TOOL_NAMES,
  dispatchBuiltinTool,
  isBuiltinTool,
  resolveInProject,
} from '../../tools/builtinTools';
import { describeEnvForPrompt } from '../../tools/envCheck';
import { callMcpTool } from '../../tools/mcpManager';
import { executeCommand, startBackgroundCommand } from '../../tools/runCommand';
import { getEnabledToolDefs } from '../../tools/toolRegistry';
import { collectKnowledgeContext } from '../../storage/knowledgeStore';
import { buildMessages, type ContextFile } from '../messageBuilder';
import { waitForApproval } from '../approvals';
import { waitForAnswer } from '../questions';
import {
  MODEL_RETRIES,
  ModelIdleTimeoutError,
  isRateLimitError,
  isTokenExpiredError,
  isTransientModelError,
  raceCancellation,
  retryDelayMs,
  sleep,
} from '../retry';
import { runSubagent, type SubagentOutcome } from '../subagent';
import {
  creditsRemaining,
  getModelBilling,
  type ModelBilling,
} from '../../server/routes/copilot';
import { withTimeout } from '../../util';
import { canSendRequest } from '../../lmAccess';
import type { ChatProvider, TurnContext, TurnResult } from './types';

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

/** Limites da expansão de uma PASTA fixada no contexto (caminho com "/" no fim). */
const CONTEXT_DIR_MAX_FILES = 20;
const CONTEXT_DIR_MAX_BYTES = 256 * 1024;
const CONTEXT_DIR_MAX_DEPTH = 8;

/** Arquivos binários costumam ter NUL nos primeiros bytes. */
function looksBinary(content: string): boolean {
  return content.slice(0, 4096).includes('\0');
}

/** Lista recursiva dos arquivos de uma pasta fixada (mesmo filtro da árvore da UI). */
function listDirFiles(dir: string, relBase: string, depth: number, out: string[]): void {
  if (depth > CONTEXT_DIR_MAX_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === PROJECT_META_DIR || entry.name === 'node_modules') continue;
    const rel = `${relBase}/${entry.name}`;
    const full = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      // pasta referenciada (ou symlink dentro dela): decide pelo alvo
      try {
        const stat = fs.statSync(full);
        isDir = stat.isDirectory();
        isFile = stat.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) listDirFiles(full, rel, depth + 1, out);
    else if (isFile) out.push(rel);
  }
}

/**
 * Expande uma pasta fixada nos seus arquivos de texto, respeitando tetos de
 * quantidade e de bytes. O que ficar de fora vira uma nota para o modelo
 * buscar com portal_read_file quando precisar.
 */
function readContextDir(relDir: string, workRoot: string): ContextFile[] {
  const paths: string[] = [];
  listDirFiles(path.join(workRoot, relDir), relDir, 0, paths);
  const result: ContextFile[] = [];
  const leftOut: string[] = [];
  let budget = CONTEXT_DIR_MAX_BYTES;
  for (const rel of paths) {
    if (result.length >= CONTEXT_DIR_MAX_FILES || budget <= 0) {
      leftOut.push(rel);
      continue;
    }
    try {
      const content = fs.readFileSync(path.join(workRoot, rel), 'utf8');
      if (looksBinary(content)) continue; // planilha/imagem etc. — sem valor como texto
      const clamped = clamp(content, Math.min(CONTEXT_FILE_CLAMP, budget));
      budget -= clamped.length;
      result.push({ path: rel, content: clamped });
    } catch {
      // arquivo sumiu no meio do caminho — segue sem ele
    }
  }
  if (leftOut.length) {
    result.push({
      path: `${relDir}/ (aviso do portal)`,
      content:
        `A pasta "${relDir}/" está fixada no contexto, mas passa do limite de injeção ` +
        `(${CONTEXT_DIR_MAX_FILES} arquivos / ${CONTEXT_DIR_MAX_BYTES / 1024} KB). ` +
        `Estes arquivos NÃO foram carregados — leia com portal_read_file quando precisar:\n` +
        leftOut.map((p) => `- ${p}`).join('\n'),
    });
  }
  return result;
}

/** Lê os arquivos (e pastas, caminhos com "/" no fim) fixados no contexto da
    sessão; ignora os que sumiram do disco e deduplica pins sobrepostos. */
function readContextFiles(session: Session, workRoot: string): ContextFile[] {
  if (!session.contextFiles?.length) return [];
  const result: ContextFile[] = [];
  const seen = new Set<string>();
  const push = (file: ContextFile) => {
    if (seen.has(file.path)) return;
    seen.add(file.path);
    result.push(file);
  };
  for (const rel of session.contextFiles) {
    try {
      const target = resolveInProject(workRoot, rel);
      if (rel.endsWith('/') || fs.statSync(target).isDirectory()) {
        readContextDir(rel.replace(/\/+$/, ''), workRoot).forEach(push);
      } else {
        const content = fs.readFileSync(target, 'utf8');
        push({ path: rel, content: clamp(content, CONTEXT_FILE_CLAMP) });
      }
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
        // preserva a mensagem original quando ela é acionável (ex.: "instale o Copilot Chat")
        return { code: 'model_not_found', message: err.message || 'Modelo não encontrado no Copilot.' };
    }
  }
  if (isRateLimitError(err)) {
    return {
      code: 'quota',
      message:
        'O Copilot limitou temporariamente as requisições (rate limit). Aguarde alguns segundos e envie de novo.',
    };
  }
  if (isTokenExpiredError(err)) {
    return {
      code: 'internal',
      message:
        'A sessão do Copilot expirou e a renovação automática ainda não completou. Aguarde uns ' +
        '30 segundos e clique em "tentar novamente" — NA MESMA conversa, não precisa abrir outra. ' +
        'Se persistir por minutos, confira o login do GitHub no VS Code e a rede/VPN (a renovação passa por api.github.com).',
    };
  }
  return { code: 'internal', message: err instanceof Error ? err.message : String(err) };
}

function clamp(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… (resultado truncado)`;
}

/** Teto de parede para builtins (leituras de FS/knowledge não têm timeout próprio). */
const BUILTIN_TOOL_TIMEOUT_MS = 120_000;

/**
 * O gateway do Copilot pode pendurar sem erro e sem tokens; como o heartbeat
 * mantém o SSE "vivo", sem este teto de progresso a resposta ficaria em
 * "digitando" para sempre. Vale entre um evento e o próximo, não para a
 * resposta inteira. IMPORTANTE: um tool call chega INTEIRO no fim da geração
 * — modelo escrevendo um portal_write_file com um HTML grande fica MINUTOS
 * sem emitir parte nenhuma, saudável; 120s matava essas gerações (e o retry
 * recomeçava a mesma geração condenada, queimando créditos).
 */
const MODEL_IDLE_TIMEOUT_MS = 300_000;

/** Depois deste silêncio, avisa a UI que a demora é esperada (geração longa). */
const MODEL_SLOW_NOTICE_MS = 60_000;

function withIdleTimeout<T>(promise: PromiseLike<T>, onSlow?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let slowTimer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      if (onSlow) slowTimer = setTimeout(onSlow, MODEL_SLOW_NOTICE_MS);
      timer = setTimeout(() => reject(new ModelIdleTimeoutError(MODEL_IDLE_TIMEOUT_MS)), MODEL_IDLE_TIMEOUT_MS);
    }),
  ]).finally(() => {
    clearTimeout(timer);
    clearTimeout(slowTimer);
  }) as Promise<T>;
}

/**
 * Turno do Copilot: o portal é dono do loop. Monta o prompt (histórico +
 * skills + base de conhecimento + arquivos fixados), chama o modelo via
 * vscode.lm, executa as ferramentas que ele pedir e repete até o modelo
 * parar de pedir ferramentas.
 */
async function runTurn(ctx: TurnContext): Promise<TurnResult> {
  const {
    session,
    sse,
    requestId,
    assistantMessageId,
    agent,
    project,
    workRoot,
    instructionSkills,
    commandSkills,
    token,
    parts: assistantParts,
    usage,
  } = ctx;

  // snapshot dos AI credits antes da 1ª requisição (corre em paralelo: o fetch
  // resolve muito antes de a primeira rodada do modelo ser cobrada)
  const creditsBefore = creditsRemaining();

  let finishReason: ChatFinishReason = 'stop';
  /** Modelo que de fato respondeu — persistido na mensagem (fallback muda o pedido). */
  let respondedModelId: string | undefined;
  /** Fronteira da poda desta resposta — dispara o resumo em background no fim. */
  let prunedForSummary = 0;
  let modelForSummary: vscode.LanguageModelChat | undefined;

  const preferredModelId = session.modelId ?? agent?.defaultModelId;
  const model = await resolveModel(preferredModelId);
  if (!model) {
    throw vscode.LanguageModelError.NotFound(
      'Nenhum modelo do Copilot disponível. Verifique se o GitHub Copilot Chat está instalado e logado.',
    );
  }
  respondedModelId = model.id;
  if (preferredModelId && model.id !== preferredModelId) {
    sse.send('notice', {
      message: `O modelo "${preferredModelId}" não está disponível — respondendo com ${model.name}.`,
    });
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

  const { messages, prunedCount, summarized } = buildMessages({
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
  prunedForSummary = prunedCount;
  modelForSummary = model;
  if (prunedCount > 0) {
    sse.send('notice', {
      message: summarized
        ? `A conversa ficou longa: as ${prunedCount} mensagens mais antigas foram substituídas ` +
          `por um resumo automático no contexto do modelo.`
        : `A conversa ficou longa: as ${prunedCount} mensagens mais antigas saíram do contexto ` +
          `do modelo nesta resposta. Se algo importante ficou para trás, repita a informação.`,
    });
  }

  // tokens por mensagem já contada (o array messages só recebe appends)
  const messageTokens: number[] = [];
  const countNewMessages = async (): Promise<number> => {
    for (let i = messageTokens.length; i < messages.length; i++) {
      try {
        messageTokens.push(await model.countTokens(messages[i], token));
      } catch {
        messageTokens.push(estimateTokens(messages[i]));
      }
    }
    return messageTokens.reduce((a, b) => a + b, 0);
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // cada rodada reenvia o histórico inteiro — soma o custo real de entrada.
    // A contagem corre em paralelo com a request (só alimenta o usage): em
    // conversa longa, countTokens serial atrasava o primeiro token.
    const inputTokensCount = countNewMessages();

    let roundText = '';
    const roundCalls: vscode.LanguageModelToolCallPart[] = [];
    // um tool call grande (ex.: gravar um HTML inteiro) chega de uma vez só
    // no fim — avisa a UI UMA vez por rodada que o silêncio é esperado
    let slowNoticeSent = false;
    const notifySlow = (): void => {
      if (slowNoticeSent) return;
      slowNoticeSent = true;
      sse.send('notice', {
        message:
          'O modelo está gerando uma resposta longa (ex.: um arquivo inteiro) — isso pode levar alguns minutos, siga aguardando…',
      });
    };
    // 502/503 transitórios do gateway do Copilot: retenta — mas só enquanto
    // nada foi transmitido à UI nesta rodada (retry após emitir duplicaria)
    for (let attempt = 0; ; attempt++) {
      usage.requests++;
      try {
        // raceCancellation: o "Parar" precisa valer NA HORA mesmo com o
        // gateway pendurado — sem a corrida, o cancel só era percebido
        // quando o stream entregasse a próxima parte (ou no idle timeout),
        // e a conversa ficava "em andamento" por minutos
        const response = await raceCancellation(
          withIdleTimeout(
            model.sendRequest(
              messages,
              {
                justification: 'BMAD Product Studio — chat do analista',
                ...(toolDefs.length
                  ? { tools: toolDefs, toolMode: vscode.LanguageModelChatToolMode.Auto }
                  : {}),
              },
              token,
            ),
          ),
          token,
        );
        // iteração manual: cada avanço do stream tem teto de progresso —
        // um for await penduraria junto com o gateway
        const iterator = response.stream[Symbol.asyncIterator]();
        while (true) {
          const next = await raceCancellation(
            withIdleTimeout(iterator.next(), notifySlow),
            token,
          );
          if (next.done) break;
          if (token.isCancellationRequested) break;
          const part = next.value;
          if (part instanceof vscode.LanguageModelTextPart) {
            roundText += part.value;
            sse.send('text', { delta: part.value });
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            roundCalls.push(part);
            sse.send('tool_call', { callId: part.callId, toolName: part.name, input: part.input });
          }
        }
        break;
      } catch (err) {
        const canRetry =
          !roundText &&
          !roundCalls.length &&
          attempt < MODEL_RETRIES &&
          !token.isCancellationRequested &&
          isTransientModelError(err);
        if (!canRetry) {
          // o erro veio depois de já ter transmitido texto/calls à UI:
          // preserva o parcial no histórico antes de propagar — sem isso
          // o trecho aparecia ao vivo mas sumia no reload da conversa
          if (roundText) assistantParts.push({ type: 'text', text: roundText });
          for (const call of roundCalls) {
            assistantParts.push({
              type: 'tool_call',
              callId: call.callId,
              toolName: call.name,
              input: call.input,
            });
          }
          throw err;
        }
        sse.send('notice', {
          message: isTokenExpiredError(err)
            ? `A sessão do Copilot expirou — aguardando a renovação automática e tentando de novo (${attempt + 2}ª de ${MODEL_RETRIES + 1} tentativas)…`
            : `O Copilot respondeu um erro transitório — tentando de novo (${attempt + 2}ª de ${MODEL_RETRIES + 1} tentativas)…`,
        });
        await sleep(retryDelayMs(err, attempt));
      }
    }
    usage.inputTokens += await inputTokensCount;

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
        usage.outputTokens += await model.countTokens(roundText, token);
      } catch {
        usage.outputTokens += Math.ceil(roundText.length / 3.5);
      }
    }
    for (const call of roundCalls) {
      usage.outputTokens += Math.ceil(JSON.stringify(call.input ?? {}).length / 3.5);
    }

    if (token.isCancellationRequested) {
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
          token: token,
          workRoot,
          projectId: project?.id ?? '',
          agentBaseIds: agent?.knowledgeBaseIds ?? [],
        }),
      );
    }

    // executa as demais tools sequencialmente e devolve os resultados ao modelo
    const resultParts: vscode.LanguageModelToolResultPart[] = [];
    for (const call of roundCalls) {
      if (token.isCancellationRequested) {
        finishReason = 'cancelled';
        break;
      }
      const started = Date.now();
      let ok = true;
      let content: string;
      try {
        if (call.name === 'portal_run_command') {
          // comando de shell: pausa o stream até o usuário aprovar na UI
          const input = (call.input ?? {}) as {
            command?: unknown;
            timeoutSeconds?: unknown;
            background?: unknown;
          };
          const command = typeof input.command === 'string' ? input.command.trim() : '';
          if (!command) throw new Error('Campo "command" é obrigatório');
          // executável na allowlist ("sempre permitir"): pula a aprovação
          const bin = command.split(/\s+/)[0] ?? '';
          let verdict: Awaited<ReturnType<typeof waitForApproval>>;
          if (bin && (getConfig().commandAllowlist ?? []).includes(bin)) {
            verdict = 'approved';
          } else {
            sse.send('approval_request', {
              callId: call.callId,
              toolName: call.name,
              command,
              cwd: workRoot,
            });
            verdict = await waitForApproval(requestId, call.callId, token);
          }
          if (verdict === 'approved') {
            ensureDir(workRoot);
            const outcome =
              input.background === true
                ? startBackgroundCommand(command, workRoot)
                : await executeCommand(
                    command,
                    workRoot,
                    token,
                    typeof input.timeoutSeconds === 'number' ? input.timeoutSeconds : undefined,
                    // shell persistente da conversa: cd/env sobrevivem entre comandos
                    session.id,
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
          const outcome = await waitForAnswer(requestId, call.callId, token);
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
          // o stop do usuário não espera a tool: raceCancellation solta o loop na hora
          const outcome = await raceCancellation(
            dispatchBuiltinTool(
              call.name,
              call.input,
              workRoot,
              project?.id ?? '',
              agent?.knowledgeBaseIds ?? [],
            ),
            token,
            BUILTIN_TOOL_TIMEOUT_MS,
          );
          ok = outcome.ok;
          content = outcome.content;
        } else {
          // callMcpTool tem timeout próprio de 5min (via SDK, com reset por progresso); aqui só o cancelamento
          content = await raceCancellation(
            callMcpTool(call.name, call.input as object),
            token,
          );
        }
      } catch (err) {
        if (token.isCancellationRequested) {
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

  // resumo do trecho podado em background (melhor esforço): a PRÓXIMA resposta
  // injeta o resumo no lugar da nota de omissão. Só quando a fronteira da poda
  // avançou — custa 1 requisição ao modelo por atualização.
  // erro aqui vira throw (o shell traduz), então neste ponto o turno é válido
  if (prunedForSummary > 0 && modelForSummary) {
    const pruned = session.messages.slice(0, prunedForSummary);
    const boundary = pruned[pruned.length - 1];
    if (boundary && session.historySummary?.throughMessageId !== boundary.id) {
      void refreshHistorySummary(session.id, pruned, session.historySummary, modelForSummary);
    }
  }

  return {
    finishReason,
    modelId: respondedModelId,
    // custo real da resposta: delta dos credits da licença entre início e fim.
    // A contabilização do GitHub leva alguns segundos, então o done sai antes e
    // o stream fica aberto só para isto. Sem delta dentro da janela (ilimitado,
    // modelo incluído ou cobrança < 0,1), segue sem credits.
    afterDone: async () => {
      if (!usage.requests) return;
      const before = await creditsBefore;
      if (before === undefined) return;
      for (const waitMs of [0, 1500, 2500, 4000]) {
        if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
        const after = await creditsRemaining();
        if (after !== undefined && after < before) {
          usage.credits = Math.round((before - after) * 1000) / 1000;
          break;
        }
      }
      if (usage.credits === undefined) return;
      updateSession(session.id, (s) => {
        const message = s.messages.find((m) => m.id === assistantMessageId);
        if (message) message.usage = usage;
      });
      sse.send('usage_update', { messageId: assistantMessageId, usage });
    },
  };
}

/** Teto do material enviado para resumir (o resumo roda fora da janela da resposta). */
const SUMMARY_SOURCE_CLAMP = 48 * 1024;
const SUMMARY_PART_CLAMP = 2 * 1024;
const SUMMARY_TIMEOUT_MS = 90_000;

/** Digest textual das mensagens podadas — texto integral (clampado) + tools em uma linha. */
function summarySource(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const label = message.role === 'user' ? 'Usuário' : 'Assistente';
    for (const part of message.parts) {
      if (part.type === 'text' && part.text.trim()) {
        lines.push(`${label}: ${clamp(part.text.trim(), SUMMARY_PART_CLAMP)}`);
      } else if (part.type === 'attachment') {
        lines.push(`${label} anexou: ${part.name}`);
      } else if (part.type === 'tool_call') {
        lines.push(`Assistente usou a ferramenta ${part.toolName}.`);
      }
    }
  }
  return clamp(lines.join('\n'), SUMMARY_SOURCE_CLAMP);
}

/**
 * Título curto gerado por modelo (paridade com o Copilot Chat) — substitui a
 * primeira linha truncada. Prefere um modelo incluído na licença (título não
 * deve custar premium request); melhor esforço: falhou, o shell mantém o
 * título derivado da primeira linha.
 */
async function generateTitle(
  ctx: TurnContext,
  assistantText: string,
): Promise<string | undefined> {
  const prompt =
    'Crie um título curto (máximo 6 palavras, em português, sem aspas e sem ponto final) para a ' +
    'conversa abaixo. Responda SÓ o título.\n\n' +
    `Usuário: ${clamp(ctx.text ?? '', 1000)}` +
    (assistantText ? `\nAssistente: ${clamp(assistantText, 500)}` : '');
  const cts = new vscode.CancellationTokenSource();
  const timer = setTimeout(() => cts.cancel(), 20_000);
  try {
    const models = await withTimeout(
      vscode.lm.selectChatModels({ vendor: 'copilot' }),
      3000,
      NO_MODELS,
    );
    const model =
      models.find((m) => /gpt-4\.1|gpt-4o|gpt-5-mini/i.test(m.id)) ??
      (await resolveModel(ctx.session.modelId));
    if (!model) return undefined;
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      { justification: 'BMAD Product Studio — título da conversa' },
      cts.token,
    );
    let title = '';
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) title += part.value;
    }
    title = (title.trim().split('\n')[0] ?? '').replace(/^["“”']+|["“”'.]+$/g, '').trim();
    return title && title.length <= 80 ? title : undefined;
  } finally {
    clearTimeout(timer);
    cts.dispose();
  }
}

async function refreshHistorySummary(
  sessionId: string,
  pruned: ChatMessage[],
  previous: Session['historySummary'],
  model: vscode.LanguageModelChat,
): Promise<void> {
  const boundary = pruned[pruned.length - 1];
  if (!boundary) return;
  const prevIdx = previous ? pruned.findIndex((m) => m.id === previous.throughMessageId) : -1;
  const fresh = prevIdx >= 0 ? pruned.slice(prevIdx + 1) : pruned;
  if (!fresh.length) return;
  const prompt =
    'Você mantém o resumo da parte antiga de uma conversa entre um analista de produto e um ' +
    'assistente de IA. Produza um resumo ÚNICO e atualizado, em português, com até 300 palavras, ' +
    'preservando: decisões tomadas, requisitos e números citados, nomes de arquivos/documentos ' +
    'criados e pendências em aberto. Responda SÓ com o resumo, sem preâmbulo.\n\n' +
    (prevIdx >= 0 && previous
      ? `Resumo anterior (já cobre o início da conversa):\n${previous.summary}\n\nMensagens novas a incorporar:\n`
      : 'Conversa a resumir:\n') +
    summarySource(fresh);
  const cts = new vscode.CancellationTokenSource();
  const timer = setTimeout(() => cts.cancel(), SUMMARY_TIMEOUT_MS);
  try {
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      { justification: 'BMAD Product Studio — resumo do histórico da conversa' },
      cts.token,
    );
    let summary = '';
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) summary += part.value;
    }
    if (summary.trim()) {
      updateSession(sessionId, (s) => {
        s.historySummary = { throughMessageId: boundary.id, summary: summary.trim() };
      });
    }
  } catch {
    // melhor esforço: sem resumo, a próxima resposta usa a nota de omissão
  } finally {
    clearTimeout(timer);
    cts.dispose();
  }
}

/**
 * O que o Copilot entrega: o portal é dono do loop, então todos os recursos
 * do portal valem.
 */
const CAPABILITIES = {
  skills: true,
  knowledge: true,
  mcp: true,
  toolToggles: true,
  agents: true,
  modes: true,
  contextFiles: true,
  cost: true,
} as const;

async function listModels(): Promise<ModelInfo[]> {
  const models = await withTimeout(
    vscode.lm.selectChatModels({ vendor: 'copilot' }),
    10000,
    NO_MODELS,
  );
  // billing é cosmético (credits na UI): qualquer falha só omite os campos
  let billing: Map<string, ModelBilling> | undefined;
  try {
    billing = await getModelBilling();
  } catch (err) {
    console.error(
      '[ai-chat-portal] billing indisponível:',
      err instanceof Error ? err.message : err,
    );
  }
  return models.map((m) => {
    const cost = billing?.get(m.id.toLowerCase()) ?? billing?.get(m.name.toLowerCase());
    return {
      id: m.id,
      name: m.name,
      family: m.family,
      vendor: m.vendor,
      version: m.version,
      maxInputTokens: m.maxInputTokens,
      provider: 'copilot' as const,
      canSend: canSendRequest(m),
      ...(cost?.premium !== undefined ? { premium: cost.premium } : {}),
      ...(cost?.multiplier !== undefined ? { multiplier: cost.multiplier } : {}),
      ...(cost?.priceCategory ? { priceCategory: cost.priceCategory } : {}),
    };
  });
}

export const copilotProvider: ChatProvider = {
  id: 'copilot',
  runTurn,
  mapError,
  generateTitle,
  listModels,
  async describe(): Promise<ProviderInfo> {
    // este texto vira a dica na tela de entrada, então precisa dizer o passo
    // exato que falta, e não só "indisponível"
    const chatInstalled = !!vscode.extensions.getExtension('GitHub.copilot-chat');
    if (!chatInstalled) {
      return {
        id: 'copilot',
        label: 'GitHub Copilot',
        available: false,
        detail: 'Extensão "GitHub Copilot Chat" não instalada no VS Code.',
        capabilities: { ...CAPABILITIES },
      };
    }
    const models = await withTimeout(
      vscode.lm.selectChatModels({ vendor: 'copilot' }),
      10000,
      NO_MODELS,
    );
    return {
      id: 'copilot',
      label: 'GitHub Copilot',
      available: models.length > 0,
      detail: models.length
        ? `${models.length} modelo(s) disponíveis`
        : 'Abra o chat do Copilot no VS Code uma vez para ativar os modelos (e confira o login do GitHub).',
      capabilities: { ...CAPABILITIES },
    };
  },
};

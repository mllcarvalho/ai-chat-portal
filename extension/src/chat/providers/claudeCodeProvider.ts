import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import type {
  ChatErrorCode,
  ChatFinishReason,
  MessagePart,
  ModelInfo,
  ProviderInfo,
} from '@aiportal/shared';
import { ensureDir } from '../../storage/paths';
import { collectKnowledgeContext } from '../../storage/knowledgeStore';
import { netProcessEnv } from '../../tools/netEnv';
import type { ChatProvider, TurnContext, TurnResult } from './types';

/**
 * Ao contrário do Copilot, aqui o portal NÃO é dono do loop agêntico: o
 * `claude` roda o próprio ciclo (pensa, chama Read/Write/Edit/Bash, repete) e
 * o portal só traduz o stream JSONL dele para os eventos SSE da UI.
 *
 * Rodamos a CLI que já está instalada na máquina em vez do Agent SDK de
 * propósito: numa rede corporativa a CLI já carrega login, proxy e CA
 * próprios — reimplementar isso do lado do portal seria refazer o setup mais
 * frágil do ambiente.
 */

const BIN = 'claude';
/** Sem resposta nem evento nenhum por este tempo, desistimos do processo. */
const IDLE_TIMEOUT_MS = 300_000;
/** Teto do preâmbulo que injetamos via --append-system-prompt. */
const SYSTEM_PROMPT_CLAMP = 32 * 1024;
/** Teto do conteúdo de um anexo colado no prompt. */
const ATTACHMENT_CLAMP = 64 * 1024;
const TOOL_RESULT_CLAMP = 64 * 1024;

/** Erro com a saída de erro da CLI junto, para o mapError montar a mensagem. */
class ClaudeCliError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

function clamp(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncado)`;
}

/**
 * Id reservado: significa "não passe --model", deixando valer o que o usuário
 * configurou na própria CLI (o /model da sessão interativa e o settings.json).
 */
export const CLI_DEFAULT_MODEL = 'default';

/**
 * A CLI não expõe um "list models" — não existe `claude models`, e o /model é
 * interno da TUI. Então a lista é fixa e usa os aliases dela, que sempre
 * apontam para a versão mais recente de cada tier (em vez de ids datados que
 * envelhecem). A primeira opção delega a escolha para a própria CLI.
 */
const MODELS: ModelInfo[] = [
  {
    id: CLI_DEFAULT_MODEL,
    name: 'Padrão do Claude Code',
    family: 'segue o /model da CLI',
    vendor: 'anthropic',
    version: CLI_DEFAULT_MODEL,
    maxInputTokens: 1_000_000,
    provider: 'claude-code',
  },
  {
    id: 'opus',
    name: 'Claude Opus',
    family: 'claude',
    vendor: 'anthropic',
    version: 'opus',
    maxInputTokens: 1_000_000,
    provider: 'claude-code',
  },
  {
    id: 'sonnet',
    name: 'Claude Sonnet',
    family: 'claude',
    vendor: 'anthropic',
    version: 'sonnet',
    maxInputTokens: 1_000_000,
    provider: 'claude-code',
  },
  {
    id: 'haiku',
    name: 'Claude Haiku',
    family: 'claude',
    vendor: 'anthropic',
    version: 'haiku',
    maxInputTokens: 200_000,
    provider: 'claude-code',
  },
];

const CAPABILITIES = {
  // instruções do agente/projeto e skills viram --append-system-prompt
  skills: true,
  knowledge: true,
  // o Claude Code usa a própria configuração de MCP, não a do portal
  mcp: false,
  // as ferramentas são as embutidas da CLI; o liga/desliga do portal não vale
  toolToggles: false,
  agents: true,
  // ask/plan/agent viram --tools ""/--permission-mode plan/acceptEdits
  modes: true,
  // a CLI lê os arquivos sozinha (cwd = pasta do projeto); só apontamos quais
  contextFiles: true,
  cost: true,
} as const;

/**
 * Ambiente do processo filho: o do host mais a camada corporativa
 * (proxy/CA). netProcessEnv() devolve SÓ o overlay — sozinho deixaria o
 * filho sem PATH e o `claude` viraria ENOENT.
 */
function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ...netProcessEnv() };
}

/**
 * A versão é consultada tanto no describe quanto no listModels, e o catálogo
 * é recarregado a cada boot da UI — sem cache seria um spawn por consulta.
 */
const VERSION_TTL_MS = 20_000;
let versionCache: { at: number; value: string | undefined } | undefined;

async function cliVersion(): Promise<string | undefined> {
  if (versionCache && Date.now() - versionCache.at < VERSION_TTL_MS) return versionCache.value;
  const value = await probeVersion();
  versionCache = { at: Date.now(), value };
  return value;
}

/** Roda `claude --version` só para saber se a CLI existe e está no PATH. */
function probeVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = '';
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(BIN, ['--version'], { env: childEnv() });
    } catch {
      return resolve(undefined);
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, 10_000);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out.trim() ? out.trim() : undefined);
    });
  });
}

/**
 * Preâmbulo com o que o portal sabe e a CLI não: instruções do projeto e do
 * agente, skills ativadas, base de conhecimento e arquivos fixados. Vai em
 * --append-system-prompt (soma ao system prompt padrão do Claude Code em vez
 * de substituí-lo, para não perder o comportamento de ferramentas dele).
 */
function buildSystemPrompt(ctx: TurnContext): string | undefined {
  const blocks: string[] = [];
  if (ctx.project?.instructions?.trim()) {
    blocks.push(`# Instruções do projeto "${ctx.project.name}"\n\n${ctx.project.instructions.trim()}`);
  }
  if (ctx.agent?.instructions?.trim()) {
    blocks.push(`# Persona\n\n${ctx.agent.instructions.trim()}`);
  }
  for (const skill of ctx.instructionSkills) {
    blocks.push(`# Skill: ${skill.name}\n\n${skill.content}`);
  }
  // base de conhecimento: o índice basta quando a CLI pode abrir os arquivos
  const knowledge = collectKnowledgeContext(
    ctx.session.projectId,
    ctx.agent?.knowledgeBaseIds,
    false,
  );
  if (knowledge.snippets.length) {
    blocks.push(
      '# Base de conhecimento\n\n' +
        knowledge.snippets
        .map((s) => `## ${s.baseName} — ${s.docName}\n\n${s.content}`)
        .join('\n\n'),
    );
  }
  if (ctx.session.contextFiles?.length) {
    blocks.push(
      '# Arquivos fixados pelo usuário\n\n' +
        'Estes caminhos (relativos ao diretório atual) foram marcados como relevantes. ' +
        'Leia-os quando forem úteis para a tarefa:\n' +
        ctx.session.contextFiles.map((p) => `- ${p}`).join('\n'),
    );
  }
  if (!blocks.length) return undefined;
  return clamp(blocks.join('\n\n---\n\n'), SYSTEM_PROMPT_CLAMP);
}

/** Mensagem do usuário deste turno, com os anexos colados no fim. */
function buildPrompt(ctx: TurnContext): string {
  const parts = [ctx.text];
  for (const att of ctx.attachments) {
    parts.push(`\n\n--- Anexo: ${att.name} ---\n${clamp(att.content, ATTACHMENT_CLAMP)}`);
  }
  return parts.join('');
}

function buildArgs(ctx: TurnContext): string[] {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    // sem isto o texto só chega em blocos inteiros no fim de cada rodada
    '--include-partial-messages',
    // stream-json exige verbose
    '--verbose',
  ];

  // retoma a conversa do lado da CLI: o histórico mora lá, não reenviamos nada
  if (ctx.session.providerSessionId) {
    args.push('--resume', ctx.session.providerSessionId);
  }

  // omitir --model é o que faz a CLI usar a escolha do próprio usuário
  const modelId = ctx.session.modelId ?? ctx.agent?.defaultModelId;
  if (modelId && modelId !== CLI_DEFAULT_MODEL && MODELS.some((m) => m.id === modelId)) {
    args.push('--model', modelId);
  }

  // os modos do portal mapeiam nos modos de permissão da CLI
  switch (ctx.session.mode) {
    case 'ask':
      // pergunta/resposta pura: sem ferramenta nenhuma
      args.push('--tools', '');
      break;
    case 'plan':
      args.push('--permission-mode', 'plan');
      break;
    case 'agent':
    default:
      // edições dentro da pasta do projeto seguem sem perguntar; a aprovação
      // por comando ainda não passa pela UI do portal (ver runTurn)
      args.push('--permission-mode', 'acceptEdits');
      break;
  }

  const systemPrompt = buildSystemPrompt(ctx);
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);

  return args;
}

/** Um objeto do stream JSONL da CLI (só os campos que consumimos). */
interface CliEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  message?: { content?: unknown[] };
  event?: {
    type?: string;
    index?: number;
    delta?: { type?: string; text?: string };
    content_block?: { type?: string };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
  num_turns?: number;
  stop_reason?: string;
  is_error?: boolean;
  result?: string;
}

function textOfToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && (b as { type?: string }).type === 'text'
          ? String((b as { text?: string }).text ?? '')
          : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  return content === undefined ? '' : JSON.stringify(content);
}

async function runTurn(ctx: TurnContext): Promise<TurnResult> {
  const { sse, token, parts, usage } = ctx;
  // a CLI roda com a pasta da conversa como cwd — é assim que Read/Write/Bash
  // dela caem exatamente onde as ferramentas portal_* do Copilot cairiam
  ensureDir(ctx.workRoot);

  const args = buildArgs(ctx);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(BIN, args, { cwd: ctx.workRoot, env: childEnv() });
  } catch (err) {
    throw new ClaudeCliError(
      'Não foi possível iniciar o Claude Code.',
      err instanceof Error ? err.message : String(err),
      'ENOENT',
    );
  }

  // o desfecho é escrito de dentro do handler de linha (uma closure), então
  // vive num objeto: o compilador não acompanha reatribuição de `let` feita
  // por closure e passaria a tratar o valor como a constante inicial
  const state = {
    providerSessionId: ctx.session.providerSessionId,
    respondedModelId: ctx.session.modelId,
    finishReason: 'stop' as ChatFinishReason,
  };
  let stderr = '';
  /** Texto já enviado à UI por índice de bloco, para o `assistant` não duplicar. */
  let streamed = new Map<number, string>();
  /** Blocos já fechados pelo evento `assistant` — deltas atrasados são ignorados. */
  let finalized = new Set<number>();
  /** Início de cada tool call, para medir a duração no tool_result. */
  const toolStartedAt = new Map<string, number>();
  const toolNames = new Map<string, string>();

  const killed = { byUser: false };
  const stop = (): void => {
    killed.byUser = true;
    child.kill('SIGTERM');
    // a CLI às vezes demora a fechar sozinha depois do TERM
    setTimeout(() => child.kill('SIGKILL'), 3000).unref?.();
  };
  const cancelSub = token.onCancellationRequested(stop);

  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
    if (stderr.length > 16 * 1024) stderr = stderr.slice(-16 * 1024);
  });

  const handle = (evt: CliEvent): void => {
    switch (evt.type) {
      case 'system':
        if (evt.subtype === 'init') {
          // primeira coisa que a CLI emite: é aqui que descobrimos o id da
          // conversa dela, que grava na sessão para o próximo turno retomar
          if (evt.session_id) state.providerSessionId = evt.session_id;
          if (evt.model) state.respondedModelId = evt.model;
        }
        break;

      case 'stream_event': {
        const inner = evt.event;
        if (!inner) break;
        if (inner.type === 'message_start') {
          streamed = new Map();
          finalized = new Set();
        } else if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
          const idx = inner.index ?? 0;
          if (finalized.has(idx)) break;
          const delta = inner.delta.text ?? '';
          if (!delta) break;
          streamed.set(idx, (streamed.get(idx) ?? '') + delta);
          sse.send('text', { delta });
        }
        break;
      }

      case 'assistant': {
        const content = evt.message?.content ?? [];
        content.forEach((raw, idx) => {
          const block = raw as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
          if (block.type === 'text') {
            const full = block.text ?? '';
            const already = streamed.get(idx) ?? '';
            // sem --include-partial-messages efetivo (ou com deltas perdidos),
            // manda o que faltou de uma vez em vez de a UI ficar sem o texto
            if (full.length > already.length) {
              sse.send('text', { delta: full.slice(already.length) });
            }
            finalized.add(idx);
            if (full) parts.push({ type: 'text', text: full });
          } else if (block.type === 'tool_use' && block.id) {
            toolStartedAt.set(block.id, Date.now());
            toolNames.set(block.id, block.name ?? 'tool');
            sse.send('tool_call', {
              callId: block.id,
              toolName: block.name ?? 'tool',
              input: block.input,
            });
            parts.push({
              type: 'tool_call',
              callId: block.id,
              toolName: block.name ?? 'tool',
              input: block.input,
            });
          }
        });
        break;
      }

      case 'user': {
        // resultado das ferramentas que a própria CLI executou
        const content = evt.message?.content ?? [];
        for (const raw of content) {
          const block = raw as {
            type?: string;
            tool_use_id?: string;
            content?: unknown;
            is_error?: boolean;
          };
          if (block.type !== 'tool_result' || !block.tool_use_id) continue;
          const callId = block.tool_use_id;
          const toolName = toolNames.get(callId) ?? 'tool';
          const startedAt = toolStartedAt.get(callId);
          const result: MessagePart = {
            type: 'tool_result',
            callId,
            toolName,
            ok: block.is_error !== true,
            content: clamp(textOfToolResult(block.content) || '(sem saída)', TOOL_RESULT_CLAMP),
            durationMs: startedAt ? Date.now() - startedAt : 0,
          };
          parts.push(result);
          sse.send('tool_result', {
            callId,
            toolName,
            ok: result.ok,
            content: result.content,
            durationMs: result.durationMs,
          });
        }
        break;
      }

      case 'result': {
        const u = evt.usage ?? {};
        usage.inputTokens +=
          (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0);
        usage.outputTokens += u.output_tokens ?? 0;
        usage.requests += evt.num_turns ?? 1;
        if (typeof evt.total_cost_usd === 'number') usage.costUsd = evt.total_cost_usd;
        if (evt.subtype === 'error_max_turns') state.finishReason = 'max_rounds';
        else if (evt.is_error) state.finishReason = 'error';
        break;
      }
    }
  };

  const rl = readline.createInterface({ input: child.stdout });
  let lastEventAt = Date.now();
  const idleTimer = setInterval(() => {
    if (Date.now() - lastEventAt > IDLE_TIMEOUT_MS) child.kill('SIGKILL');
  }, 10_000);

  try {
    await new Promise<void>((resolve, reject) => {
      rl.on('line', (line) => {
        lastEventAt = Date.now();
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) return;
        let evt: CliEvent;
        try {
          evt = JSON.parse(trimmed) as CliEvent;
        } catch {
          return; // linha não-JSON no meio do stream: ignora
        }
        try {
          handle(evt);
        } catch (err) {
          reject(err);
        }
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        reject(
          new ClaudeCliError(
            err.code === 'ENOENT'
              ? 'O comando `claude` não foi encontrado no PATH.'
              : 'Falha ao executar o Claude Code.',
            stderr || err.message,
            err.code,
          ),
        );
      });
      child.on('close', (code) => {
        if (killed.byUser || token.isCancellationRequested) {
          state.finishReason = 'cancelled';
          return resolve();
        }
        // saiu limpo, ou saiu sujo mas já tínhamos o result com o desfecho
        if (code === 0 || state.finishReason === 'error' || state.finishReason === 'max_rounds') {
          return resolve();
        }
        reject(
          new ClaudeCliError(
            `O Claude Code encerrou com código ${code}.`,
            stderr,
            String(code ?? ''),
          ),
        );
      });

      // a mensagem do usuário vai por stdin: prompt longo não cabe em argv
      child.stdin.on('error', () => {
        // processo morreu antes de ler o prompt — o close trata o desfecho
      });
      child.stdin.end(buildPrompt(ctx));
    });
  } finally {
    clearInterval(idleTimer);
    cancelSub.dispose();
    rl.close();
  }

  if (state.finishReason === 'error') {
    throw new ClaudeCliError('O Claude Code terminou com erro.', stderr);
  }

  return {
    finishReason: state.finishReason,
    modelId: state.respondedModelId,
    providerSessionId: state.providerSessionId,
  };
}

function mapError(err: unknown): { code: ChatErrorCode; message: string } {
  if (err instanceof ClaudeCliError) {
    if (err.code === 'ENOENT') {
      return {
        code: 'model_not_found',
        message:
          'O comando `claude` não foi encontrado. Instale o Claude Code e confirme que ele ' +
          'responde a `claude --version` no terminal.',
      };
    }
    const detail = err.stderr.trim().split('\n').slice(-3).join('\n');
    return { code: 'internal', message: detail ? `${err.message}\n\n${detail}` : err.message };
  }
  return { code: 'internal', message: err instanceof Error ? err.message : String(err) };
}

export const claudeCodeProvider: ChatProvider = {
  id: 'claude-code',
  runTurn,
  mapError,
  async listModels(): Promise<ModelInfo[]> {
    return (await cliVersion()) ? MODELS : [];
  },
  async describe(): Promise<ProviderInfo> {
    const version = await cliVersion();
    return {
      id: 'claude-code',
      label: 'Claude Code',
      available: !!version,
      detail:
        version ??
        'CLI não encontrada. Instale o Claude Code e confirme que `claude --version` responde no terminal.',
      capabilities: { ...CAPABILITIES },
    };
  },
};

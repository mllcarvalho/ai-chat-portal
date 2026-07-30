import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ChatErrorCode,
  ChatFinishReason,
  MessagePart,
  ModelInfo,
  ProviderInfo,
  SessionMode,
} from '@aiportal/shared';
import { ensureDir } from '../../storage/paths';
import { collectKnowledgeContext } from '../../storage/knowledgeStore';
import { netProcessEnv } from '../../tools/netEnv';
import { findBin } from '../../tools/findBin';
import { waitForApproval } from '../approvals';
import { AcpClient, AcpProcessError } from './acpClient';
import { portalMcpServer } from './portalMcp';
import { rewriteSlashCommand, skillCatalogBlock } from './skillCatalog';
import type {
  ChatProvider,
  SubagentOutcome,
  SubagentRequest,
  TurnContext,
  TurnResult,
} from './types';

/**
 * Devin pelo subcomando `devin acp`, que roda a CLI como servidor do Agent
 * Client Protocol.
 *
 * Por que ACP e não `devin -p` como no Claude Code: o Devin NÃO tem
 * `--output-format stream-json`; o `-p` devolve texto puro, sem eventos, então
 * não haveria como montar tool calls nem streaming. O ACP resolve isso — e de
 * quebra traz `session/request_permission`, que liga a tela de aprovação do
 * portal (o provider do Claude Code roda em acceptEdits e não passa por ela).
 *
 * O formato abaixo veio do tráfego real capturado com
 * scripts/probe-devin-acp.mjs, não da especificação:
 *  - enquadramento ndjson (uma mensagem JSON por linha)
 *  - session/new devolve { sessionId, modes: { currentModeId, availableModes } }
 *  - agent_message_chunk é a resposta; agent_thought_chunk é raciocínio
 *  - session/prompt resolve com { stopReason, usage }
 *  - _cognition.ai/agent_stopped traz stats e acuCost
 */

const BIN = 'devin';
/** Sem nenhuma mensagem por este tempo, desiste do processo. */
const IDLE_TIMEOUT_MS = 300_000;
const SYSTEM_PROMPT_CLAMP = 32 * 1024;
const ATTACHMENT_CLAMP = 64 * 1024;
const TOOL_RESULT_CLAMP = 64 * 1024;
/** Teto de leitura quando o agente pede um arquivo pelo fs/read_text_file. */
const FS_READ_CLAMP = 512 * 1024;

/** `-V/--version` e o subcomando `version` existem; `--help` fica de reserva. */
const PROBES = [['--version'], ['version'], ['--help']];

function clamp(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncado)`;
}

function probe(bin: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { env: { ...process.env, ...netProcessEnv() } });
    } catch {
      return resolve(undefined);
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, 8000);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim().split('\n')[0]?.trim() || 'instalada' : undefined);
    });
  });
}

const VERSION_TTL_MS = 20_000;
/** Negativo expira rápido: instalar a CLI não deve exigir esperar a janela toda. */
const MISS_TTL_MS = 5_000;
let versionCache: { at: number; value: string | undefined; bin?: string } | undefined;

/** Caminho absoluto da CLI nesta máquina (undefined = não instalada). */
async function devinBinPath(): Promise<string | undefined> {
  await cliVersion();
  return versionCache?.bin;
}

async function cliVersion(): Promise<string | undefined> {
  const ttl = versionCache?.value ? VERSION_TTL_MS : MISS_TTL_MS;
  if (versionCache && Date.now() - versionCache.at < ttl) return versionCache.value;
  // caminho absoluto: o PATH do host da extensão pode não ter o binário
  const bin = await findBin(BIN);
  let value: string | undefined;
  if (bin) {
    for (const args of PROBES) {
      value = await probe(bin, args);
      if (value) break;
    }
  }
  versionCache = { at: Date.now(), value, bin };
  return value;
}

const MODELS: ModelInfo[] = [
  {
    id: 'default',
    name: 'Padrão do Devin',
    family: 'segue a configuração da CLI',
    vendor: 'cognition',
    version: 'default',
    maxInputTokens: 200_000,
    provider: 'devin',
  },
];

const CAPABILITIES = {
  skills: true,
  knowledge: true,
  // TODO: o Devin recusa o servidor MCP declarado no session/new ("Server
  // portal not found in configuration") — o formato correto está sendo
  // levantado com scripts/probe-devin-mcp.mjs. Até lá ele roda com as
  // ferramentas nativas dele, sem as do portal.
  mcp: false,
  toolToggles: false,
  agents: true,
  modes: true,
  contextFiles: true,
  // reporta ACU (unidade do Devin), não dólares nem credits do Copilot
  cost: false,
  // depende do servidor MCP acima: sem ele o adaptador do BMAD manda usar
  // ferramentas que não existem do lado do Devin
  bmad: false,
} as const;

/** Modos do portal → modos da sessão ACP (vistos no availableModes do trace). */
const MODE_MAP: Record<SessionMode, string> = {
  ask: 'ask',
  plan: 'plan',
  agent: 'accept-edits',
};

/**
 * Clientes de MCP costumam publicar as ferramentas com o prefixo do servidor,
 * e o adaptador do BMAD cita os nomes sem prefixo. Diferente do Claude Code
 * (onde o prefixo é `mcp__portal__`), o formato do Devin não foi observado no
 * trace — então a nota descreve a regra em vez de cravar o prefixo.
 */
const MCP_PREFIX_NOTE =
  '# Ferramentas do portal\n\n' +
  'O servidor MCP `portal` expõe as ferramentas do portal. Se elas aparecerem com um ' +
  'prefixo (ex.: `portal.portal_write_file` ou `mcp__portal__portal_write_file`), ' +
  'entenda que qualquer menção a `portal_write_file`, `portal_read_file`, ' +
  '`portal_run_command`, `bmad_read_file` ou `bmad_list_files` nas instruções se refere ' +
  'à ferramenta correspondente desse servidor. Prefira-as às suas próprias: elas gravam ' +
  'na pasta certa da conversa e registram checkpoints que o usuário pode reverter.';

/** Preâmbulo com o que o portal sabe e a CLI não. */
function buildSystemPrompt(ctx: TurnContext, hasPortalTools: boolean): string | undefined {
  const blocks: string[] = [];
  if (hasPortalTools) blocks.push(MCP_PREFIX_NOTE);
  if (ctx.project?.instructions?.trim()) {
    blocks.push(
      `# Instruções do projeto "${ctx.project.name}"\n\n${ctx.project.instructions.trim()}`,
    );
  }
  if (ctx.agent?.instructions?.trim()) {
    blocks.push(`# Persona\n\n${ctx.agent.instructions.trim()}`);
  }
  for (const skill of ctx.instructionSkills) {
    blocks.push(`# Skill: ${skill.name}\n\n${skill.content}`);
  }
  if (hasPortalTools) {
    const catalog = skillCatalogBlock(ctx);
    if (catalog) blocks.push(catalog);
  }
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
        'Estes caminhos (relativos ao diretório atual) foram marcados como relevantes:\n' +
        ctx.session.contextFiles.map((p) => `- ${p}`).join('\n'),
    );
  }
  if (!blocks.length) return undefined;
  return clamp(blocks.join('\n\n---\n\n'), SYSTEM_PROMPT_CLAMP);
}

/**
 * O ACP não tem campo de system prompt: o preâmbulo do portal vai como um
 * bloco no início da PRIMEIRA mensagem. Nos turnos seguintes a sessão já
 * carrega esse contexto, então só o texto do usuário é enviado.
 */
function buildPromptText(
  ctx: TurnContext,
  isFirstTurn: boolean,
  hasPortalTools: boolean,
): string {
  const parts: string[] = [];
  const preamble = isFirstTurn ? buildSystemPrompt(ctx, hasPortalTools) : undefined;
  if (preamble) {
    parts.push(`<contexto-do-portal>\n${preamble}\n</contexto-do-portal>\n\n`);
  }
  // idem Claude Code: o /comando do portal não pode ir cru para a CLI
  parts.push(rewriteSlashCommand(ctx));
  for (const att of ctx.attachments) {
    parts.push(`\n\n--- Anexo: ${att.name} ---\n${clamp(att.content, ATTACHMENT_CLAMP)}`);
  }
  return parts.join('');
}

/**
 * Valida um caminho vindo do agente e devolve o absoluto.
 *
 * O ACP especifica `path` como ABSOLUTO. A versão anterior convertia para
 * relativo antes de validar, o que quebrava quando o caminho era a própria
 * raiz (path.relative devolve "") ou vinha com symlink resolvido diferente.
 * Aqui a comparação é feita direto entre caminhos resolvidos.
 */
function insideWorkRoot(workRoot: string, p: string | undefined): string {
  if (!p) throw new Error('path é obrigatório');
  const root = path.resolve(workRoot);
  const target = path.resolve(path.isAbsolute(p) ? p : path.join(root, p));
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Caminho fora da pasta de trabalho da conversa: ${p}`);
  }
  return target;
}

/** Junta os blocos de conteúdo do ACP num texto só. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((b) => {
      if (!b || typeof b !== 'object') return '';
      const block = b as { type?: string; text?: string; content?: unknown };
      if (block.type === 'text') return block.text ?? '';
      if (block.content !== undefined) return contentToText(block.content);
      return '';
    })
    .filter(Boolean)
    .join('');
}

interface SessionUpdate {
  sessionUpdate?: string;
  content?: unknown;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  content_?: unknown;
}

async function runTurn(ctx: TurnContext): Promise<TurnResult> {
  const { sse, token, parts, usage, requestId } = ctx;
  ensureDir(ctx.workRoot);

  const state = {
    sessionId: ctx.session.providerSessionId,
    finishReason: 'stop' as ChatFinishReason,
    acuCost: undefined as number | undefined,
  };
  /** Início de cada tool call, para medir duração; também guarda o nome. */
  const tools = new Map<string, { name: string; startedAt: number; reported: boolean }>();

  /**
   * O ACP só entrega a resposta em pedaços (agent_message_chunk) — não existe
   * um evento com o bloco inteiro, como o `assistant` do Claude Code. Sem
   * juntar os pedaços aqui, o texto apareceria ao vivo e sumiria no reload,
   * porque nada teria ido para `parts`.
   */
  let pendingText = '';
  const flushText = (): void => {
    if (!pendingText) return;
    parts.push({ type: 'text', text: pendingText });
    pendingText = '';
  };

  const client = new AcpClient({
    command: (await devinBinPath()) ?? BIN,
    args: ['acp'],
    cwd: ctx.workRoot,
    // netProcessEnv devolve só o overlay de rede — sem process.env o filho
    // ficaria sem PATH (mesmo bug que o provider do Claude Code teve)
    env: { ...process.env, ...netProcessEnv() },
    onNotification: (method, params) => handleNotification(method, params),
    onRequest: (method, params) => handleRequest(method, params),
  });

  const cancelSub = token.onCancellationRequested(() => {
    state.finishReason = 'cancelled';
    if (state.sessionId) client.notify('session/cancel', { sessionId: state.sessionId });
    // o cancel é cooperativo; se o agente não sair, o dispose derruba
    void client.dispose();
  });

  let lastEventAt = Date.now();
  const idleTimer = setInterval(() => {
    if (Date.now() - lastEventAt > IDLE_TIMEOUT_MS) void client.dispose();
  }, 10_000);

  function handleNotification(method: string, params: unknown): void {
    lastEventAt = Date.now();
    if (method !== 'session/update') return; // _cognition.ai/* tratado abaixo
    const update = (params as { update?: SessionUpdate } | undefined)?.update;
    if (!update) return;

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        // esta é a resposta ao usuário
        const delta = contentToText(update.content);
        if (delta) {
          pendingText += delta;
          sse.send('text', { delta });
        }
        break;
      }
      case 'agent_thought_chunk':
        // raciocínio interno: o portal não tem superfície para isso e
        // misturá-lo na bolha faria a resposta parecer um monólogo
        break;
      case 'tool_call': {
        flushText(); // preserva a ordem: o que foi dito antes da ferramenta
        const id = update.toolCallId ?? `tool-${tools.size}`;
        const name = update.title || update.kind || 'ferramenta';
        tools.set(id, { name, startedAt: Date.now(), reported: false });
        sse.send('tool_call', { callId: id, toolName: name, input: update.rawInput ?? {} });
        parts.push({ type: 'tool_call', callId: id, toolName: name, input: update.rawInput ?? {} });
        break;
      }
      case 'tool_call_update': {
        const id = update.toolCallId;
        if (!id) break;
        const entry = tools.get(id);
        // só o status final vira tool_result; "in_progress" seria ruído
        const done = update.status === 'completed' || update.status === 'failed';
        if (!entry || entry.reported || !done) break;
        entry.reported = true;
        const result: MessagePart = {
          type: 'tool_result',
          callId: id,
          toolName: entry.name,
          ok: update.status === 'completed',
          content: clamp(contentToText(update.content) || '(sem saída)', TOOL_RESULT_CLAMP),
          durationMs: Date.now() - entry.startedAt,
        };
        parts.push(result);
        sse.send('tool_result', {
          callId: id,
          toolName: result.toolName,
          ok: result.ok,
          content: result.content,
          durationMs: result.durationMs,
        });
        break;
      }
    }
  }

  /** Requisições do agente para o portal — não responder trava o turno. */
  async function handleRequest(method: string, params: unknown): Promise<unknown> {
    lastEventAt = Date.now();
    switch (method) {
      case 'session/request_permission':
        return requestPermission(params);
      case 'fs/read_text_file': {
        const { path: p, line, limit } = (params ?? {}) as {
          path?: string;
          line?: number;
          limit?: number;
        };
        const target = insideWorkRoot(ctx.workRoot, p);
        let text = clamp(fs.readFileSync(target, 'utf8'), FS_READ_CLAMP);
        // o protocolo permite pedir uma faixa de linhas (1-based)
        if (typeof line === 'number' || typeof limit === 'number') {
          const all = text.split('\n');
          const start = Math.max(0, (line ?? 1) - 1);
          text = all.slice(start, typeof limit === 'number' ? start + limit : undefined).join('\n');
        }
        return { content: text };
      }
      case 'fs/write_text_file': {
        const { path: p, content } = (params ?? {}) as { path?: string; content?: string };
        const target = insideWorkRoot(ctx.workRoot, p);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content ?? '', 'utf8');
        return null;
      }
      default:
        // capacidade que não anunciamos: recusa explícita é melhor que silêncio
        throw new Error(`Método não suportado pelo portal: ${method}`);
    }
  }

  /** Ponte entre o pedido de permissão do ACP e a tela de aprovação do portal. */
  async function requestPermission(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as {
      toolCall?: { toolCallId?: string; title?: string; rawInput?: unknown };
      options?: { optionId?: string; name?: string; kind?: string }[];
    };
    const callId = p.toolCall?.toolCallId ?? `perm-${Date.now()}`;
    const toolName = p.toolCall?.title ?? 'ferramenta';
    const raw = p.toolCall?.rawInput;
    const command =
      typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : toolName;

    sse.send('approval_request', { callId, toolName, command, cwd: ctx.workRoot });
    const verdict = await waitForApproval(requestId, callId, token);

    const options = p.options ?? [];
    const pick = (re: RegExp): string | undefined =>
      options.find((o) => re.test(`${o.optionId ?? ''} ${o.kind ?? ''}`))?.optionId;

    if (verdict === 'approved') {
      const allow = pick(/allow|approve|accept|once/i) ?? options[0]?.optionId;
      return { outcome: { outcome: 'selected', optionId: allow } };
    }
    const reject = pick(/reject|deny|cancel/i);
    // sem opção de recusa declarada, cancelar é o desfecho correto
    return reject
      ? { outcome: { outcome: 'selected', optionId: reject } }
      : { outcome: { outcome: 'cancelled' } };
  }

  // ferramentas do portal para o agente (é o que faz o BMAD rodar aqui). O
  // formato de mcpServers no ACP é o do stdio: command/args/env.
  const portal = portalMcpServer(ctx.session.id);
  const mcpServers = portal
    ? [
        {
          name: 'portal',
          command: portal.command,
          args: portal.args,
          env: Object.entries(portal.env).map(([name, value]) => ({ name, value })),
        },
      ]
    : [];

  try {
    // 1. handshake: declara que o portal sabe ler/escrever arquivos por ele
    await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });

    // 2. retoma a conversa do lado da CLI, ou cria uma nova
    let loaded = false;
    if (state.sessionId) {
      try {
        await client.request('session/load', {
          sessionId: state.sessionId,
          cwd: ctx.workRoot,
          mcpServers,
        });
        loaded = true;
      } catch {
        // sessão expirada/removida do lado do Devin: começa uma nova em vez
        // de derrubar a conversa do usuário
        state.sessionId = undefined;
      }
    }
    if (!loaded) {
      const created = await client.request<{ sessionId?: string }>('session/new', {
        cwd: ctx.workRoot,
        mcpServers,
      });
      state.sessionId = created?.sessionId;
      if (!state.sessionId) throw new Error('O Devin não devolveu um sessionId.');
    }

    // 3. modo da conversa (ask/plan/agent → ask/plan/accept-edits)
    const modeId = MODE_MAP[ctx.session.mode] ?? MODE_MAP.agent;
    try {
      await client.request('session/set_mode', { sessionId: state.sessionId, modeId });
    } catch {
      // agente sem suporte a troca de modo: segue no modo padrão da sessão
      sse.send('notice', {
        message: `O Devin não aceitou o modo "${ctx.session.mode}" — respondendo no modo padrão dele.`,
      });
    }

    // 4. o turno em si
    const answer = await client.request<{
      stopReason?: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        cachedReadTokens?: number;
      };
    }>('session/prompt', {
      sessionId: state.sessionId,
      prompt: [{ type: 'text', text: buildPromptText(ctx, !loaded, !!portal) }],
    });

    const u = answer?.usage ?? {};
    usage.inputTokens += (u.inputTokens ?? 0) + (u.cachedReadTokens ?? 0);
    usage.outputTokens += u.outputTokens ?? 0;
    usage.requests += 1;

    if (token.isCancellationRequested) state.finishReason = 'cancelled';
    else if (answer?.stopReason === 'max_tokens') state.finishReason = 'max_rounds';
    else if (answer?.stopReason === 'cancelled') state.finishReason = 'cancelled';
  } catch (err) {
    if (token.isCancellationRequested) {
      state.finishReason = 'cancelled';
    } else {
      throw err;
    }
  } finally {
    flushText();
    clearInterval(idleTimer);
    cancelSub.dispose();
    await client.dispose();
  }

  return {
    finishReason: state.finishReason,
    modelId: 'default',
    providerSessionId: state.sessionId,
  };
}

function mapError(err: unknown): { code: ChatErrorCode; message: string } {
  if (err instanceof AcpProcessError) {
    if (err.code === 'ENOENT') {
      return {
        code: 'model_not_found',
        message:
          'O comando `devin` não foi encontrado. Instale o Devin e confirme que ele responde a ' +
          '`devin --version` no terminal.',
      };
    }
    const detail = err.stderr.trim().split('\n').slice(-3).join('\n');
    return { code: 'internal', message: detail ? `${err.message}\n\n${detail}` : err.message };
  }
  return { code: 'internal', message: err instanceof Error ? err.message : String(err) };
}

export const devinProvider: ChatProvider = {
  id: 'devin',
  runTurn,
  mapError,
  runSubagent: runSubagentTurn,
  async listModels(): Promise<ModelInfo[]> {
    return (await cliVersion()) ? MODELS : [];
  },
  async describe(): Promise<ProviderInfo> {
    const version = await cliVersion();
    return {
      id: 'devin',
      label: 'Devin',
      available: !!version,
      detail:
        version ??
        'CLI não encontrada. Instale o Devin e confirme que `devin --version` responde no terminal.',
      capabilities: { ...CAPABILITIES },
    };
  },
};

/**
 * Subagente do party mode no Devin.
 *
 * Usa ACP e não `devin -p` por dois motivos: o `-p` não aceita MCP por
 * invocação (o `devin mcp` é configuração persistente da máquina) nem system
 * prompt por flag — sem os dois, o subagente ficaria sem as ferramentas de
 * leitura do portal e sem persona. Pelo ACP os dois entram no session/new.
 *
 * Como o escopo `subagent` do servidor MCP só publica ferramentas de leitura,
 * não há o que aprovar: um pedido de permissão é aceito direto.
 */
async function runSubagentTurn(req: SubagentRequest): Promise<SubagentOutcome> {
  const usage = { inputTokens: 0, outputTokens: 0, requests: 0 };
  const portal = portalMcpServer(req.sessionId, 'subagent');
  let text = '';

  const client = new AcpClient({
    command: (await devinBinPath()) ?? BIN,
    args: ['acp'],
    cwd: req.workRoot,
    env: { ...process.env, ...netProcessEnv() },
    onNotification: (method, params) => {
      if (method !== 'session/update') return;
      const update = (params as { update?: SessionUpdate } | undefined)?.update;
      // só a resposta interessa: o subagente não emite eventos para a UI
      if (update?.sessionUpdate === 'agent_message_chunk') {
        text += contentToText(update.content);
      }
    },
    onRequest: async (method, params) => {
      if (method === 'session/request_permission') {
        const opts =
          (params as { options?: { optionId?: string; kind?: string }[] })?.options ?? [];
        const allow =
          opts.find((o) => /allow|approve|accept|once/i.test(`${o.optionId ?? ''} ${o.kind ?? ''}`)) ??
          opts[0];
        return { outcome: { outcome: 'selected', optionId: allow?.optionId } };
      }
      throw new Error(`Método não suportado no subagente: ${method}`);
    },
  });

  const cancel = req.token.onCancellationRequested(() => void client.dispose());
  try {
    await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const created = await client.request<{ sessionId?: string }>('session/new', {
      cwd: req.workRoot,
      mcpServers: portal
        ? [
            {
              name: 'portal',
              command: portal.command,
              args: portal.args,
              env: Object.entries(portal.env).map(([name, value]) => ({ name, value })),
            },
          ]
        : [],
    });
    if (!created?.sessionId) throw new Error('O Devin não devolveu um sessionId.');

    const prompt = [req.persona, MCP_PREFIX_NOTE, req.task].filter(Boolean).join('\n\n---\n\n');
    const answer = await client.request<{
      usage?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number };
    }>('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: prompt }],
    });
    const u = answer?.usage ?? {};
    usage.inputTokens += (u.inputTokens ?? 0) + (u.cachedReadTokens ?? 0);
    usage.outputTokens += u.outputTokens ?? 0;
    usage.requests += 1;
  } catch (err) {
    // nunca rejeita: o chamador dispara vários subagentes em paralelo
    return {
      ok: false,
      content: err instanceof Error ? err.message : String(err),
      usage,
    };
  } finally {
    cancel.dispose();
    await client.dispose();
  }

  return text.trim()
    ? { ok: true, content: text.trim(), usage }
    : { ok: false, content: 'O subagente encerrou sem resposta.', usage };
}

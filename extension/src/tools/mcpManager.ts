import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { McpProxyConfig, McpServerEntry, McpServerInfo } from '@aiportal/shared';
import { readJson, writeJsonAtomic } from '../storage/jsonStore';
import {
  deleteProxy,
  getProxySecret,
  isProxy,
  listProxies,
  saveProxy,
} from '../storage/mcpProxyStore';
import {
  IUCLICK_SERVER_NAME,
  clearIuclickCredentials,
  getIuclickEnv,
} from '../storage/iuclickStore';
import { GLOBAL_ROOT, getPortalRoot, mcpStatePath } from '../storage/paths';
import { GITHUB_MCP_SERVER_NAME, githubMcpHeaders } from './githubMcp';
import { dispatcherFor, netProcessEnv, netStatus, requestInitFor, resolveShellEnv } from './netEnv';
import { withTimeout } from '../util';

// primeiro boot de servidor stdio pode ser lento (venv, imports, STS via proxy)
const START_TIMEOUT = 45_000;
const CALL_TIMEOUT = 120_000;
const TOKEN_TIMEOUT = 15_000;
const CONNECT_TIMEOUT = 20_000;
/** Reconecta o proxy quando faltar menos que isto para o token expirar. */
const TOKEN_SKEW_MS = 60_000;

interface McpToolDef {
  name: string;
  description: string;
  inputSchema?: unknown;
}

interface ServerState {
  /** Entry sintética para http/stdio; nos proxies descreve só o gateway. */
  entry: McpServerEntry;
  source: 'mcpjson' | 'proxy';
  proxy?: McpProxyConfig;
  status: McpServerInfo['status'];
  error?: string;
  client?: Client;
  tools: McpToolDef[];
  /** Estado do token OAuth (proxies). */
  tokenExpiresAt?: number;
  /** Start em andamento: chamadas concorrentes pegam carona em vez de duplicar o processo. */
  startInFlight?: Promise<McpServerInfo>;
}

interface McpState {
  enabled: Record<string, boolean>;
}

const servers = new Map<string, ServerState>();

/**
 * Onde os servidores ficam persistidos. Com o repo do portal aberto no VS Code
 * usamos <repo>/.vscode/mcp.json — assim o Copilot do VS Code enxerga os mesmos
 * servidores. Sem o repo (instalação só da extensão, via npx), caímos num
 * mcp.json global em ~/AIChatPortal: quem spawna os processos é o próprio
 * portal, então nada aqui depende de workspace aberto.
 */
function mcpJsonPath(): string {
  const root = getPortalRoot();
  return root ? path.join(root, '.vscode', 'mcp.json') : path.join(GLOBAL_ROOT, 'mcp.json');
}

/** Lê o mcp.json no formato padrão do VS Code ({ "servers": {...} }). */
export function readMcpJson(): Record<string, McpServerEntry> {
  const raw = readJson<{ servers?: Record<string, McpServerEntry> }>(mcpJsonPath());
  return raw?.servers ?? {};
}

function writeMcpJson(entries: Record<string, McpServerEntry>): void {
  writeJsonAtomic(mcpJsonPath(), { servers: entries });
}

/**
 * Todos os mcp.json que podem conter uma entrada: o ATIVO (que depende do repo
 * do portal estar aberto) e o GLOBAL (~/AIChatPortal). Sem isto, remover um
 * servidor num contexto deixava a entrada "órfã" no outro arquivo — e o
 * autoStart a ressuscitava quando o contexto virava (ex.: IUClick voltando a
 * dar 403 depois de "removido"). Dedup preserva o caso repo-fechado (1 arquivo).
 */
function allMcpJsonPaths(): string[] {
  return [...new Set([mcpJsonPath(), path.join(GLOBAL_ROOT, 'mcp.json')])];
}

/** Idem para o mcp-state.json (flag enabled): ativo (portal-data) + global. */
function allStatePaths(): string[] {
  return [...new Set([mcpStatePath(), path.join(GLOBAL_ROOT, 'mcp-state.json')])];
}

function readState(): McpState {
  return readJson<McpState>(mcpStatePath()) ?? { enabled: {} };
}

function writeState(state: McpState): void {
  writeJsonAtomic(mcpStatePath(), state);
}

function entryType(entry: McpServerEntry): 'stdio' | 'http' {
  if (entry.type === 'http' || entry.type === 'sse') return 'http';
  if (entry.type === 'stdio') return 'stdio';
  return entry.url ? 'http' : 'stdio';
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'server';
}

/** Sincroniza o mapa em memória com o mcp.json e os proxies (quando mudam em disco). */
function syncFromDisk(): void {
  const entries = readMcpJson();
  for (const [name, entry] of Object.entries(entries)) {
    const existing = servers.get(name);
    if (!existing) {
      servers.set(name, { entry, source: 'mcpjson', status: 'stopped', tools: [] });
    } else if (existing.source === 'mcpjson' && JSON.stringify(existing.entry) !== JSON.stringify(entry)) {
      // config mudou: derruba para a próxima ligada usar a config nova
      if (existing.status === 'running') void stopServer(name);
      servers.set(name, { entry, source: 'mcpjson', status: 'stopped', tools: [] });
    }
  }

  const proxies = listProxies();
  const proxyNames = new Set(proxies.map((p) => p.name));
  for (const proxy of proxies) {
    const entry: McpServerEntry = { type: 'http', url: proxy.gatewayUrl };
    const existing = servers.get(proxy.name);
    if (!existing) {
      servers.set(proxy.name, { entry, source: 'proxy', proxy, status: 'stopped', tools: [] });
    } else if (existing.source === 'proxy' && JSON.stringify(existing.proxy) !== JSON.stringify(proxy)) {
      if (existing.status === 'running') void stopServer(proxy.name);
      servers.set(proxy.name, { entry, source: 'proxy', proxy, status: 'stopped', tools: [] });
    }
  }

  for (const name of [...servers.keys()]) {
    const state = servers.get(name)!;
    const gone = state.source === 'proxy' ? !proxyNames.has(name) : !entries[name];
    if (gone) {
      void stopServer(name);
      servers.delete(name);
    }
  }
}

// ---------- OAuth2 client_credentials ----------

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

async function fetchToken(
  cfg: McpProxyConfig,
  secret: string,
): Promise<{ token: string; expiresAt: number }> {
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.clientId,
    client_secret: secret,
  });
  if (cfg.scope) params.set('scope', cfg.scope);
  const dispatcher = dispatcherFor(cfg.tokenUrl);
  let resp: Response;
  try {
    resp = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);
  } catch (err) {
    const host = (() => {
      try {
        return new URL(cfg.tokenUrl).host;
      } catch {
        return cfg.tokenUrl;
      }
    })();
    throw new Error(
      `Falha de rede ao obter token em ${host}: ${err instanceof Error ? err.message : err}. ` +
        `Confira proxy/VPN/certificado da rede corporativa.`,
    );
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`OAuth ${resp.status} ${resp.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  const data = (await resp.json().catch(() => ({}))) as TokenResponse;
  if (!data.access_token) throw new Error('Resposta do Token URL sem access_token');
  const ttl = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
  return { token: data.access_token, expiresAt: Date.now() + ttl * 1000 };
}

/** Obtém o token respeitando um timeout próprio (erro claro por fase). */
async function fetchTokenPhased(
  cfg: McpProxyConfig,
  secret: string,
): Promise<{ token: string; expiresAt: number }> {
  const TIMED_OUT = Symbol('timeout');
  const result = await Promise.race([
    fetchToken(cfg, secret),
    new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), TOKEN_TIMEOUT)),
  ]);
  if (result === TIMED_OUT) {
    throw new Error(
      `Timeout (${TOKEN_TIMEOUT / 1000}s) obtendo o token em ${hostOf(cfg.tokenUrl)}. ` +
        `[${netStatus(cfg.tokenUrl)}]`,
    );
  }
  return result;
}

/** Conecta o client ao gateway com o Bearer, com timeout e erro claro por fase. */
async function connectGatewayPhased(cfg: McpProxyConfig, token: string): Promise<Client> {
  const client = new Client({ name: 'ai-chat-portal', version: '1.0' });
  const ok = await withTimeout(
    (async () => {
      const transport = new StreamableHTTPClientTransport(new URL(cfg.gatewayUrl), {
        requestInit: requestInitFor(cfg.gatewayUrl, { Authorization: `Bearer ${token}` }),
      });
      await client.connect(transport);
      return true;
    })(),
    CONNECT_TIMEOUT,
    false,
  );
  if (!ok) {
    try {
      await client.close();
    } catch {
      // ignora
    }
    throw new Error(
      `Token OK, mas timeout (${CONNECT_TIMEOUT / 1000}s) conectando no gateway ${hostOf(cfg.gatewayUrl)}. ` +
        `[${netStatus(cfg.gatewayUrl)}]`,
    );
  }
  return client;
}

async function connectProxy(name: string, state: ServerState): Promise<Client> {
  const cfg = state.proxy;
  if (!cfg) throw new Error('Config do proxy ausente');
  await resolveShellEnv();
  const secret = await getProxySecret(name);
  if (secret === undefined) throw new Error('Client Secret não encontrado no SecretStorage');
  const { token, expiresAt } = await fetchTokenPhased(cfg, secret);
  const client = await connectGatewayPhased(cfg, token);
  state.tokenExpiresAt = expiresAt;
  return client;
}

/** Renova o token de um proxy reconectando o client. */
async function reconnectProxy(name: string, state: ServerState): Promise<void> {
  const old = state.client;
  state.client = undefined;
  if (old) {
    try {
      await old.close();
    } catch {
      // ignora
    }
  }
  state.client = await connectProxy(name, state);
}

function isAuthError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /401|403|unauthorized|forbidden|invalid[_ ]token|token.*(expired|invalid)|expired.*token/.test(msg);
}

/**
 * Re-detecta as credenciais do IUClick do navegador, no máximo uma vez por vez
 * (guarda de concorrência) e com timeout — para a auto-recuperação nunca travar
 * nem repetir a leitura do navegador quando várias tools do iuclick falham
 * juntas. Import tardio evita ciclo mcpManager ↔ iuclick.
 */
let iuclickRefreshInFlight: Promise<boolean> | undefined;
function refreshIuclickOnce(): Promise<boolean> {
  if (!iuclickRefreshInFlight) {
    iuclickRefreshInFlight = withTimeout(
      import('./iuclickAuth').then((m) => m.refreshIuclickCredentials()),
      15_000,
      false,
    ).finally(() => {
      iuclickRefreshInFlight = undefined;
    });
  }
  return iuclickRefreshInFlight;
}

// ---------- conexão (stdio / http / proxy) ----------

async function connect(
  entry: McpServerEntry,
  extraEnv?: Record<string, string>,
  extraHeaders?: Record<string, string>,
): Promise<Client> {
  const client = new Client({ name: 'ai-chat-portal', version: '1.0' });
  if (entryType(entry) === 'stdio') {
    if (!entry.command) throw new Error('Servidor stdio sem "command" no mcp.json');
    const transport = new StdioClientTransport({
      command: entry.command,
      args: entry.args ?? [],
      // getDefaultEnvironment é mínimo (HOME/PATH/etc): sem o netProcessEnv o
      // processo fica sem proxy/CA corporativos e trava em qualquer chamada externa
      env: { ...getDefaultEnvironment(), ...netProcessEnv(), ...(entry.env ?? {}), ...(extraEnv ?? {}) },
      cwd: entry.cwd ?? getPortalRoot() ?? GLOBAL_ROOT,
      stderr: 'ignore',
    });
    await client.connect(transport);
    return client;
  }
  if (!entry.url) throw new Error('Servidor http sem "url" no mcp.json');
  const url = new URL(entry.url);
  const headers = { ...(entry.headers ?? {}), ...(extraHeaders ?? {}) };
  // requestInitFor injeta proxy/CA corporativos — sem isso o fetch trava na rede Itaú
  const requestInit = requestInitFor(entry.url, headers);
  try {
    const transport = new StreamableHTTPClientTransport(url, { requestInit });
    await client.connect(transport);
    return client;
  } catch {
    // servidores antigos só falam SSE
    const fallback = new Client({ name: 'ai-chat-portal', version: '1.0' });
    const transport = new SSEClientTransport(url, { requestInit });
    await fallback.connect(transport);
    return fallback;
  }
}

export async function startServer(name: string): Promise<McpServerInfo> {
  syncFromDisk();
  const state = servers.get(name);
  if (!state) throw new Error(`Servidor MCP "${name}" não está configurado`);
  if (state.status === 'running') return toInfo(name, state);
  // dois starts simultâneos (autostart + toggle/restart) criariam dois
  // processos e o segundo sobrescreveria o client — o primeiro viraria órfão
  if (state.startInFlight) return state.startInFlight;
  const run = doStartServer(name, state);
  state.startInFlight = run;
  try {
    return await run;
  } finally {
    state.startInFlight = undefined;
  }
}

async function doStartServer(name: string, state: ServerState): Promise<McpServerInfo> {
  state.status = 'starting';
  state.error = undefined;
  try {
    // proxy gerencia o próprio timeout por fase (token/gateway) com erro claro;
    // stdio/http usam o timeout genérico de start
    let client: Client | undefined;
    if (state.source === 'proxy') {
      client = await connectProxy(name, state);
    } else {
      // GUI-launch deixa o PATH mínimo (sem nvm/homebrew/registro) → npx/uv não
      // são achados no spawn stdio; resolve uma vez e fica em process.env
      if (entryType(state.entry) === 'stdio') await resolveShellEnv();
      // IUClick: Cookie/X-UserToken ficam no SecretStorage (nunca no mcp.json)
      // e entram como env só aqui, na hora do spawn
      const extraEnv = name === IUCLICK_SERVER_NAME ? await getIuclickEnv() : undefined;
      // GitHub: Bearer da sessão GitHub do VS Code, obtido a cada subida
      const extraHeaders = name === GITHUB_MCP_SERVER_NAME ? await githubMcpHeaders() : undefined;
      const pending = connect(state.entry, extraEnv, extraHeaders);
      client = await withTimeout(pending, START_TIMEOUT, undefined);
      if (!client) {
        // o connect pode concluir DEPOIS do timeout: sem isto o processo
        // recém-spawnado ficaria vivo para sempre, sem dono
        pending.then(
          (late) => void late.close().catch(() => undefined),
          () => undefined,
        );
        throw new Error(`Timeout ao iniciar (${START_TIMEOUT / 1000}s)`);
      }
    }
    const result = await client.listTools();
    state.client = client;
    state.tools = result.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema,
    }));
    state.status = 'running';
  } catch (err) {
    state.status = 'error';
    state.error = err instanceof Error ? err.message : String(err);
    state.client = undefined;
    state.tools = [];
  }
  return toInfo(name, state);
}

export async function stopServer(name: string): Promise<McpServerInfo | undefined> {
  const state = servers.get(name);
  if (!state) return undefined;
  // um start em voo termina primeiro: parar no meio deixaria o client que
  // ele ainda vai criar sem ninguém para fechar
  if (state.startInFlight) await state.startInFlight.catch(() => undefined);
  const client = state.client;
  state.client = undefined;
  state.tools = [];
  state.status = 'stopped';
  state.error = undefined;
  state.tokenExpiresAt = undefined;
  if (client) {
    try {
      // close sem teto travaria o stop (e a desativação da extensão) num
      // servidor que não responde — 5s e segue
      await withTimeout(client.close(), 5000, undefined);
    } catch {
      // processo pode já ter morrido
    }
  }
  return toInfo(name, state);
}

export async function setServerEnabled(name: string, enabled: boolean): Promise<McpServerInfo> {
  const state = readState();
  state.enabled[name] = enabled;
  writeState(state);
  if (enabled) return startServer(name);
  const info = await stopServer(name);
  if (!info) throw new Error(`Servidor MCP "${name}" não encontrado`);
  return info;
}

/** Liga, na ativação da extensão, os servidores que o usuário deixou habilitados. */
export async function autoStartEnabled(): Promise<void> {
  syncFromDisk();
  const { enabled } = readState();
  await Promise.allSettled(
    [...servers.keys()].filter((name) => enabled[name]).map((name) => startServer(name)),
  );
}

function toInfo(name: string, state: ServerState): McpServerInfo {
  const { entry } = state;
  return {
    name,
    type: entryType(entry),
    kind: state.source,
    command: entry.command,
    args: entry.args,
    url: entry.url,
    proxy: state.proxy,
    enabled: readState().enabled[name] ?? false,
    status: state.status,
    error: state.error,
    toolCount: state.tools.length,
    toolNames: state.tools.map((t) => t.name),
  };
}

/** Tools do servidor (nome + descrição) para a UI — vazio se não estiver rodando. */
export function listServerTools(name: string): Array<{ name: string; description: string }> {
  syncFromDisk();
  const state = servers.get(name);
  if (!state) throw new Error(`Servidor MCP "${name}" não está configurado`);
  return state.tools.map((t) => ({ name: t.name, description: t.description }));
}

export function listServers(): McpServerInfo[] {
  syncFromDisk();
  return [...servers.entries()]
    .map(([name, state]) => toInfo(name, state))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function addServer(name: string, entry: McpServerEntry): void {
  const entries = readMcpJson();
  if (entries[name] || isProxy(name)) throw new Error(`Já existe um servidor chamado "${name}"`);
  entries[name] = entry;
  writeMcpJson(entries);
  syncFromDisk();
}

/**
 * Cria OU substitui a entry no mcp.json (setups guiados que o usuário refaz —
 * ex: ConsumerLab após credencial expirar — devem sobrescrever, não recusar).
 * O syncFromDisk derruba o servidor antigo se a config mudou.
 */
export function upsertServer(name: string, entry: McpServerEntry): void {
  if (isProxy(name)) throw new Error(`Já existe um proxy OAuth2 chamado "${name}"`);
  const entries = readMcpJson();
  entries[name] = entry;
  writeMcpJson(entries);
  syncFromDisk();
}

export async function removeServer(name: string): Promise<void> {
  await stopServer(name);
  if (isProxy(name)) {
    await deleteProxy(name);
    const state = readState();
    delete state.enabled[name];
    writeState(state);
    syncFromDisk();
    return;
  }
  // purga de TODOS os mcp.json e mcp-state.json alcançáveis (ativo + global),
  // não só o do contexto atual — senão sobra sujeira que ressuscita depois.
  // Idempotente: remover algo que já sumiu é sucesso, não erro.
  for (const p of allMcpJsonPaths()) {
    const raw = readJson<{ servers?: Record<string, McpServerEntry> }>(p);
    if (raw?.servers && name in raw.servers) {
      delete raw.servers[name];
      writeJsonAtomic(p, raw);
    }
  }
  for (const p of allStatePaths()) {
    const st = readJson<McpState>(p);
    if (st?.enabled && name in st.enabled) {
      delete st.enabled[name];
      writeJsonAtomic(p, st);
    }
  }
  // credenciais de sessão do IUClick sempre saem junto (mesmo se a entrada já
  // não estava no arquivo ativo) — é o que causava o "removeu e ainda dá 403"
  if (name === IUCLICK_SERVER_NAME) await clearIuclickCredentials();
  syncFromDisk();
}

// ---------- proxies OAuth2 ----------

/** Cria/atualiza um proxy e o liga. secret undefined em edição mantém o atual. */
export async function saveProxyServer(
  config: McpProxyConfig,
  secret?: string,
): Promise<McpServerInfo> {
  const entries = readMcpJson();
  if (entries[config.name] && !isProxy(config.name)) {
    throw new Error(`Já existe um servidor (não-proxy) chamado "${config.name}"`);
  }
  await saveProxy(config, secret);
  syncFromDisk();
  return setServerEnabled(config.name, true);
}

/** Testa a config (token + listTools) sem persistir nem ligar. Devolve os nomes das tools. */
export async function testProxyConnection(
  config: McpProxyConfig,
  secret?: string,
): Promise<string[]> {
  await resolveShellEnv();
  let realSecret = secret;
  if (realSecret === undefined || realSecret === '') {
    realSecret = await getProxySecret(config.name);
  }
  if (!realSecret) throw new Error('Informe o Client Secret');

  // fase 1: token (erros reais de OAuth/rede propagam; timeout vira mensagem clara)
  const { token } = await fetchTokenPhased(config, realSecret);
  // fase 2: conectar no gateway e listar as tools
  const client = await connectGatewayPhased(config, token);
  try {
    const result = await client.listTools();
    return result.tools.map((t) => t.name);
  } finally {
    try {
      await client.close();
    } catch {
      // ignora
    }
  }
}

function hostOf(urlStr: string): string {
  try {
    return new URL(urlStr).host;
  } catch {
    return urlStr;
  }
}

// ---------- ferramentas para o loop agêntico ----------

/** mcp_<server>_<tool> → { server, tool } (registry explícito; nomes podem ter _). */
const qualifiedIndex = new Map<string, { server: string; tool: string }>();

export interface QualifiedTool {
  qualifiedName: string;
  serverName: string;
  description: string;
  inputSchema?: unknown;
}

export function listRunningTools(): QualifiedTool[] {
  qualifiedIndex.clear();
  const out: QualifiedTool[] = [];
  for (const [name, state] of servers) {
    if (state.status !== 'running') continue;
    for (const tool of state.tools) {
      const qualifiedName = `mcp_${slug(name)}_${tool.name}`;
      qualifiedIndex.set(qualifiedName, { server: name, tool: tool.name });
      out.push({
        qualifiedName,
        serverName: name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
  }
  return out;
}

export function isMcpToolName(qualifiedName: string): boolean {
  if (!qualifiedIndex.size) listRunningTools();
  return qualifiedIndex.has(qualifiedName);
}

function extractText(result: Awaited<ReturnType<Client['callTool']>>, toolName: string): string {
  const texts: string[] = [];
  for (const part of (result.content ?? []) as Array<Record<string, unknown>>) {
    if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    else texts.push(JSON.stringify(part));
  }
  if (result.isError) {
    throw new Error(texts.join('\n') || `Erro na ferramenta ${toolName}`);
  }
  return texts.join('\n');
}

export async function callMcpTool(qualifiedName: string, input: object): Promise<string> {
  if (!qualifiedIndex.size) listRunningTools();
  const ref = qualifiedIndex.get(qualifiedName);
  if (!ref) throw new Error(`Ferramenta MCP desconhecida: ${qualifiedName}`);
  const state = servers.get(ref.server);
  if (!state?.client || state.status !== 'running') {
    throw new Error(`O servidor MCP "${ref.server}" está desligado`);
  }

  // proxy: renova o token proativamente se estiver perto de expirar
  if (state.source === 'proxy' && state.tokenExpiresAt && Date.now() > state.tokenExpiresAt - TOKEN_SKEW_MS) {
    try {
      await reconnectProxy(ref.server, state);
    } catch (err) {
      throw new Error(`Falha ao renovar o token do proxy "${ref.server}": ${err instanceof Error ? err.message : err}`);
    }
  }

  const doCall = async (): Promise<string> => {
    const client = state.client;
    if (!client) throw new Error(`O servidor MCP "${ref.server}" está desligado`);
    const result = await withTimeout(
      client.callTool({ name: ref.tool, arguments: input as Record<string, unknown> }),
      CALL_TIMEOUT,
      undefined,
    );
    if (!result) throw new Error(`Timeout chamando ${ref.tool} (${CALL_TIMEOUT / 1000}s)`);
    return extractText(result, ref.tool);
  };

  try {
    return await doCall();
  } catch (err) {
    // proxy: token pode ter expirado no servidor — reconecta uma vez e tenta de novo
    if (state.source === 'proxy' && isAuthError(err)) {
      await reconnectProxy(ref.server, state);
      return doCall();
    }
    // IUClick: sessão do ServiceNow expirou (403). Escopo ESTRITO a este
    // servidor — nada disso roda para outros MCPs nem para o chat normal.
    // Re-detecta do navegador (uma vez, com timeout), religa só o iuclick e
    // tenta de novo. Se não der, vira um erro claro DESTA tool (que o modelo
    // trata) — nunca uma falha do chat inteiro.
    if (ref.server === IUCLICK_SERVER_NAME && isAuthError(err)) {
      const renewed = await refreshIuclickOnce();
      if (renewed) {
        await stopServer(ref.server);
        await startServer(ref.server);
        return doCall();
      }
      throw new Error(
        'A sessão do ServiceNow (IUClick) expirou e não deu para renovar sozinho pelo navegador. ' +
          'Abra o itau.service-now.com logado e clique em "Detectar" na tela de MCPs. ' +
          `(detalhe: ${err instanceof Error ? err.message : String(err)})`,
      );
    }
    throw err;
  }
}

export async function stopAll(): Promise<void> {
  await Promise.allSettled([...servers.keys()].map((name) => stopServer(name)));
}

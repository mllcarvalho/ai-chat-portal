import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { McpServerEntry, McpServerInfo } from '@aiportal/shared';
import { readJson, writeJsonAtomic } from '../storage/jsonStore';
import { getPortalRoot, mcpStatePath } from '../storage/paths';
import { withTimeout } from '../util';

const START_TIMEOUT = 20_000;
const CALL_TIMEOUT = 120_000;

interface McpToolDef {
  name: string;
  description: string;
  inputSchema?: unknown;
}

interface ServerState {
  entry: McpServerEntry;
  status: McpServerInfo['status'];
  error?: string;
  client?: Client;
  tools: McpToolDef[];
}

interface McpState {
  enabled: Record<string, boolean>;
}

const servers = new Map<string, ServerState>();

function mcpJsonPath(): string | undefined {
  const root = getPortalRoot();
  return root ? path.join(root, '.vscode', 'mcp.json') : undefined;
}

/** Lê <repo>/.vscode/mcp.json no formato padrão do VS Code ({ "servers": {...} }). */
export function readMcpJson(): Record<string, McpServerEntry> {
  const file = mcpJsonPath();
  if (!file) return {};
  const raw = readJson<{ servers?: Record<string, McpServerEntry> }>(file);
  return raw?.servers ?? {};
}

function writeMcpJson(entries: Record<string, McpServerEntry>): void {
  const file = mcpJsonPath();
  if (!file) throw new Error('Abra o repositório do portal no VS Code para gerenciar MCPs');
  writeJsonAtomic(file, { servers: entries });
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

/** Sincroniza o mapa em memória com o mcp.json (para quando o arquivo muda). */
function syncFromDisk(): void {
  const entries = readMcpJson();
  for (const [name, entry] of Object.entries(entries)) {
    const existing = servers.get(name);
    if (!existing) {
      servers.set(name, { entry, status: 'stopped', tools: [] });
    } else if (JSON.stringify(existing.entry) !== JSON.stringify(entry)) {
      // config mudou: derruba para a próxima ligada usar a config nova
      if (existing.status === 'running') void stopServer(name);
      servers.set(name, { entry, status: 'stopped', tools: [] });
    }
  }
  for (const name of [...servers.keys()]) {
    if (!entries[name]) {
      void stopServer(name);
      servers.delete(name);
    }
  }
}

async function connect(name: string, entry: McpServerEntry): Promise<Client> {
  const client = new Client({ name: 'ai-chat-portal', version: '1.0' });
  if (entryType(entry) === 'stdio') {
    if (!entry.command) throw new Error('Servidor stdio sem "command" no mcp.json');
    const transport = new StdioClientTransport({
      command: entry.command,
      args: entry.args ?? [],
      env: { ...getDefaultEnvironment(), ...(entry.env ?? {}) },
      cwd: entry.cwd ?? getPortalRoot(),
      stderr: 'ignore',
    });
    await client.connect(transport);
    return client;
  }
  if (!entry.url) throw new Error('Servidor http sem "url" no mcp.json');
  const url = new URL(entry.url);
  const headers = entry.headers ?? {};
  try {
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
    });
    await client.connect(transport);
    return client;
  } catch {
    // servidores antigos só falam SSE
    const fallback = new Client({ name: 'ai-chat-portal', version: '1.0' });
    const transport = new SSEClientTransport(url, { requestInit: { headers } });
    await fallback.connect(transport);
    return fallback;
  }
}

export async function startServer(name: string): Promise<McpServerInfo> {
  syncFromDisk();
  const state = servers.get(name);
  if (!state) throw new Error(`Servidor MCP "${name}" não está no .vscode/mcp.json`);
  if (state.status === 'running') return toInfo(name, state);

  state.status = 'starting';
  state.error = undefined;
  try {
    const client = await withTimeout(
      connect(name, state.entry),
      START_TIMEOUT,
      undefined,
    );
    if (!client) throw new Error(`Timeout ao iniciar (${START_TIMEOUT / 1000}s)`);
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
  const client = state.client;
  state.client = undefined;
  state.tools = [];
  state.status = 'stopped';
  state.error = undefined;
  if (client) {
    try {
      await client.close();
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
    command: entry.command,
    args: entry.args,
    url: entry.url,
    enabled: readState().enabled[name] ?? false,
    status: state.status,
    error: state.error,
    toolCount: state.tools.length,
    toolNames: state.tools.map((t) => t.name),
  };
}

export function listServers(): McpServerInfo[] {
  syncFromDisk();
  return [...servers.entries()]
    .map(([name, state]) => toInfo(name, state))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function addServer(name: string, entry: McpServerEntry): void {
  const entries = readMcpJson();
  if (entries[name]) throw new Error(`Já existe um servidor chamado "${name}"`);
  entries[name] = entry;
  writeMcpJson(entries);
  syncFromDisk();
}

export async function removeServer(name: string): Promise<void> {
  await stopServer(name);
  const entries = readMcpJson();
  if (!entries[name]) throw new Error(`Servidor MCP "${name}" não encontrado`);
  delete entries[name];
  writeMcpJson(entries);
  const state = readState();
  delete state.enabled[name];
  writeState(state);
  syncFromDisk();
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

export async function callMcpTool(qualifiedName: string, input: object): Promise<string> {
  if (!qualifiedIndex.size) listRunningTools();
  const ref = qualifiedIndex.get(qualifiedName);
  if (!ref) throw new Error(`Ferramenta MCP desconhecida: ${qualifiedName}`);
  const state = servers.get(ref.server);
  if (!state?.client || state.status !== 'running') {
    throw new Error(`O servidor MCP "${ref.server}" está desligado`);
  }
  const result = await withTimeout(
    state.client.callTool({ name: ref.tool, arguments: input as Record<string, unknown> }),
    CALL_TIMEOUT,
    undefined,
  );
  if (!result) throw new Error(`Timeout chamando ${ref.tool} (${CALL_TIMEOUT / 1000}s)`);
  const texts: string[] = [];
  for (const part of (result.content ?? []) as Array<Record<string, unknown>>) {
    if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    else texts.push(JSON.stringify(part));
  }
  if (result.isError) {
    throw new Error(texts.join('\n') || `Erro na ferramenta ${ref.tool}`);
  }
  return texts.join('\n');
}

export async function stopAll(): Promise<void> {
  await Promise.allSettled([...servers.keys()].map((name) => stopServer(name)));
}

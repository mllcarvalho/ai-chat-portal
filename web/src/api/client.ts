import type {
  AgentPreset,
  BmadArtifactsReport,
  BmadStatus,
  Config,
  ConsumerLabStatus,
  CopilotQuota,
  DiagnosticsReport,
  EditorContext,
  FileEntry,
  HealthInfo,
  IuclickStatus,
  KnowledgeBase,
  KnowledgeCollectionSync,
  KnowledgeDoc,
  McpProxyConfig,
  McpServerInfo,
  MicrosoftGraphConfig,
  NetworkConfig,
  MeInfo,
  ModelInfo,
  ProviderId,
  ProviderInfo,
  Project,
  Session,
  SessionMode,
  SharedLibrary,
  SharedLibraryStatus,
  SharedRevision,
  SessionSummary,
  Skill,
  SkillWithContent,
  ToolInfo,
  VsCodeAgent,
} from '@aiportal/shared';
import type {
  BoardOp,
  BoardState,
  CollabIdentity,
  CollabStatus,
  LmChunk,
} from '@aiportal/shared';
import { CLIENT_HEADER, DEFAULT_PORT, PORT_RANGE, TOKEN_HEADER } from '@aiportal/shared';
import { uuid } from '../lib/compat';
import { apiUrl, getServer, isHosted, setServer, viaRelay } from './server';

const TOKEN_KEY = 'aiportal.token';
const CLIENT_ID_KEY = 'aiportal.clientId';

/**
 * Id desta ABA (sessionStorage): identifica a conexão no /api/events e marca a
 * origem das mutações — a aba que causou um evento ignora o próprio eco.
 */
export const clientId: string = (() => {
  try {
    let id = sessionStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = uuid();
      sessionStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  } catch {
    return uuid();
  }
})();

/** Config de proxy MCP enviada ao backend (clientSecret só vai, nunca volta). */
export type McpProxyInput = McpProxyConfig & { clientSecret?: string };

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let lastFailoverProbe = 0;

/**
 * O portal pode migrar de porta quando outra janela do VS Code assume o
 * servidor: se a nossa origem morreu, procura o portal vivo e se redireciona.
 * No portal hospedado a página não muda de lugar: só a base da API é
 * atualizada. Convidado pelo relay não sonda nada — quem migra é o host.
 */
async function maybeFailover(): Promise<void> {
  if (viaRelay()) return;
  const now = Date.now();
  if (now - lastFailoverProbe < 15000) return;
  lastFailoverProbe = now;
  const hosted = isHosted();
  // convidados entram pelo IP da LAN do host: a sondagem procura o portal no
  // MESMO endereço em que a página foi servida, não em 127.0.0.1 fixo
  const current = hosted ? new URL(getServer()) : location;
  const host = current.hostname || '127.0.0.1';
  const ports: number[] = [];
  for (let port = DEFAULT_PORT; port <= DEFAULT_PORT + PORT_RANGE; port++) {
    if (String(port) !== current.port) ports.push(port);
  }
  // sondagem em paralelo: em série eram até ~11s até achar o portal vivo
  const results = await Promise.all(
    ports.map(async (port) => {
      try {
        const res = await fetch(`http://${host}:${port}/api/health`, {
          // de uma origem externa (portal hospedado) só passa com o token
          headers: { [TOKEN_HEADER]: getToken() },
          signal: AbortSignal.timeout(1500),
        });
        if (!res.ok) return undefined;
        const health = (await res.json()) as { version?: unknown };
        return typeof health.version === 'string' ? port : undefined;
      } catch {
        return undefined; // porta sem portal
      }
    }),
  );
  const port = results.find((p) => p !== undefined);
  if (port === undefined) return;
  if (hosted) {
    setServer(`http://${host}:${port}`);
    window.dispatchEvent(new Event('aiportal:server-changed'));
  } else {
    location.replace(`http://${host}:${port}/?token=${encodeURIComponent(getToken())}`);
  }
}

/** Mensagem de "servidor fora" que faz sentido para o modo em que a UI está. */
function unavailableMessage(): string {
  if (viaRelay()) return 'O portal do host está fora do ar — ele precisa estar com o VS Code e o portal abertos.';
  if (isHosted()) {
    return `Não alcancei o portal local em ${getServer()} — confira se o VS Code está aberto e se o navegador permitiu o acesso à rede local.`;
  }
  return 'Servidor do portal indisponível — procurando em outra porta…';
}

async function downloadFromUrl(url: string, fallbackName: string): Promise<void> {
  const res = await fetch(apiUrl(url), { headers: { [TOKEN_HEADER]: getToken() } });
  if (!res.ok) {
    let message = `Erro ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // resposta sem corpo JSON
    }
    throw new ApiError(res.status, message);
  }
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = fallbackName;
  a.click();
  URL.revokeObjectURL(blobUrl);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const doFetch = () =>
    fetch(apiUrl(path), {
      method,
      headers: {
        [TOKEN_HEADER]: getToken(),
        [CLIENT_HEADER]: clientId,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  let res: Response;
  try {
    res = await doFetch();
  } catch {
    // GET é idempotente: uma queda transitória de rede ganha 1 retentativa
    // antes de declarar o servidor fora do ar (mutações não, para não duplicar)
    if (method === 'GET') {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        res = await doFetch();
      } catch {
        void maybeFailover();
        throw new ApiError(0, unavailableMessage());
      }
    } else {
      void maybeFailover();
      throw new ApiError(0, unavailableMessage());
    }
  }
  if (!res.ok) {
    let message = `Erro ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // resposta sem corpo JSON
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => request<HealthInfo>('GET', '/api/health'),
  me: () => request<MeInfo>('GET', '/api/me'),
  warmup: () => request<{ ok: boolean; needsUserAction?: boolean }>('POST', '/api/warmup'),
  models: () => request<ModelInfo[]>('GET', '/api/models'),
  providers: () => request<ProviderInfo[]>('GET', '/api/providers'),

  listSessions: (projectId?: string | null) =>
    request<SessionSummary[]>(
      'GET',
      projectId ? `/api/sessions?projectId=${encodeURIComponent(projectId)}` : '/api/sessions',
    ),
  createSession: (init: {
    title?: string;
    projectId?: string | null;
    mode?: SessionMode;
    /** Motor da conversa; ausente = o primeiro disponível na máquina. */
    provider?: ProviderId;
    agentId?: string;
    modelId?: string;
  }) => request<Session>('POST', '/api/sessions', init),
  getSession: (id: string) => request<Session>('GET', `/api/sessions/${id}`),
  exportSessionMarkdown: (id: string, fileName: string) =>
    downloadFromUrl(`/api/sessions/${id}/export?format=md`, fileName),
  patchSession: (id: string, patch: Partial<Session>) =>
    request<Session>('PATCH', `/api/sessions/${id}`, patch),
  deleteSession: (id: string) => request<{ ok: boolean }>('DELETE', `/api/sessions/${id}`),
  cancelChat: (requestId: string) =>
    request<{ ok: boolean }>('POST', `/api/chat/${requestId}/cancel`),
  cancelChatBySession: (sessionId: string) =>
    request<{ ok: boolean }>('POST', '/api/chat/cancel-by-session', { sessionId }),
  chatActive: (sessionId: string) =>
    request<{ requestId: string | null }>(
      'GET',
      `/api/chat/active?sessionId=${encodeURIComponent(sessionId)}`,
    ),
  chatActiveAll: () => request<{ sessionIds: string[] }>('GET', '/api/chat/active-all'),
  editorContext: () => request<EditorContext>('GET', '/api/editor/context'),
  respondApproval: (requestId: string, callId: string, approved: boolean, alwaysAllow?: string) =>
    request<{ ok: boolean }>('POST', `/api/chat/${requestId}/approval`, {
      callId,
      approved,
      ...(alwaysAllow ? { alwaysAllow } : {}),
    }),
  respondQuestion: (requestId: string, callId: string, answer: string) =>
    request<{ ok: boolean }>('POST', `/api/chat/${requestId}/question`, { callId, answer }),
  // reverte todos os checkpoints a partir de uma mensagem (restore de conversa)
  restoreFiles: (sessionId: string, messageId: string) =>
    request<{ ok: boolean; reverted: number; skipped: number; files: string[] }>(
      'POST',
      `/api/sessions/${sessionId}/restore-files`,
      { messageId },
    ),
  // desfaz uma mutação de ferramenta (botão "Reverter" do ToolCallCard)
  revertCheckpoint: (id: string) =>
    request<{ ok: boolean; message: string; files: string[] }>(
      'POST',
      `/api/checkpoints/${encodeURIComponent(id)}/revert`,
    ),

  // pasta de trabalho da conversa (workspace da sessão avulsa, ou o projeto dela)
  sessionFiles: (id: string) => request<FileEntry[]>('GET', `/api/sessions/${id}/files`),
  sessionFileContent: (id: string, path: string) =>
    request<{ content: string; truncated: boolean }>(
      'GET',
      `/api/sessions/${id}/files/content?path=${encodeURIComponent(path)}`,
    ),
  writeSessionFile: (id: string, path: string, content: string) =>
    request<{ ok: boolean; path: string }>('PUT', `/api/sessions/${id}/files`, { path, content }),
  writeSessionFileBinary: (id: string, path: string, contentBase64: string) =>
    request<{ ok: boolean; path: string }>('PUT', `/api/sessions/${id}/files`, {
      path,
      contentBase64,
    }),
  deleteSessionFile: (id: string, path: string) =>
    request<{ ok: boolean }>(
      'DELETE',
      `/api/sessions/${id}/files?path=${encodeURIComponent(path)}`,
    ),
  downloadSessionFile: (id: string, path: string) =>
    downloadFromUrl(
      `/api/sessions/${id}/files/download?path=${encodeURIComponent(path)}`,
      path.split('/').pop() ?? 'arquivo',
    ),
  revealSessionFile: (id: string, path: string) =>
    request<{ ok: boolean }>('POST', `/api/sessions/${id}/files/reveal`, { path }),
  renameSessionFile: (id: string, path: string, newPath: string) =>
    request<{ ok: boolean; path: string }>('POST', `/api/sessions/${id}/files/rename`, {
      path,
      newPath,
    }),
  createSessionFolder: (id: string, path: string) =>
    request<{ ok: boolean; path: string }>('POST', `/api/sessions/${id}/files/mkdir`, { path }),
  linkSessionFolder: (id: string, kind: 'dir' | 'file' = 'dir') =>
    request<{ ok: boolean; name?: string; cancelled?: boolean }>(
      'POST',
      `/api/sessions/${id}/files/links`,
      { kind },
    ),

  listProjects: () => request<Project[]>('GET', '/api/projects'),
  createProject: (name: string) => request<Project>('POST', '/api/projects', { name }),
  patchProject: (id: string, patch: Partial<Project>) =>
    request<Project>('PATCH', `/api/projects/${id}`, patch),
  deleteProject: (id: string) => request<{ ok: boolean }>('DELETE', `/api/projects/${id}`),
  projectFiles: (id: string) => request<FileEntry[]>('GET', `/api/projects/${id}/files`),
  projectFileContent: (id: string, path: string) =>
    request<{ content: string; truncated: boolean }>(
      'GET',
      `/api/projects/${id}/files/content?path=${encodeURIComponent(path)}`,
    ),
  writeProjectFile: (id: string, path: string, content: string) =>
    request<{ ok: boolean; path: string }>('PUT', `/api/projects/${id}/files`, { path, content }),
  writeProjectFileBinary: (id: string, path: string, contentBase64: string) =>
    request<{ ok: boolean; path: string }>('PUT', `/api/projects/${id}/files`, {
      path,
      contentBase64,
    }),
  deleteProjectFile: (id: string, path: string) =>
    request<{ ok: boolean }>(
      'DELETE',
      `/api/projects/${id}/files?path=${encodeURIComponent(path)}`,
    ),
  downloadProjectFile: (id: string, path: string) =>
    downloadFromUrl(
      `/api/projects/${id}/files/download?path=${encodeURIComponent(path)}`,
      path.split('/').pop() ?? 'arquivo',
    ),
  revealProjectFile: (id: string, path: string) =>
    request<{ ok: boolean }>('POST', `/api/projects/${id}/files/reveal`, { path }),
  renameProjectFile: (id: string, path: string, newPath: string) =>
    request<{ ok: boolean; path: string }>('POST', `/api/projects/${id}/files/rename`, {
      path,
      newPath,
    }),
  createProjectFolder: (id: string, path: string) =>
    request<{ ok: boolean; path: string }>('POST', `/api/projects/${id}/files/mkdir`, { path }),
  linkProjectFolder: (id: string, kind: 'dir' | 'file' = 'dir') =>
    request<{ ok: boolean; name?: string; cancelled?: boolean }>(
      'POST',
      `/api/projects/${id}/files/links`,
      { kind },
    ),
  copilotQuota: (fresh = false) =>
    request<CopilotQuota>('GET', `/api/copilot/quota${fresh ? '?fresh=1' : ''}`),
  bmadStatus: () => request<BmadStatus>('GET', '/api/bmad'),
  bmadInstall: () => request<BmadStatus>('POST', '/api/bmad/install'),
  bmadArtifacts: (projectId: string) =>
    request<BmadArtifactsReport>(
      'GET',
      `/api/bmad/artifacts?projectId=${encodeURIComponent(projectId)}`,
    ),

  listSkills: (projectId?: string) =>
    request<Skill[]>(
      'GET',
      projectId ? `/api/skills?projectId=${encodeURIComponent(projectId)}` : '/api/skills',
    ),
  getSkill: (id: string) => request<SkillWithContent>('GET', `/api/skills/${id}`),
  // name e scope são obrigatórios na rota (400 sem eles) — o tipo reflete o contrato
  createSkill: (
    input: { name: string; scope: 'global' | 'project' | 'shared' } & Partial<SkillWithContent>,
  ) => request<SkillWithContent>('POST', '/api/skills', input),
  patchSkill: (id: string, patch: Partial<SkillWithContent>) =>
    request<SkillWithContent>('PATCH', `/api/skills/${id}`, patch),
  deleteSkill: (id: string) => request<{ ok: boolean }>('DELETE', `/api/skills/${id}`),
  uploadSkillFile: (id: string, path: string, contentBase64: string) =>
    request<SkillWithContent>('POST', `/api/skills/${id}/files`, { path, contentBase64 }),
  downloadSkillExport: (id: string, fileName: string) =>
    downloadFromUrl(`/api/skills/${id}/export`, fileName),
  deleteSkillFile: (id: string, path: string) =>
    request<SkillWithContent>('POST', `/api/skills/${id}/files/delete`, { path }),
  revealSkillFolder: (id: string) => request<{ ok: boolean }>('POST', `/api/skills/${id}/reveal`),

  listAgents: () => request<AgentPreset[]>('GET', '/api/agents'),
  createAgent: (input: Partial<AgentPreset>) => request<AgentPreset>('POST', '/api/agents', input),
  patchAgent: (id: string, patch: Partial<AgentPreset>) =>
    request<AgentPreset>('PATCH', `/api/agents/${id}`, patch),
  deleteAgent: (id: string) => request<{ ok: boolean }>('DELETE', `/api/agents/${id}`),
  exportAgentZip: (id: string, fileName: string) =>
    downloadFromUrl(`/api/agents/${id}/export`, fileName),
  importAgentZip: (zipBase64: string) =>
    request<AgentPreset>('POST', '/api/agents/import', { zipBase64 }),

  listTools: (sessionId?: string) =>
    request<ToolInfo[]>(
      'GET',
      sessionId ? `/api/tools?sessionId=${encodeURIComponent(sessionId)}` : '/api/tools',
    ),
  listMcpServers: () => request<McpServerInfo[]>('GET', '/api/mcp/servers'),
  createMcpServer: (input: {
    name: string;
    type?: 'stdio' | 'http';
    command?: string;
    args?: string[];
    url?: string;
    createProxy?: boolean;
  }) => request<McpServerInfo>('POST', '/api/mcp/servers', input),
  toggleMcpServer: (name: string, enabled: boolean) =>
    request<McpServerInfo>('POST', `/api/mcp/servers/${encodeURIComponent(name)}/toggle`, {
      enabled,
    }),
  restartMcpServer: (name: string) =>
    request<McpServerInfo>('POST', `/api/mcp/servers/${encodeURIComponent(name)}/restart`),
  listMcpServerTools: (name: string) =>
    request<Array<{ name: string; description: string }>>(
      'GET',
      `/api/mcp/servers/${encodeURIComponent(name)}/tools`,
    ),
  deleteMcpServer: (name: string) =>
    request<{ ok: boolean }>('DELETE', `/api/mcp/servers/${encodeURIComponent(name)}`),
  saveMcpProxy: (input: McpProxyInput) =>
    request<McpServerInfo>('POST', '/api/mcp/proxies', input),
  testMcpProxy: (input: McpProxyInput) =>
    request<{ ok: boolean; tools: string[] }>('POST', '/api/mcp/proxies/test', input),
  getConsumerLab: () => request<ConsumerLabStatus>('GET', '/api/mcp/consumerlab'),
  startConsumerLab: (portal?: string) =>
    request<ConsumerLabStatus>('POST', '/api/mcp/consumerlab/setup', portal ? { portal } : undefined),
  chooseConsumerLab: (choice: { accountId?: string; roleName?: string }) =>
    request<ConsumerLabStatus>('POST', '/api/mcp/consumerlab/choose', choice),
  switchConsumerLabSso: () => request<ConsumerLabStatus>('POST', '/api/mcp/consumerlab/switch-sso'),
  cancelConsumerLab: () => request<ConsumerLabStatus>('POST', '/api/mcp/consumerlab/cancel'),
  getIuclick: () => request<IuclickStatus>('GET', '/api/mcp/iuclick'),
  startIuclick: (creds?: { cookies?: string; token?: string }) =>
    request<IuclickStatus>('POST', '/api/mcp/iuclick/setup', creds ?? {}),
  cancelIuclick: () => request<IuclickStatus>('POST', '/api/mcp/iuclick/cancel'),
  purgeIuclick: () => request<{ ok: boolean; message: string }>('POST', '/api/mcp/iuclick/purge'),
  reauthIuclick: (creds: { cookies: string; token: string }) =>
    request<{ ok: boolean; message: string }>('POST', '/api/mcp/iuclick/credentials', creds),
  autodetectIuclick: (via?: 'browser') =>
    request<{ ok: boolean; message: string }>('POST', '/api/mcp/iuclick/autodetect', via ? { via } : {}),
  setupGitHubMcp: () => request<McpServerInfo>('POST', '/api/mcp/github/setup'),

  listVsCodeAgents: () => request<VsCodeAgent[]>('GET', '/api/vscode-agents'),

  listKnowledge: (projectId?: string) =>
    request<KnowledgeBase[]>(
      'GET',
      projectId ? `/api/knowledge?projectId=${encodeURIComponent(projectId)}` : '/api/knowledge',
    ),
  createKnowledgeBase: (input: {
    name: string;
    description?: string;
    scope: 'global' | 'project' | 'shared';
    projectId?: string;
    libraryId?: string;
  }) => request<KnowledgeBase>('POST', '/api/knowledge', input),
  patchKnowledgeBase: (
    id: string,
    patch: {
      name?: string;
      description?: string;
      enabled?: boolean;
      /** Trocar o escopo MOVE a base (ex.: levá-la para uma biblioteca compartilhada). */
      scope?: 'global' | 'project' | 'shared';
      projectId?: string;
      libraryId?: string;
    },
  ) => request<KnowledgeBase>('PATCH', `/api/knowledge/${id}`, patch),
  deleteKnowledgeBase: (id: string) => request<{ ok: boolean }>('DELETE', `/api/knowledge/${id}`),
  listKnowledgeDocs: (id: string) => request<KnowledgeDoc[]>('GET', `/api/knowledge/${id}/docs`),
  readKnowledgeDoc: (id: string, name: string) =>
    request<{ name: string; content: string }>(
      'GET',
      `/api/knowledge/${id}/docs/content?name=${encodeURIComponent(name)}`,
    ),
  writeKnowledgeDoc: (id: string, name: string, content: string) =>
    request<KnowledgeDoc>('PUT', `/api/knowledge/${id}/docs`, { name, content }),
  /** Sobe o arquivo ORIGINAL (PDF/Word/Excel/PPT); o portal converte o texto sozinho. */
  uploadKnowledgeDoc: (id: string, name: string, contentBase64: string) =>
    request<KnowledgeDoc>('PUT', `/api/knowledge/${id}/docs`, { name, contentBase64 }),
  downloadKnowledgeDoc: (id: string, name: string) =>
    downloadFromUrl(
      `/api/knowledge/${id}/docs/raw?name=${encodeURIComponent(name)}`,
      name,
    ),
  deleteKnowledgeDoc: (id: string, name: string) =>
    request<{ ok: boolean }>('DELETE', `/api/knowledge/${id}/docs/${encodeURIComponent(name)}`),
  moveKnowledgeDoc: (id: string, name: string, toBaseId: string) =>
    request<KnowledgeDoc>('POST', `/api/knowledge/${id}/docs/move`, { name, toBaseId }),
  exportKnowledgeBase: (id: string, fileName: string) =>
    downloadFromUrl(`/api/knowledge/${id}/export`, fileName),
  importKnowledgeBase: (
    zipBase64: string,
    input: {
      name?: string;
      scope: 'global' | 'project' | 'shared';
      projectId?: string;
      libraryId?: string;
    },
  ) => request<KnowledgeBase>('POST', '/api/knowledge/import', { zipBase64, ...input }),
  addRemoteKnowledgeDoc: (id: string, url: string, name?: string) =>
    request<KnowledgeDoc>('POST', `/api/knowledge/${id}/docs/remote`, { url, name }),
  syncKnowledgeDocs: (id: string, name?: string) =>
    request<{ docs: KnowledgeDoc[]; errors: { name: string; error: string }[] }>(
      'POST',
      `/api/knowledge/${id}/sync`,
      name ? { name } : {},
    ),
  /** Varre um site inteiro para dentro da base: as páginas viram um grupo. */
  crawlKnowledgeSite: (id: string, url: string, opts?: { maxPages?: number; depth?: number }) =>
    request<KnowledgeCollectionSync>('POST', `/api/knowledge/${id}/collections`, { url, ...opts }),
  syncKnowledgeCollection: (id: string, collectionId: string) =>
    request<KnowledgeCollectionSync>(
      'POST',
      `/api/knowledge/${id}/collections/${collectionId}/sync`,
    ),
  deleteKnowledgeCollection: (id: string, collectionId: string, keepDocs = false) =>
    request<{ ok: boolean }>(
      'DELETE',
      `/api/knowledge/${id}/collections/${collectionId}?keepDocs=${keepDocs}`,
    ),

  loginStatus: () =>
    request<{ username?: string; configured: boolean; proxyHost: string }>('GET', '/api/login'),
  login: (username: string, password: string) =>
    request<{ ok: boolean; username: string; proxyHost: string; rcFiles: string[] }>(
      'POST',
      '/api/login',
      { username, password },
    ),

  shareByEmail: (kind: 'agent' | 'skill' | 'knowledge' | 'session', id: string) =>
    request<{ ok: boolean; mode: 'outlook' | 'mail' | 'xdg' | 'manual'; file: string }>(
      'POST',
      '/api/share/email',
      { kind, id },
    ),

  // prompts/resources dos servidores MCP ligados (paridade com o Copilot)
  listMcpPrompts: () =>
    request<{
      prompts: Array<{
        server: string;
        name: string;
        title?: string;
        description: string;
        args: Array<{ name: string; required: boolean; description?: string }>;
      }>;
    }>('GET', '/api/mcp/prompts'),
  getMcpPrompt: (server: string, name: string, args?: Record<string, string>) =>
    request<{ text: string }>('POST', '/api/mcp/prompts/get', { server, name, args }),
  listMcpResources: () =>
    request<{
      resources: Array<{ server: string; uri: string; name: string; description?: string }>;
    }>('GET', '/api/mcp/resources'),
  readMcpResource: (server: string, uri: string) =>
    request<{ content: string }>('POST', '/api/mcp/resources/read', { server, uri }),

  getDiagnostics: () => request<DiagnosticsReport>('GET', '/api/diagnostics'),
  runDiagnostics: () => request<DiagnosticsReport>('POST', '/api/diagnostics/run'),
  supportReport: () => request<{ text: string }>('GET', '/api/diagnostics/support-report'),
  fixDiagnostic: (id: string) =>
    request<{ ok: boolean; message: string; report: DiagnosticsReport }>(
      'POST',
      '/api/diagnostics/fix',
      { id },
    ),

  listSharedLibraries: () => request<SharedLibraryStatus[]>('GET', '/api/shared-libraries'),
  saveSharedLibraries: (libraries: Array<Partial<SharedLibrary>>) =>
    request<SharedLibraryStatus[]>('PUT', '/api/shared-libraries', { libraries }),
  /** Abre o seletor de pastas na janela do VS Code (caminho de rede também pode ser digitado). */
  pickSharedLibraryFolder: () =>
    request<{ ok: boolean; path?: string; cancelled?: boolean }>(
      'POST',
      '/api/shared-libraries/pick',
      {},
    ),

  /** Hash das pastas compartilhadas por tipo — muda quando outra pessoa mexe. */
  sharedRevision: () => request<SharedRevision>('GET', '/api/shared-libraries/revision'),
  // colaboração (multiplayer)
  collabMe: () => request<CollabIdentity>('GET', '/api/collab/me'),
  collabStatus: () => request<CollabStatus>('GET', '/api/collab'),
  patchCollab: (patch: { enabled?: boolean; hostName?: string }) =>
    request<CollabStatus & { restarting?: boolean }>('PATCH', '/api/collab', patch),
  addCollabGuest: (name: string) =>
    request<CollabStatus>('POST', '/api/collab/guests', { name }),
  revokeCollabGuest: (id: string, purge = false) =>
    request<CollabStatus>('DELETE', `/api/collab/guests/${id}${purge ? '?purge=1' : ''}`),
  setViewing: (viewing: { sessionId?: string; projectId?: string; board?: boolean }) =>
    request<{ ok: boolean }>('POST', '/api/events/viewing', { clientId, ...viewing }),
  sendBoardCursor: (projectId: string, x: number, y: number, active: boolean) =>
    request<{ ok: boolean }>('POST', '/api/events/cursor', { clientId, projectId, x, y, active }),
  setCapability: (canExecute: boolean) =>
    request<{ ok: boolean }>('POST', '/api/events/capability', { clientId, canExecute }),

  // federação de licenças
  getExecutor: (sessionId: string) =>
    request<{ executorClientId: string | null; executorName: string | null }>(
      'GET',
      `/api/collab/executor?sessionId=${encodeURIComponent(sessionId)}`,
    ),
  setExecutor: (sessionId: string, executorClientId: string | null) =>
    request<{ ok: boolean }>('POST', '/api/collab/executor', { sessionId, executorClientId }),
  /** Host recebe um pedaço do stream remoto (a aba do executor relaia). */
  postLmChunk: (jobId: string, chunk: LmChunk) =>
    request<{ ok: boolean }>('POST', `/api/lm/${jobId}/chunk`, chunk),

  // quadro colaborativo do projeto
  getBoard: (projectId: string) => request<BoardState>('GET', `/api/projects/${projectId}/board`),
  postBoardOps: (projectId: string, ops: BoardOp[]) =>
    request<{ revision: number }>('POST', `/api/projects/${projectId}/board/ops`, { ops }),

  getConfig: () => request<Omit<Config, 'token'>>('GET', '/api/config'),
  patchConfig: (patch: {
    projectsRoot?: string;
    network?: NetworkConfig;
    microsoft?: MicrosoftGraphConfig;
    commandAllowlist?: string[];
    /** '' volta ao automático. */
    captureBrowser?: string;
    /** '' desliga (a extensão volta a servir a UI). */
    hostedPortalUrl?: string;
  }) => request<Omit<Config, 'token'>>('PATCH', '/api/config', patch),
};

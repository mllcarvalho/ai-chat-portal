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
  KnowledgeDoc,
  McpProxyConfig,
  McpServerInfo,
  MicrosoftGraphConfig,
  NetworkConfig,
  MeInfo,
  ModelInfo,
  Project,
  Session,
  SessionMode,
  SessionSummary,
  Skill,
  SkillWithContent,
  ToolInfo,
  VsCodeAgent,
} from '@aiportal/shared';
import { DEFAULT_PORT, PORT_RANGE, TOKEN_HEADER } from '@aiportal/shared';

const TOKEN_KEY = 'aiportal.token';

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
 */
async function maybeFailover(): Promise<void> {
  const now = Date.now();
  if (now - lastFailoverProbe < 15000) return;
  lastFailoverProbe = now;
  const ports: number[] = [];
  for (let port = DEFAULT_PORT; port <= DEFAULT_PORT + PORT_RANGE; port++) {
    if (String(port) !== location.port) ports.push(port);
  }
  // sondagem em paralelo: em série eram até ~11s até achar o portal vivo
  const results = await Promise.all(
    ports.map(async (port) => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
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
  if (port !== undefined) {
    location.replace(`http://127.0.0.1:${port}/?token=${encodeURIComponent(getToken())}`);
  }
}

async function downloadFromUrl(url: string, fallbackName: string): Promise<void> {
  const res = await fetch(url, { headers: { [TOKEN_HEADER]: getToken() } });
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
    fetch(path, {
      method,
      headers: {
        [TOKEN_HEADER]: getToken(),
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
        throw new ApiError(0, 'Servidor do portal indisponível — procurando em outra porta…');
      }
    } else {
      void maybeFailover();
      throw new ApiError(0, 'Servidor do portal indisponível — procurando em outra porta…');
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

  listSessions: (projectId?: string | null) =>
    request<SessionSummary[]>(
      'GET',
      projectId ? `/api/sessions?projectId=${encodeURIComponent(projectId)}` : '/api/sessions',
    ),
  createSession: (init: {
    title?: string;
    projectId?: string | null;
    mode?: SessionMode;
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
  respondApproval: (requestId: string, callId: string, approved: boolean) =>
    request<{ ok: boolean }>('POST', `/api/chat/${requestId}/approval`, { callId, approved }),
  respondQuestion: (requestId: string, callId: string, answer: string) =>
    request<{ ok: boolean }>('POST', `/api/chat/${requestId}/question`, { callId, answer }),
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
  linkSessionFolder: (id: string) =>
    request<{ ok: boolean; name?: string; cancelled?: boolean }>(
      'POST',
      `/api/sessions/${id}/files/links`,
      {},
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
  linkProjectFolder: (id: string) =>
    request<{ ok: boolean; name?: string; cancelled?: boolean }>(
      'POST',
      `/api/projects/${id}/files/links`,
      {},
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
    input: { name: string; scope: 'global' | 'project' } & Partial<SkillWithContent>,
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
  autodetectIuclick: () =>
    request<{ ok: boolean; message: string }>('POST', '/api/mcp/iuclick/autodetect'),
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
    scope: 'global' | 'project';
    projectId?: string;
  }) => request<KnowledgeBase>('POST', '/api/knowledge', input),
  patchKnowledgeBase: (id: string, patch: { name?: string; description?: string; enabled?: boolean }) =>
    request<KnowledgeBase>('PATCH', `/api/knowledge/${id}`, patch),
  deleteKnowledgeBase: (id: string) => request<{ ok: boolean }>('DELETE', `/api/knowledge/${id}`),
  listKnowledgeDocs: (id: string) => request<KnowledgeDoc[]>('GET', `/api/knowledge/${id}/docs`),
  readKnowledgeDoc: (id: string, name: string) =>
    request<{ name: string; content: string }>(
      'GET',
      `/api/knowledge/${id}/docs/content?name=${encodeURIComponent(name)}`,
    ),
  writeKnowledgeDoc: (id: string, name: string, content: string) =>
    request<KnowledgeDoc>('PUT', `/api/knowledge/${id}/docs`, { name, content }),
  deleteKnowledgeDoc: (id: string, name: string) =>
    request<{ ok: boolean }>('DELETE', `/api/knowledge/${id}/docs/${encodeURIComponent(name)}`),
  moveKnowledgeDoc: (id: string, name: string, toBaseId: string) =>
    request<KnowledgeDoc>('POST', `/api/knowledge/${id}/docs/move`, { name, toBaseId }),
  exportKnowledgeBase: (id: string, fileName: string) =>
    downloadFromUrl(`/api/knowledge/${id}/export`, fileName),
  importKnowledgeBase: (
    zipBase64: string,
    input: { name?: string; scope: 'global' | 'project'; projectId?: string },
  ) => request<KnowledgeBase>('POST', '/api/knowledge/import', { zipBase64, ...input }),
  addRemoteKnowledgeDoc: (id: string, url: string, name?: string) =>
    request<KnowledgeDoc>('POST', `/api/knowledge/${id}/docs/remote`, { url, name }),
  syncKnowledgeDocs: (id: string, name?: string) =>
    request<{ docs: KnowledgeDoc[]; errors: { name: string; error: string }[] }>(
      'POST',
      `/api/knowledge/${id}/sync`,
      name ? { name } : {},
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

  getDiagnostics: () => request<DiagnosticsReport>('GET', '/api/diagnostics'),
  runDiagnostics: () => request<DiagnosticsReport>('POST', '/api/diagnostics/run'),
  fixDiagnostic: (id: string) =>
    request<{ ok: boolean; message: string; report: DiagnosticsReport }>(
      'POST',
      '/api/diagnostics/fix',
      { id },
    ),

  getConfig: () => request<Omit<Config, 'token'>>('GET', '/api/config'),
  patchConfig: (patch: {
    projectsRoot?: string;
    network?: NetworkConfig;
    microsoft?: MicrosoftGraphConfig;
  }) => request<Omit<Config, 'token'>>('PATCH', '/api/config', patch),
};

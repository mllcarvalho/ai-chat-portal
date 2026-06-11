import type {
  AgentPreset,
  Config,
  FileEntry,
  HealthInfo,
  McpServerConfig,
  MeInfo,
  ModelInfo,
  Project,
  Session,
  SessionMode,
  SessionSummary,
  Skill,
  SkillWithContent,
  ToolInfo,
} from '@aiportal/shared';
import { TOKEN_HEADER } from '@aiportal/shared';

const TOKEN_KEY = 'aiportal.token';

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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      [TOKEN_HEADER]: getToken(),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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
  patchSession: (id: string, patch: Partial<Session>) =>
    request<Session>('PATCH', `/api/sessions/${id}`, patch),
  deleteSession: (id: string) => request<{ ok: boolean }>('DELETE', `/api/sessions/${id}`),
  cancelChat: (requestId: string) =>
    request<{ ok: boolean }>('POST', `/api/chat/${requestId}/cancel`),

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

  listSkills: (projectId?: string) =>
    request<Skill[]>(
      'GET',
      projectId ? `/api/skills?projectId=${encodeURIComponent(projectId)}` : '/api/skills',
    ),
  getSkill: (id: string) => request<SkillWithContent>('GET', `/api/skills/${id}`),
  createSkill: (input: Partial<SkillWithContent>) =>
    request<SkillWithContent>('POST', '/api/skills', input),
  patchSkill: (id: string, patch: Partial<SkillWithContent>) =>
    request<SkillWithContent>('PATCH', `/api/skills/${id}`, patch),
  deleteSkill: (id: string) => request<{ ok: boolean }>('DELETE', `/api/skills/${id}`),

  listAgents: () => request<AgentPreset[]>('GET', '/api/agents'),
  createAgent: (input: Partial<AgentPreset>) => request<AgentPreset>('POST', '/api/agents', input),
  patchAgent: (id: string, patch: Partial<AgentPreset>) =>
    request<AgentPreset>('PATCH', `/api/agents/${id}`, patch),
  deleteAgent: (id: string) => request<{ ok: boolean }>('DELETE', `/api/agents/${id}`),

  listTools: (sessionId?: string) =>
    request<ToolInfo[]>(
      'GET',
      sessionId ? `/api/tools?sessionId=${encodeURIComponent(sessionId)}` : '/api/tools',
    ),
  refreshTools: () => request<{ ok: boolean }>('POST', '/api/tools/refresh'),
  listMcpServers: () => request<McpServerConfig[]>('GET', '/api/mcp/servers'),
  createMcpServer: (input: Partial<McpServerConfig>) =>
    request<McpServerConfig>('POST', '/api/mcp/servers', input),
  deleteMcpServer: (id: string) => request<{ ok: boolean }>('DELETE', `/api/mcp/servers/${id}`),

  getConfig: () => request<Omit<Config, 'token'>>('GET', '/api/config'),
  patchConfig: (patch: { projectsRoot?: string }) =>
    request<Omit<Config, 'token'>>('PATCH', '/api/config', patch),
};

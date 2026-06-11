/** Modo de operação da sessão, equivalente aos modos do Copilot. */
export type SessionMode = 'ask' | 'plan' | 'agent';

export interface Config {
  version: 1;
  /** Porta preferida do servidor (default 4717; pode subir em 4718-4727 se ocupada). */
  port: number;
  /** Token de acesso à API local, gerado uma vez. */
  token: string;
  /** Raiz onde as pastas dos projetos são criadas. */
  projectsRoot: string;
  /** Origens extras liberadas no CORS (ex.: http://localhost:5173 em dev). */
  devOrigins?: string[];
}

/** Escrito em ~/AIChatPortal/runtime.json enquanto o servidor está de pé. */
export interface RuntimeInfo {
  port: number;
  portalUrl: string;
  pid: number;
  startedAt: string;
  version: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  family: string;
  vendor: string;
  version: string;
  maxInputTokens: number;
  /** Se o consentimento do Copilot já foi dado para este modelo (undefined = desconhecido). */
  canSend?: boolean;
}

export interface MeInfo {
  login: string;
  label: string;
  avatarUrl: string;
}

export interface HealthInfo {
  ok: boolean;
  version: string;
  copilotChatInstalled: boolean;
  modelCount: number;
  account?: { id: string; label: string };
  needsConsent: boolean;
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; callId: string; toolName: string; input: unknown }
  | {
      type: 'tool_result';
      callId: string;
      toolName: string;
      ok: boolean;
      content: string;
      durationMs: number;
    };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: MessagePart[];
  /** Modelo que gerou a resposta (mensagens assistant). */
  modelId?: string;
  createdAt: string;
  error?: { code: string; message: string };
}

export interface Session {
  id: string;
  title: string;
  /** null = sessão avulsa, fora de qualquer projeto. */
  projectId: string | null;
  mode: SessionMode;
  modelId?: string;
  agentId?: string;
  activeSkillIds: string[];
  /** null = todas as ferramentas habilitadas. */
  enabledTools: string[] | null;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export type SessionSummary = Omit<Session, 'messages' | 'activeSkillIds' | 'enabledTools'> & {
  messageCount: number;
};

export interface Project {
  id: string;
  name: string;
  /** Nome da pasta no disco (slug do name). */
  dirName: string;
  instructions?: string;
  defaultAgentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Skill {
  id: string;
  /** instruction = injetada no contexto; command = slash command com template. */
  kind: 'instruction' | 'command';
  scope: 'global' | 'project';
  projectId?: string;
  name: string;
  description: string;
  /** Nome do slash command (sem a barra), só para kind 'command'. */
  command?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillWithContent extends Skill {
  /** Markdown da instrução ou template do comando ({{input}} é substituído). */
  content: string;
}

export interface AgentPreset {
  id: string;
  name: string;
  description?: string;
  /** Emoji exibido na UI. */
  icon?: string;
  instructions: string;
  defaultModelId?: string;
  defaultMode?: SessionMode;
  /** null/ausente = todas as ferramentas. */
  enabledTools?: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  inputSchema?: unknown;
  source: 'builtin' | 'mcp';
  serverLabel?: string;
  enabled: boolean;
}

/** Entrada de servidor no .vscode/mcp.json (formato padrão do VS Code). */
export interface McpServerEntry {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

/** Estado de um servidor MCP gerenciado pelo portal. */
export interface McpServerInfo {
  name: string;
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  /** Persistido: religa sozinho quando o portal sobe. */
  enabled: boolean;
  status: 'stopped' | 'starting' | 'running' | 'error';
  error?: string;
  toolCount: number;
  toolNames: string[];
}

/** Agente (chat mode) encontrado no VS Code — importável como AgentPreset. */
export interface VsCodeAgent {
  id: string;
  name: string;
  description?: string;
  instructions: string;
  source: 'project' | 'user';
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;
  scope: 'global' | 'project';
  projectId?: string;
  /** Bases habilitadas entram no contexto das conversas (global: todas; project: as do projeto). */
  enabled: boolean;
  docCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDoc {
  name: string;
  size: number;
  mtime: string;
}

export interface FileEntry {
  name: string;
  /** Caminho relativo à raiz do projeto. */
  path: string;
  type: 'file' | 'dir';
  size: number;
  mtime: string;
  children?: FileEntry[];
}

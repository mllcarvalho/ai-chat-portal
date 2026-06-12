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
  /** Modelo premium: desconta AI credits por requisição (undefined = desconhecido). */
  premium?: boolean;
  /** AI credits descontados por requisição (multiplicador de premium request). */
  multiplier?: number;
  /** Faixa de preço do model picker ("high"/"medium"/...), quando a API não dá o multiplicador. */
  priceCategory?: string;
}

export interface MeInfo {
  login: string;
  label: string;
  avatarUrl: string;
}

/** Dependências externas detectadas na inicialização (null = não encontrada). */
export interface EnvStatus {
  /** Versão do Node no PATH (obrigatório para BMAD e MCPs stdio). */
  node: string | null;
  /** Shell usado pelo portal_run_command: caminho no Windows (Git Bash), label no Mac/Linux. */
  bash: string | null;
  /** Comando python disponível (ex: "python3 3.12.4"); null = comandos python serão pulados. */
  python: string | null;
}

export interface HealthInfo {
  ok: boolean;
  version: string;
  /** Identifica o build carregado (mtime do bundle); usado na eleição entre janelas. */
  buildId?: number;
  /** Se a janela que serve tem o repo do portal aberto (dados em portal-data/). */
  hasPortalRoot?: boolean;
  copilotChatInstalled: boolean;
  modelCount: number;
  account?: { id: string; label: string };
  needsConsent: boolean;
  env?: EnvStatus;
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'attachment'; name: string; content: string }
  | { type: 'tool_call'; callId: string; toolName: string; input: unknown }
  | {
      type: 'tool_result';
      callId: string;
      toolName: string;
      ok: boolean;
      content: string;
      durationMs: number;
    };

/** Consumo de tokens de uma resposta (mensagens assistant). */
export interface TokenUsage {
  /** Tokens enviados ao modelo, somados em todas as rodadas da resposta. */
  inputTokens: number;
  /** Tokens gerados pelo modelo (texto + tool calls). */
  outputTokens: number;
  /** Nº de requisições ao Copilot (1 por rodada de ferramentas). */
  requests: number;
  /**
   * AI credits realmente cobrados nesta resposta: delta dos credits restantes
   * da licença entre o início e o fim da mensagem (undefined = não medido,
   * ex.: plano ilimitado, modelo incluído ou atraso na contabilização).
   */
  credits?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: MessagePart[];
  /** Modelo que gerou a resposta (mensagens assistant). */
  modelId?: string;
  usage?: TokenUsage;
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
  /** Arquivos do projeto fixados no contexto (caminhos relativos à raiz). */
  contextFiles?: string[];
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
  /** @deprecated Legado: toda skill vale como instrução E como comando. Ignorado. */
  kind?: 'instruction' | 'command';
  scope: 'global' | 'project';
  projectId?: string;
  name: string;
  description: string;
  /** Nome do slash command (sem a barra). Derivado do nome quando não informado. */
  command?: string;
  createdAt: string;
  updatedAt: string;
}

/** Slug de comando slash a partir do nome da skill (ex: "Tom executivo" → "tom-executivo"). */
export function slugifyCommand(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'skill';
}

export interface SkillWithContent extends Skill {
  /** Markdown da instrução ou template do comando ({{input}} é substituído). */
  content: string;
}

/** Prefixo dos ids de skills/agentes registrados pela integração BMAD. */
export const BMAD_ASSET_PREFIX = 'bmad-global-';

/** Skill/agente registrado automaticamente pela integração BMAD (não criado pelo usuário). */
export function isBmadAsset(id: string): boolean {
  return id.startsWith(BMAD_ASSET_PREFIX);
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

/** Persona BMAD registrada como preset de agente. */
export interface BmadAgentInfo {
  presetId: string;
  name: string;
  description?: string;
  icon?: string;
}

/** Estado da instalação BMAD de um projeto. */
export interface BmadStatus {
  installed: boolean;
  installing: boolean;
  error?: string;
  agents: BmadAgentInfo[];
  /** Skills de workflow (/bmad-*) registradas no projeto. */
  skillCount: number;
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

/** Snapshot dos AI credits (premium requests) da licença Copilot do usuário. */
export interface CopilotQuota {
  plan?: string;
  /** Data em que a cota renova (YYYY-MM-DD). */
  resetDate?: string;
  premium?: {
    entitlement: number;
    remaining: number;
    percentRemaining: number;
    unlimited: boolean;
    overageCount: number;
    overagePermitted: boolean;
  };
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

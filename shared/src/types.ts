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
  /** Rede corporativa para as conexões dos proxies MCP (proxy/CA). */
  network?: NetworkConfig;
  /** Autenticação Microsoft para ler SharePoint via Graph. */
  microsoft?: MicrosoftGraphConfig;
  /** Último usuário RACF informado no login (a senha nunca é persistida). */
  racfUser?: string;
}

/**
 * App do Entra ID usado no login Microsoft (SharePoint). Obrigatório: a
 * Microsoft não pré-autoriza o client ID do próprio VS Code a pedir escopos
 * de SharePoint no Graph (erro AADSTS65002), então o login só funciona com um
 * app registrado no tenant.
 */
export interface MicrosoftGraphConfig {
  /** Application (client) ID do app registrado no Entra ID. */
  clientId?: string;
  /** Tenant: 'organizations' (default), 'common' ou o ID/domínio do tenant. */
  tenant?: string;
}

/** Proxy e CA corporativos usados nas conexões dos proxies MCP (token + gateway). */
export interface NetworkConfig {
  /** Ex.: http://proxy.empresa:8080 — usado para hosts HTTPS/HTTP. */
  httpsProxy?: string;
  /** HTTP_PROXY dos rc/env — normalmente o mesmo valor do httpsProxy. */
  httpProxy?: string;
  /** Lista separada por vírgula de hosts que NÃO passam pelo proxy. */
  noProxy?: string;
  /** Caminho de um arquivo PEM com a(s) CA(s) internas (NODE_EXTRA_CA_CERTS). */
  extraCaCerts?: string;
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
  /** Id de origem quando criada por import — reimports atualizam em vez de duplicar. */
  importedFrom?: string;
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
  /**
   * Anexos da pasta da skill (referências, templates…), como caminhos
   * relativos. O modelo os lê com a ferramenta portal_read_skill_file.
   */
  files?: string[];
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
  /**
   * Agente disponível para uso (ausente = habilitado). Desabilitado some dos
   * seletores mas continua gerenciável nas Configurações (usado pelos BMAD).
   */
  enabled?: boolean;
  /**
   * Skills vinculadas (aditivo, nunca restringe): garantidas no catálogo das
   * conversas do agente e incluídas no export.
   */
  skillIds?: string[];
  /**
   * Bases vinculadas (aditivo): entram no contexto das conversas do agente
   * mesmo desativadas no toggle geral, e são incluídas no export.
   */
  knowledgeBaseIds?: string[];
  /** Id de origem quando criado por import — reimports atualizam em vez de duplicar. */
  importedFrom?: string;
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

/**
 * Config de um proxy MCP via OAuth2 client_credentials: o portal obtém um
 * access_token no tokenUrl e conecta no gateway remoto (Streamable HTTP) com
 * Bearer. O client_secret nunca trafega de volta ao front e é guardado no
 * SecretStorage do VS Code (cifrado em repouso) — por isso não aparece aqui.
 */
export interface McpProxyConfig {
  name: string;
  tokenUrl: string;
  gatewayUrl: string;
  clientId: string;
  scope?: string;
}

/** Estado de um servidor MCP gerenciado pelo portal. */
export interface McpServerInfo {
  name: string;
  type: 'stdio' | 'http';
  /** Origem da config: servidor do mcp.json ou proxy OAuth2 do portal. */
  kind: 'mcpjson' | 'proxy';
  command?: string;
  args?: string[];
  url?: string;
  /** Config do proxy (sem o secret), para exibir/pré-preencher edição. */
  proxy?: McpProxyConfig;
  /** Persistido: religa sozinho quando o portal sobe. */
  enabled: boolean;
  status: 'stopped' | 'starting' | 'running' | 'error';
  error?: string;
  toolCount: number;
  toolNames: string[];
}

/** Conta AWS visível no SSO durante o setup do ConsumerLab. */
export interface ConsumerLabAccount {
  id: string;
  name: string;
}

/**
 * Conta/role do último setup concluído do ConsumerLab — persistida em disco
 * para a UI mostrar "qual conta está conectada" mesmo depois de reiniciar o
 * VS Code (o estado do setup em si é só em memória).
 */
export interface ConsumerLabConnection {
  accountId: string;
  accountName: string;
  role: string;
  /** Portal SSO onde a conta mora (ex: "Landing Zone (itaulzprod)"). */
  ssoPortal: string;
  /** Profile AWS gravado no ~/.aws/config (ex: 872813764471_CONSUMER). */
  profile: string;
  connectedAt: string;
}

/**
 * Setup guiado do MCP ConsumerLab (Itaú): o portal verifica pré-requisitos,
 * clona o repositório do servidor, instala dependências (uv sync), faz o
 * login SSO na AWS e registra o servidor stdio — replicando o setup.sh usado
 * no fluxo manual do VS Code. As fases `awaiting-*` pausam esperando uma
 * escolha do usuário na UI (conta e, quando houver mais de uma, role).
 */
export interface ConsumerLabStatus {
  running: boolean;
  phase:
    | 'idle'
    | 'prereqs'
    | 'repo'
    | 'repo-auth'
    | 'deps'
    | 'sso-login'
    | 'accounts'
    | 'awaiting-account'
    | 'roles'
    | 'awaiting-role'
    | 'profile'
    | 'register'
    | 'done'
    | 'error';
  /** Rótulo humano da fase atual, para a UI exibir sem switch próprio. */
  phaseLabel: string;
  /** Cauda do log acumulado dos comandos (estilo instalador do BMAD). */
  log: string;
  error?: string;
  /** Portal SSO usado na rodada atual (ex: "Landing Zone (itaulzprod)"). */
  ssoPortal?: string;
  /** Outro portal SSO disponível para tentar quando a conta não aparece na lista. */
  altSsoPortal?: string;
  /** Preenchido na fase awaiting-account (já filtrado por "consumer" quando possível). */
  accounts?: ConsumerLabAccount[];
  /** Preenchido na fase awaiting-role. */
  roles?: string[];
  /** Profile AWS resultante (ex: 872813764471_CONSUMER). */
  profile?: string;
  repoPath?: string;
  /** Conta/role do último setup concluído (sobrevive ao restart da extensão). */
  connection?: ConsumerLabConnection;
}

/**
 * Setup guiado do MCP IUClick (ServiceNow Itaú): o portal verifica Node/npx,
 * grava o registry privado do Itaú no ~/.npmrc, valida o pacote
 * @ai-stack-fn7/mcp-servers no Artifactory e registra o servidor stdio
 * (npx … service-now --stdio). Cookie e X-UserToken são opcionais: quando
 * informados ficam no SecretStorage e entram como env na subida do servidor;
 * sem eles a autenticação é feita pela tool `login` na própria sessão.
 */
export interface IuclickStatus {
  running: boolean;
  phase: 'idle' | 'prereqs' | 'registry' | 'package' | 'register' | 'done' | 'error';
  /** Rótulo humano da fase atual, para a UI exibir sem switch próprio. */
  phaseLabel: string;
  /** Cauda do log acumulado dos comandos (estilo instalador do BMAD). */
  log: string;
  error?: string;
  /** Há Cookie/X-UserToken guardados de um setup anterior. */
  hasCredentials?: boolean;
  /** O servidor já está registrado no mcp.json (setup concluído ao menos uma vez). */
  installed?: boolean;
}

/** Estado de uma verificação do Diagnóstico do ambiente. */
export type DiagnosticStatus = 'pending' | 'running' | 'ok' | 'warn' | 'fail';

/**
 * Uma verificação da tela de Diagnóstico: ferramenta instalada, configuração
 * de rede aplicada ou teste de conectividade. `fail` interrompe (banner);
 * `warn` só aparece na página (limita funcionalidades, não bloqueia o portal).
 */
export interface DiagnosticCheck {
  id: string;
  label: string;
  status: DiagnosticStatus;
  /** O que foi detectado (versão, valor configurado…). */
  detail?: string;
  /** O que fazer para regularizar, quando não está ok. */
  hint?: string;
  /** Correção automática disponível (POST /api/diagnostics/fix). */
  fixId?: string;
  fixLabel?: string;
}

/**
 * Diagnóstico do ambiente da máquina: roda em background na abertura do
 * portal e sob demanda na página. O front só interrompe o usuário quando
 * problemCount > 0 (algum check em `fail`).
 */
export interface DiagnosticsReport {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  checks: DiagnosticCheck[];
  /** Nº de checks em `fail`. */
  problemCount: number;
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
  /** Id de origem quando criada por import — reimports atualizam em vez de duplicar. */
  importedFrom?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDoc {
  name: string;
  size: number;
  mtime: string;
  /** URL de origem (SharePoint, GitHub Pages…) quando o doc é sincronizado de uma fonte remota. */
  sourceUrl?: string;
  /** Última sincronização bem-sucedida com a sourceUrl (ISO). */
  syncedAt?: string;
  /** Erro da última tentativa de sincronização (limpo quando sincroniza com sucesso). */
  syncError?: string;
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

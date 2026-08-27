/** Modo de operação da sessão, equivalente aos modos do Copilot. */
export type SessionMode = 'ask' | 'plan' | 'agent';

/**
 * Quem responde a conversa. Dois formatos bem diferentes por baixo:
 *
 * - `copilot`: o portal é dono do loop agêntico (monta o prompt, chama o
 *   modelo, executa as ferramentas, repete). Todos os recursos do portal
 *   (skills, bases de conhecimento, MCPs, subagentes) valem.
 * - `claude-code` / `devin`: a CLI é dona do loop. O portal vira UI +
 *   transporte, traduzindo o stream da CLI para os eventos SSE do portal. Os
 *   recursos do portal que valem são os que dá para projetar em arquivos e
 *   flags da CLI (ver ProviderCapabilities).
 */
export type ProviderId = 'copilot' | 'claude-code' | 'devin';

export const DEFAULT_PROVIDER: ProviderId = 'copilot';

/** O que de fato funciona em cada provider — a UI esconde o resto. */
export interface ProviderCapabilities {
  /** Skills do portal entram no contexto da conversa. */
  skills: boolean;
  /** Bases de conhecimento entram no contexto. */
  knowledge: boolean;
  /** MCPs registrados no portal/VS Code são oferecidos como ferramentas. */
  mcp: boolean;
  /** Liga/desliga de ferramentas individuais pela UI do portal. */
  toolToggles: boolean;
  /** Presets de agente (instruções + modelo + modo). */
  agents: boolean;
  /** Modos ask/plan/agent por conversa. */
  modes: boolean;
  /** Arquivos fixados no contexto da sessão. */
  contextFiles: boolean;
  /** Custo da resposta é reportado (créditos ou dólares). */
  cost: boolean;
  /**
   * Personas e workflows do BMAD funcionam de verdade.
   *
   * Não basta o texto da persona chegar no contexto: o adaptador do BMAD manda
   * o agente usar as ferramentas do portal pelo nome (bmad_read_file,
   * portal_write_file, portal_run_command, portal_spawn_subagent). Onde essas
   * ferramentas não existem, a persona é injetada mas os workflows não
   * executam como escritos — por isso este flag é separado de `skills`.
   */
  bmad: boolean;
}

/** Um provider disponível (ou não) nesta máquina — GET /api/providers. */
export interface ProviderInfo {
  id: ProviderId;
  /** Nome exibido na UI (ex.: "GitHub Copilot", "Claude Code"). */
  label: string;
  /** Pronto para uso? Se false, `detail` diz o que falta. */
  available: boolean;
  /** Motivo da indisponibilidade, ou versão/conta detectada quando disponível. */
  detail?: string;
  capabilities: ProviderCapabilities;
}

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
  /**
   * Executáveis liberados sem aprovação no portal_run_command (primeiro token
   * do comando, ex.: "python3") — preenchido pelo "sempre permitir" da UI.
   */
  commandAllowlist?: string[];
  /** Pastas compartilhadas (rede) com skills, agentes e bases da equipe. */
  sharedLibraries?: SharedLibrary[];
  /**
   * Navegador usado na captura de sessão via SSO (IUClick/ServiceNow). Vazio =
   * automático. Existe porque a política corporativa costuma fixar o Edge como
   * padrão do Windows mesmo para quem navega no Chrome — e aí a janela do SSO
   * abria no navegador errado.
   */
  captureBrowser?: 'Chrome' | 'Edge' | 'Brave';
  /** Modo colaboração (multiplayer): servidor na rede local + convidados. */
  collab?: CollabConfig;
}

/**
 * Colaboração em tempo real ("modo host"): com `enabled`, o servidor passa a
 * escutar também na rede local (0.0.0.0) e aceita convidados — cada um com um
 * token individual, revogável, que identifica a pessoa em tudo que ela faz.
 * Ligar/desligar exige religar o servidor (o bind muda), o que a rota
 * PATCH /api/collab faz sozinha.
 */
export interface CollabConfig {
  enabled: boolean;
  /** Nome exibido do dono da máquina nas sessões compartilhadas (default: conta GitHub). */
  hostName?: string;
  guests: CollabGuest[];
}

/** Convite individual: o token identifica a pessoa (nome, cor) e é revogável. */
export interface CollabGuest {
  id: string;
  name: string;
  /** Token de acesso individual (vai na URL de convite). */
  token: string;
  /** Cor estável da pessoa (presença, cursor, autor de mensagem). */
  color: string;
  /** Convite revogado: o token deixa de valer, o registro fica para histórico. */
  revoked?: boolean;
  createdAt: string;
}

/** Identidade de quem está falando com a API (derivada do token apresentado). */
export interface CollabIdentity {
  role: 'host' | 'guest';
  /** Id do convite (só convidados). */
  guestId?: string;
  name: string;
  color: string;
}

/** Uma pessoa conectada ao portal agora (uma entrada por aba conectada ao /api/events). */
export interface CollabPeer {
  /** Id da aba/conexão (gerado no cliente). */
  clientId: string;
  name: string;
  role: 'host' | 'guest';
  color: string;
  /** O que a pessoa está olhando (para presença por conversa/quadro). */
  viewing?: { sessionId?: string; projectId?: string; board?: boolean };
  connectedAt: string;
}

/** Convite na visão do host (GET /api/collab) — inclui a URL pronta de entrada. */
export interface CollabGuestInfo extends CollabGuest {
  /** URLs de convite (uma por endereço de rede da máquina). */
  joinUrls: string[];
  online: boolean;
}

/** Estado da colaboração para a tela de configurações (host). */
export interface CollabStatus {
  enabled: boolean;
  hostName: string;
  /** Endereços do portal na rede local (vazio quando desligado). */
  lanUrls: string[];
  port: number;
  guests: CollabGuestInfo[];
  online: CollabPeer[];
}

// ---------------------------------------------------------------------------
// Quadro colaborativo (canvas de post-its por projeto)
// ---------------------------------------------------------------------------

/** Cores de post-it (classes CSS ficam por conta da UI). */
export type BoardNoteColor = 'yellow' | 'orange' | 'blue' | 'green' | 'pink' | 'purple';

export interface BoardNote {
  id: string;
  /** Posição no canvas (coordenadas do mundo, não da tela). */
  x: number;
  y: number;
  /** Largura; a altura acompanha o conteúdo. */
  w: number;
  color: BoardNoteColor;
  text: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BoardComment {
  id: string;
  noteId: string;
  author: string;
  text: string;
  createdAt: string;
}

/** Texto livre no quadro (sem post-it): título de área, legenda, anotação. */
export interface BoardText {
  id: string;
  x: number;
  y: number;
  w: number;
  text: string;
  size: 'sm' | 'md' | 'lg';
  color: BoardStrokeColor;
  author?: string;
  createdAt: string;
  updatedAt: string;
}

export type BoardShapeKind = 'line' | 'arrow' | 'rect' | 'ellipse';
export type BoardStrokeStyle = 'solid' | 'dashed' | 'dotted';
export type BoardStrokeColor = 'ink' | 'blue' | 'orange' | 'green' | 'red' | 'purple';

/**
 * Forma desenhada no quadro. Linhas/setas usam (x,y)→(x2,y2); retângulo e
 * elipse usam a caixa (x,y,w,h). Sem preenchimento — é quadro de squad, não
 * editor vetorial: o que importa é ligar/agrupar/separar as notas.
 */
export interface BoardShape {
  id: string;
  kind: BoardShapeKind;
  x: number;
  y: number;
  /** Segundo ponto (line/arrow). */
  x2?: number;
  y2?: number;
  /** Caixa (rect/ellipse). */
  w?: number;
  h?: number;
  stroke: BoardStrokeStyle;
  color: BoardStrokeColor;
  /** Espessura do traço em px do mundo (1–8). */
  width: number;
  author?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Estado do quadro de um projeto. Sincronização por operações: o cliente
 * aplica otimista, envia o lote em POST /board/ops e recebe as operações dos
 * outros pelo canal de eventos; `revision` detecta lacunas (aí refaz o GET).
 * `texts`/`shapes` chegaram depois das notas: quadros antigos no disco não os
 * têm — o servidor normaliza para [] ao carregar.
 */
export interface BoardState {
  revision: number;
  notes: BoardNote[];
  comments: BoardComment[];
  texts: BoardText[];
  shapes: BoardShape[];
  updatedAt: string;
}

export type BoardOp =
  | { type: 'note_upsert'; note: BoardNote }
  | { type: 'note_delete'; id: string }
  | { type: 'comment_add'; comment: BoardComment }
  | { type: 'comment_delete'; id: string }
  | { type: 'text_upsert'; text: BoardText }
  | { type: 'text_delete'; id: string }
  | { type: 'shape_upsert'; shape: BoardShape }
  | { type: 'shape_delete'; id: string };

/**
 * Biblioteca compartilhada: uma pasta (normalmente de rede, \\servidor\equipe\…)
 * de onde o portal lê skills, agentes e bases de conhecimento além dos locais.
 * Quem edita um item de lá está editando para todo mundo que aponta para a
 * mesma pasta — a UI avisa antes de gravar.
 */
export interface SharedLibrary {
  id: string;
  /** Nome exibido nas listagens (badge "Compartilhada · <nome>"). */
  name: string;
  /** Caminho da pasta no sistema de arquivos (UNC no Windows, montagem no macOS). */
  path: string;
}

/**
 * Impressão digital das pastas compartilhadas, por tipo. O cliente compara
 * entre um poll e outro para recarregar sozinho quando OUTRA pessoa mexeu.
 */
export interface SharedRevision {
  skills: string;
  agents: string;
  knowledge: string;
  /** Última varredura concluída (ISO); ausente = nenhuma ainda. */
  checkedAt?: string;
  /** Bibliotecas fora do ar na varredura. */
  offline: string[];
}

/** Situação de uma biblioteca no momento da consulta (a rede pode estar fora). */
export interface SharedLibraryStatus extends SharedLibrary {
  available: boolean;
  writable: boolean;
  error?: string;
  counts?: { skills: number; agents: number; knowledgeBases: number };
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
  /** Quem oferece o modelo — o seletor da UI agrupa por aqui. */
  provider: ProviderId;
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
  /** Copilot Chat presente no VS Code (informativo — não bloqueia a entrada). */
  copilotChatInstalled: boolean;
  /** Modelos do Copilot (informativo — não bloqueia a entrada). */
  modelCount: number;
  /**
   * Motores detectados e o motivo de cada indisponibilidade. `ok` acima é
   * verdadeiro quando ao menos um deles está disponível: o portal serve tanto
   * quem tem só o Copilot quanto quem tem só o Claude Code.
   *
   * OPCIONAL de propósito: a extensão serve o bundle web lendo do disco a cada
   * request, então instalar uma versão nova troca o web imediatamente enquanto
   * o processo da extensão segue com o código antigo até a janela recarregar.
   * Nessa janela o campo não existe — a UI precisa tolerar a ausência.
   */
  providers?: ProviderInfo[];
  account?: { id: string; label: string };
  needsConsent: boolean;
  env?: EnvStatus;
  /** Presente quando há versão mais nova do portal publicada no npm. */
  update?: { latest: string; command: string };
}

/** Arquivo/seleção ativos no editor do VS Code — vira anexo no chat (como o # do Copilot). */
export interface EditorContext {
  file?: {
    name: string;
    languageId: string;
    /** Presentes quando há seleção; ausentes = arquivo inteiro. */
    startLine?: number;
    endLine?: number;
    content: string;
    truncated: boolean;
  };
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
  /**
   * Custo em dólares reportado pela própria CLI (providers que são donos do
   * loop — o Claude Code devolve total_cost_usd no evento `result`). Não se
   * mistura com `credits`: são unidades de cobrança diferentes.
   */
  costUsd?: number;
}

export type ChatFinishReason = 'stop' | 'cancelled' | 'max_rounds' | 'error';

/**
 * Quem escreveu a mensagem numa sessão compartilhada (modo colaboração).
 * Ausente = conversa single-player de antes do multiplayer (trate como o host).
 */
export interface MessageAuthor {
  name: string;
  role: 'host' | 'guest';
  /** Cor estável da pessoa (avatar/cursor) — herdada do convite. */
  color?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Autor humano da mensagem (mensagens user em sessão compartilhada). */
  author?: MessageAuthor;
  parts: MessagePart[];
  /** Modelo que gerou a resposta (mensagens assistant). */
  modelId?: string;
  usage?: TokenUsage;
  createdAt: string;
  /** Como a resposta terminou (mensagens assistant) — habilita o "continuar" no max_rounds. */
  finishReason?: ChatFinishReason;
  error?: { code: string; message: string };
}

export interface Session {
  id: string;
  title: string;
  /** null = sessão avulsa, fora de qualquer projeto. */
  projectId: string | null;
  mode: SessionMode;
  /** Ausente nas conversas criadas antes dos providers — trate como 'copilot'. */
  provider?: ProviderId;
  modelId?: string;
  agentId?: string;
  /**
   * Id da conversa do lado da CLI (providers que são donos do próprio loop),
   * gravado na primeira resposta e reusado com --resume nas seguintes. É o que
   * mantém o histórico do lado de lá sem o portal reenviar o contexto.
   */
  providerSessionId?: string;
  activeSkillIds: string[];
  /** null = todas as ferramentas habilitadas. */
  enabledTools: string[] | null;
  /** Arquivos do projeto fixados no contexto (caminhos relativos à raiz). */
  contextFiles?: string[];
  messages: ChatMessage[];
  /**
   * Resumo automático da parte antiga da conversa que já não cabe na janela do
   * modelo — injetado no lugar das mensagens podadas. Cobre as mensagens até
   * throughMessageId (inclusive); atualizado em background quando a poda avança.
   */
  historySummary?: { throughMessageId: string; summary: string };
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
  scope: 'global' | 'project' | 'shared';
  projectId?: string;
  /** Biblioteca compartilhada dona da skill (scope 'shared'). */
  libraryId?: string;
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
  /**
   * 'shared' = o agente vive numa biblioteca compartilhada (um arquivo por
   * agente na pasta de rede); ausente/'global' = agents.json local.
   */
  scope?: 'global' | 'shared';
  /** Biblioteca compartilhada dona do agente (scope 'shared'). */
  libraryId?: string;
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
  /** Portais SSO disponíveis — a UI oferece a escolha antes de iniciar o setup. */
  ssoPortals?: { id: string; label: string }[];
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

/**
 * Tipos de artefato BMAD reconhecidos em _bmad-output/ do projeto (detecção
 * por convenção de nome do BMAD v6/BMM — melhor esforço).
 */
export type BmadArtifactKind =
  | 'brainstorming'
  | 'market-research'
  | 'domain-research'
  | 'technical-research'
  | 'product-brief'
  | 'prd'
  | 'prfaq'
  | 'ux-design'
  | 'prd-validation'
  | 'adversarial-review'
  | 'epics'
  | 'implementation-readiness';

/** Artefato BMAD encontrado na pasta _bmad-output/ do projeto. */
export interface BmadArtifact {
  kind: BmadArtifactKind;
  /** Nome do arquivo. */
  name: string;
  /** Caminho relativo à raiz do projeto (ex.: _bmad-output/planning-artifacts/prd.md). */
  path: string;
  /** Última modificação (ISO). */
  mtime: string;
}

/** Resposta de GET /api/bmad/artifacts?projectId=… */
export interface BmadArtifactsReport {
  artifacts: BmadArtifact[];
}

/**
 * Varredura de um site (GitHub Pages, portal de documentação…) trazida para a
 * base: uma URL inicial vira N documentos, um por página. A coleção mantém
 * esses documentos AGRUPADOS — na lista, no contexto do modelo e no re-sync —
 * em vez de virarem dezenas de .md soltos no meio dos documentos avulsos.
 */
export interface KnowledgeCollection {
  /** Slug estável, também usado como prefixo dos arquivos gerados. */
  id: string;
  /** Rótulo exibido, ex: "meudocs.github.io/guia". */
  name: string;
  /** URL onde a varredura começa. */
  rootUrl: string;
  /** Tetos usados na varredura — o re-sync repete os mesmos. */
  maxPages: number;
  depth: number;
  /** Como as páginas foram descobertas na última varredura. */
  via?: 'sitemap' | 'links';
  syncedAt?: string;
  syncError?: string;
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;
  scope: 'global' | 'project' | 'shared';
  projectId?: string;
  /** Biblioteca compartilhada dona da base (scope 'shared'). */
  libraryId?: string;
  /** Bases habilitadas entram no contexto das conversas (global: todas; project: as do projeto). */
  enabled: boolean;
  docCount: number;
  /** Sites varridos que vivem nesta base (cada um agrupa vários documentos). */
  collections?: KnowledgeCollection[];
  /** Id de origem quando criada por import — reimports atualizam em vez de duplicar. */
  importedFrom?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDoc {
  name: string;
  size: number;
  mtime: string;
  /**
   * Documento guardado no formato original (PDF, Word, Excel, PowerPoint): o
   * texto usado no contexto e na busca vem de uma conversão cacheada, e o
   * arquivo continua disponível para baixar/abrir.
   */
  binary?: boolean;
  /** URL de origem (SharePoint, GitHub Pages…) quando o doc é sincronizado de uma fonte remota. */
  sourceUrl?: string;
  /** Última sincronização bem-sucedida com a sourceUrl (ISO). */
  syncedAt?: string;
  /** Erro da última tentativa de sincronização (limpo quando sincroniza com sucesso). */
  syncError?: string;
  /** Id da coleção (site varrido) dona deste documento, quando veio de uma varredura. */
  collection?: string;
  /** Título da página de origem — é o que a lista mostra no lugar do nome do arquivo. */
  title?: string;
}

/** Resultado de varrer um site (ao criar a coleção ou ao re-sincronizar). */
export interface KnowledgeCollectionSync {
  collection: KnowledgeCollection;
  docs: KnowledgeDoc[];
  added: number;
  updated: number;
  removed: number;
  /** Páginas que falharam — a varredura segue com o resto. */
  errors: Array<{ url: string; error: string }>;
  /** O site tinha mais páginas que o teto configurado. */
  truncated: boolean;
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
  /**
   * Pasta referenciada (symlink para fora da pasta de trabalho): os arquivos
   * vivem no local original da máquina; toda alteração acontece lá.
   */
  linked?: boolean;
  children?: FileEntry[];
}

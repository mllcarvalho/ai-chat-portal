import type {
  BoardOp,
  ChatFinishReason,
  CollabIdentity,
  CollabPeer,
  SessionSummary,
  TokenUsage,
} from './types';

export type { ChatFinishReason } from './types';

/** Header de autenticação exigido em todas as rotas /api/*. */
export const TOKEN_HEADER = 'X-Portal-Token';

/**
 * Header opcional com o id da aba (clientId do /api/events): permite ao
 * servidor marcar a origem de um evento — a aba que causou a mudança ignora o
 * próprio eco em vez de recarregar à toa.
 */
export const CLIENT_HEADER = 'X-Portal-Client';

export const DEFAULT_PORT = 4717;
export const PORT_RANGE = 10;

/**
 * Limites de upload/anexo — fonte única usada pela UI (validar/avisar antes de
 * enviar) e pelo servidor (recusar acima do teto).
 */
export const UPLOAD_LIMITS = {
  /**
   * Texto de um anexo de mensagem do chat (em caracteres, após conversão).
   *
   * 5 MB ≈ 1,2 milhão de tokens: cabe inteiro só nas CLIs de janela grande
   * (Devin, Claude Code), que recebem o prompt por stdin. No Copilot o anexo é
   * truncado na montagem da mensagem para o que sobra da janela do modelo —
   * ver attachmentBlocks no messageBuilder.
   */
  chatAttachmentChars: 5 * 1024 * 1024,
  /** Arquivo original (Excel/Word/PDF) que será convertido em texto no chat. */
  chatSourceFileBytes: 10 * 1024 * 1024,
  /** Arquivo enviado ao painel Arquivos (espelha o WRITE_LIMIT do servidor). */
  drawerFileBytes: 2 * 1024 * 1024,
  /** Anexo da pasta de uma skill. */
  skillFileBytes: 5 * 1024 * 1024,
} as const;

/** Formata um limite em bytes para exibição: "512 KB", "2 MB", "10 MB". */
export function formatByteLimit(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** Arquivo de texto anexado a uma mensagem; entra no contexto junto com ela. */
export interface ChatAttachment {
  name: string;
  content: string;
}

export interface ChatRequestBody {
  sessionId: string;
  text: string;
  attachments?: ChatAttachment[];
  /**
   * Editar/regenerar: o servidor descarta o histórico a partir desta mensagem
   * do usuário (inclusive) antes de gravar a nova.
   */
  retryFromMessageId?: string;
  /**
   * Id (UUID) da mensagem do usuário, gerado no cliente: a UI e o servidor
   * persistem o MESMO id mesmo se a conexão cair antes do meta — sem isso um
   * editar/regenerar posterior não encontraria a mensagem e duplicaria o turno.
   */
  userMessageId?: string;
}

export type ChatErrorCode =
  | 'no_permissions'
  | 'quota'
  | 'model_not_found'
  | 'tool_error'
  | 'internal';

/** Eventos SSE emitidos por POST /api/chat, na ordem em que ocorrem. */
export interface ChatSseEvents {
  meta: { requestId: string; userMessageId: string; assistantMessageId: string };
  /** Aviso não-fatal sobre a request (ex.: MCPs fora do limite de tools) — vira toast na UI. */
  notice: { message: string };
  text: { delta: string };
  tool_call: { callId: string; toolName: string; input: unknown };
  /**
   * Comando aguardando aprovação do usuário. O stream fica pausado até
   * POST /api/chat/:requestId/approval { callId, approved } (ou timeout = negado);
   * o desfecho chega no tool_result do mesmo callId.
   */
  approval_request: { callId: string; toolName: string; command: string; cwd: string };
  /**
   * Pergunta do portal_ask_user aguardando o usuário. O stream fica pausado até
   * POST /api/chat/:requestId/question { callId, answer } (ou timeout);
   * o desfecho chega no tool_result do mesmo callId.
   */
  user_question: { callId: string; toolName: string; question: string; options: string[] };
  tool_result: {
    callId: string;
    toolName: string;
    ok: boolean;
    content: string;
    durationMs: number;
  };
  done: {
    finishReason: ChatFinishReason;
    updatedSession?: SessionSummary;
    usage?: TokenUsage;
    /** Modelo que de fato respondeu (pode diferir do pedido quando houve fallback). */
    modelId?: string;
  };
  /**
   * Chega DEPOIS de `done`: AI credits reais da resposta, medidos pelo delta da
   * cota da licença (a contabilização do GitHub leva alguns segundos). O stream
   * só fecha depois deste evento (ou do timeout da medição).
   */
  usage_update: { messageId: string; usage: TokenUsage };
  /** Metadados da sessão mudaram após o done (ex.: título gerado pelo modelo). */
  session_update: { updatedSession: SessionSummary };
  error: { code: ChatErrorCode; message: string };
}

export type ChatSseEventName = keyof ChatSseEvents;

/**
 * Canal global de eventos (GET /api/events, SSE): tudo que muda no portal e
 * interessa a TODOS os clientes conectados — é o que mantém as abas (e as
 * outras pessoas, no modo colaboração) em dia sem polling. Os eventos de chat
 * de uma geração específica continuam no stream próprio dela (ChatSseEvents).
 */
export interface PortalEvents {
  /** Primeiro evento da conexão: quem você é e quem mais está aqui. */
  hello: { clientId: string; identity: CollabIdentity; peers: CollabPeer[] };
  /** Alguém entrou/saiu/mudou de tela. */
  peers: { peers: CollabPeer[] };
  /**
   * Uma sessão mudou no disco (mensagem nova, rename, geração concluída…).
   * `origin` = clientId de quem causou (quando conhecido) — essa aba ignora.
   */
  session_changed: { summary: SessionSummary; origin?: string };
  session_deleted: { sessionId: string; projectId: string | null };
  /** Uma geração começou/terminou nesta sessão (para as outras abas anexarem). */
  generation_started: { sessionId: string };
  generation_ended: { sessionId: string };
  /** Operações aplicadas ao quadro de um projeto. */
  board_op: { projectId: string; revision: number; ops: BoardOp[]; origin?: string };
  /** Cursor de alguém sobre o quadro (efêmero, não persiste). */
  board_cursor: {
    projectId: string;
    clientId: string;
    name: string;
    color: string;
    /** Coordenadas do mundo do canvas. */
    x: number;
    y: number;
    /** false = a pessoa saiu do quadro (remove o cursor). */
    active: boolean;
  };
  /** A lista de projetos mudou (criado/renomeado/excluído). */
  projects_changed: Record<string, never>;
  /** Config de colaboração mudou (convites, nome) — a tela do host recarrega. */
  collab_changed: Record<string, never>;
}

export type PortalEventName = keyof PortalEvents;

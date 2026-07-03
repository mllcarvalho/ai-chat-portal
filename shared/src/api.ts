import type { SessionSummary, TokenUsage } from './types';

/** Header de autenticação exigido em todas as rotas /api/*. */
export const TOKEN_HEADER = 'X-Portal-Token';

export const DEFAULT_PORT = 4717;
export const PORT_RANGE = 10;

/** Arquivo de texto anexado a uma mensagem; entra no contexto junto com ela. */
export interface ChatAttachment {
  name: string;
  content: string;
}

export interface ChatRequestBody {
  sessionId: string;
  text: string;
  /** Sobrescreve o modelo da sessão só para esta mensagem. */
  modelId?: string;
  attachments?: ChatAttachment[];
}

export type ChatErrorCode =
  | 'no_permissions'
  | 'quota'
  | 'model_not_found'
  | 'tool_error'
  | 'internal';

export type ChatFinishReason = 'stop' | 'cancelled' | 'max_rounds' | 'error';

/** Eventos SSE emitidos por POST /api/chat, na ordem em que ocorrem. */
export interface ChatSseEvents {
  meta: { requestId: string; userMessageId: string; assistantMessageId: string };
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
  done: { finishReason: ChatFinishReason; updatedSession?: SessionSummary; usage?: TokenUsage };
  /**
   * Chega DEPOIS de `done`: AI credits reais da resposta, medidos pelo delta da
   * cota da licença (a contabilização do GitHub leva alguns segundos). O stream
   * só fecha depois deste evento (ou do timeout da medição).
   */
  usage_update: { messageId: string; usage: TokenUsage };
  error: { code: ChatErrorCode; message: string };
}

export type ChatSseEventName = keyof ChatSseEvents;

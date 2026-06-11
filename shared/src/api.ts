import type { SessionSummary } from './types';

/** Header de autenticação exigido em todas as rotas /api/*. */
export const TOKEN_HEADER = 'X-Portal-Token';

export const DEFAULT_PORT = 4717;
export const PORT_RANGE = 10;

export interface ChatRequestBody {
  sessionId: string;
  text: string;
  /** Sobrescreve o modelo da sessão só para esta mensagem. */
  modelId?: string;
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
  tool_result: {
    callId: string;
    toolName: string;
    ok: boolean;
    content: string;
    durationMs: number;
  };
  done: { finishReason: ChatFinishReason; updatedSession?: SessionSummary };
  error: { code: ChatErrorCode; message: string };
}

export type ChatSseEventName = keyof ChatSseEvents;

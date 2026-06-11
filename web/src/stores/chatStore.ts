import { create } from 'zustand';
import type { ChatMessage, MessagePart } from '@aiportal/shared';
import { api } from '../api/client';
import { streamChat } from '../api/sseChat';
import { useSessions } from './sessionsStore';
import { useUi } from './uiStore';

interface ChatState {
  isStreaming: boolean;
  requestId?: string;
  /** Partes da resposta em construção (renderizadas ao vivo). */
  streamingParts: MessagePart[];
  send: (text: string) => Promise<void>;
  stop: () => void;
}

let abortController: AbortController | undefined;

export const useChat = create<ChatState>((set, get) => ({
  isStreaming: false,
  streamingParts: [],

  send: async (text) => {
    const sessions = useSessions.getState();
    const session = sessions.current;
    if (!session || get().isStreaming) return;

    // mensagem do usuário aparece imediatamente
    const userMessage: ChatMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      parts: [{ type: 'text', text }],
      createdAt: new Date().toISOString(),
    };
    sessions.mutateCurrent((s) => ({ ...s, messages: [...s.messages, userMessage] }));

    set({ isStreaming: true, streamingParts: [], requestId: undefined });
    abortController = new AbortController();

    const appendText = (delta: string) => {
      const parts = [...get().streamingParts];
      const last = parts[parts.length - 1];
      if (last?.type === 'text') {
        parts[parts.length - 1] = { type: 'text', text: last.text + delta };
      } else {
        parts.push({ type: 'text', text: delta });
      }
      set({ streamingParts: parts });
    };

    let errorInfo: { code: string; message: string } | undefined;

    try {
      await streamChat(
        { sessionId: session.id, text },
        {
          onMeta: (meta) => set({ requestId: meta.requestId }),
          onText: (data) => appendText(data.delta),
          onToolCall: (data) =>
            set({
              streamingParts: [
                ...get().streamingParts,
                { type: 'tool_call', callId: data.callId, toolName: data.toolName, input: data.input },
              ],
            }),
          onToolResult: (data) =>
            set({
              streamingParts: [
                ...get().streamingParts,
                {
                  type: 'tool_result',
                  callId: data.callId,
                  toolName: data.toolName,
                  ok: data.ok,
                  content: data.content,
                  durationMs: data.durationMs,
                },
              ],
            }),
          onError: (err) => {
            errorInfo = err;
          },
          onDone: (done) => {
            const finished = get().streamingParts;
            if (finished.length || errorInfo) {
              const assistantMessage: ChatMessage = {
                id: `local-${Date.now()}-a`,
                role: 'assistant',
                parts: finished,
                createdAt: new Date().toISOString(),
                ...(errorInfo ? { error: errorInfo } : {}),
              };
              useSessions
                .getState()
                .mutateCurrent((s) => ({ ...s, messages: [...s.messages, assistantMessage] }));
            }
            if (done.updatedSession) useSessions.getState().refreshSummary(done.updatedSession);
            if (done.finishReason === 'max_rounds') {
              useUi
                .getState()
                .toast('A conversa atingiu o limite de rodadas de ferramentas.', 'info');
            }
          },
        },
        abortController.signal,
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        errorInfo = { code: 'internal', message: (err as Error).message };
      }
    } finally {
      set({ isStreaming: false, streamingParts: [], requestId: undefined });
      abortController = undefined;
    }

    if (errorInfo) {
      useUi.getState().toast(errorInfo.message, 'error');
      if (errorInfo.code === 'no_permissions') {
        // dispara a notificação de autorização na janela do VS Code
        void api.warmup().catch(() => undefined);
      }
    }
  },

  stop: () => {
    const { requestId, isStreaming, streamingParts } = get();
    if (!isStreaming) return;
    if (requestId) void api.cancelChat(requestId).catch(() => undefined);
    // preserva o parcial localmente (o servidor também persiste)
    if (streamingParts.length) {
      const partial: ChatMessage = {
        id: `local-${Date.now()}-p`,
        role: 'assistant',
        parts: streamingParts,
        createdAt: new Date().toISOString(),
      };
      useSessions.getState().mutateCurrent((s) => ({ ...s, messages: [...s.messages, partial] }));
    }
    abortController?.abort();
    set({ isStreaming: false, streamingParts: [], requestId: undefined });
  },
}));

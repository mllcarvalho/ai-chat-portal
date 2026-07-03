import { create } from 'zustand';
import type { ChatAttachment, ChatMessage, MessagePart } from '@aiportal/shared';
import { api } from '../api/client';
import { streamChat } from '../api/sseChat';
import { useSessions } from './sessionsStore';
import { useCatalog } from './catalogStore';
import { useUi } from './uiStore';

/** Comando do portal_run_command aguardando aprovar/negar na UI. */
export interface PendingApproval {
  callId: string;
  toolName: string;
  command: string;
  cwd: string;
}

/** Pergunta do portal_ask_user aguardando resposta na UI. */
export interface PendingQuestion {
  callId: string;
  question: string;
  options: string[];
}

interface ChatState {
  isStreaming: boolean;
  requestId?: string;
  /** Partes da resposta em construção (renderizadas ao vivo). */
  streamingParts: MessagePart[];
  /** O stream fica pausado no servidor enquanto isto não for respondido. */
  pendingApproval?: PendingApproval;
  /** Idem: pergunta do assistente aguardando o usuário. */
  pendingQuestion?: PendingQuestion;
  send: (text: string, attachments?: ChatAttachment[]) => Promise<void>;
  respondApproval: (approved: boolean) => void;
  respondQuestion: (answer: string) => void;
  stop: () => void;
}

let abortController: AbortController | undefined;

/** Ferramentas que podem criar/alterar arquivos da pasta de trabalho. */
const FILE_MUTATING_TOOLS = [
  'portal_write_file',
  'portal_run_command',
  'portal_edit_file',
  'portal_delete_file',
  'portal_move_file',
];

export const useChat = create<ChatState>((set, get) => ({
  isStreaming: false,
  streamingParts: [],

  send: async (text, attachments = []) => {
    const sessions = useSessions.getState();
    const session = sessions.current;
    if (!session || get().isStreaming) return;

    // mensagem do usuário aparece imediatamente
    const userParts: MessagePart[] = [];
    if (text) userParts.push({ type: 'text', text });
    for (const att of attachments) {
      userParts.push({ type: 'attachment', name: att.name, content: att.content });
    }
    const userMessage: ChatMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      parts: userParts,
      createdAt: new Date().toISOString(),
    };
    sessions.mutateCurrent((s) => ({ ...s, messages: [...s.messages, userMessage] }));

    set({ isStreaming: true, streamingParts: [], requestId: undefined });
    const myController = new AbortController();
    abortController = myController;
    // id da mensagem do assistente no servidor (para casar o usage_update)
    let serverAssistantId: string | undefined;

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
        { sessionId: session.id, text, ...(attachments.length ? { attachments } : {}) },
        {
          onMeta: (meta) => {
            serverAssistantId = meta.assistantMessageId;
            set({ requestId: meta.requestId });
          },
          onText: (data) => appendText(data.delta),
          onToolCall: (data) =>
            set({
              streamingParts: [
                ...get().streamingParts,
                { type: 'tool_call', callId: data.callId, toolName: data.toolName, input: data.input },
              ],
            }),
          onApprovalRequest: (data) =>
            set({
              pendingApproval: {
                callId: data.callId,
                toolName: data.toolName,
                command: data.command,
                cwd: data.cwd,
              },
            }),
          onUserQuestion: (data) =>
            set({
              pendingQuestion: {
                callId: data.callId,
                question: data.question,
                options: data.options,
              },
            }),
          onToolResult: (data) => {
            if (data.ok && FILE_MUTATING_TOOLS.includes(data.toolName)) {
              useUi.getState().bumpFilesVersion();
            }
            // desfecho do comando/pergunta chegou: limpa o pendente do mesmo callId
            const pending = get().pendingApproval;
            const question = get().pendingQuestion;
            set({
              ...(pending?.callId === data.callId ? { pendingApproval: undefined } : {}),
              ...(question?.callId === data.callId ? { pendingQuestion: undefined } : {}),
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
            });
          },
          onError: (err) => {
            errorInfo = err;
          },
          onDone: (done) => {
            const finished = get().streamingParts;
            if (finished.length || errorInfo) {
              const assistantMessage: ChatMessage = {
                id: serverAssistantId ?? `local-${Date.now()}-a`,
                role: 'assistant',
                parts: finished,
                ...(session.modelId ? { modelId: session.modelId } : {}),
                ...(done.usage ? { usage: done.usage } : {}),
                createdAt: new Date().toISOString(),
                ...(errorInfo ? { error: errorInfo } : {}),
              };
              useSessions
                .getState()
                .mutateCurrent((s) => ({ ...s, messages: [...s.messages, assistantMessage] }));
            }
            if (done.updatedSession) useSessions.getState().refreshSummary(done.updatedSession);
            if (done.usage) void useCatalog.getState().loadQuota(true);
            if (done.finishReason === 'max_rounds') {
              useUi
                .getState()
                .toast('A conversa atingiu o limite de rodadas de ferramentas.', 'info');
            }
            // a resposta acabou: libera a UI já — o stream segue aberto só
            // esperando o usage_update (credits reais medidos na cota)
            set({
              isStreaming: false,
              streamingParts: [],
              requestId: undefined,
              pendingApproval: undefined,
              pendingQuestion: undefined,
            });
          },
          onUsageUpdate: (data) => {
            useSessions.getState().mutateCurrent((s) => ({
              ...s,
              messages: s.messages.map((m) =>
                m.id === data.messageId ? { ...m, usage: data.usage } : m,
              ),
            }));
            // o delta confirma que a cota mudou — atualiza o saldo do header
            void useCatalog.getState().loadQuota(true);
          },
        },
        abortController.signal,
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        errorInfo = { code: 'internal', message: (err as Error).message };
      }
    } finally {
      // só limpa se ainda formos o stream ativo: o usage_update mantém a
      // conexão aberta após o done, e um novo send pode já ter começado
      if (abortController === myController) {
        set({
          isStreaming: false,
          streamingParts: [],
          requestId: undefined,
          pendingApproval: undefined,
          pendingQuestion: undefined,
        });
        abortController = undefined;
      }
    }

    if (errorInfo) {
      useUi.getState().toast(errorInfo.message, 'error');
      if (errorInfo.code === 'no_permissions') {
        // dispara a notificação de autorização na janela do VS Code
        void api.warmup().catch(() => undefined);
      }
    }
  },

  respondApproval: (approved) => {
    const { requestId, pendingApproval } = get();
    if (!requestId || !pendingApproval) return;
    // limpa já: o desfecho real chega no tool_result deste callId
    set({ pendingApproval: undefined });
    api.respondApproval(requestId, pendingApproval.callId, approved).catch((err) => {
      useUi.getState().toast((err as Error).message, 'error');
    });
  },

  respondQuestion: (answer) => {
    const { requestId, pendingQuestion } = get();
    if (!requestId || !pendingQuestion || !answer.trim()) return;
    // limpa já: o desfecho real chega no tool_result deste callId
    set({ pendingQuestion: undefined });
    api.respondQuestion(requestId, pendingQuestion.callId, answer.trim()).catch((err) => {
      useUi.getState().toast((err as Error).message, 'error');
    });
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
    set({
      isStreaming: false,
      streamingParts: [],
      requestId: undefined,
      pendingApproval: undefined,
      pendingQuestion: undefined,
    });
  },
}));

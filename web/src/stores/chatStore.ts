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

/** Resposta em andamento de UMA sessão — cada conversa roda independente. */
export interface StreamState {
  requestId?: string;
  /** Partes da resposta em construção (renderizadas ao vivo). */
  parts: MessagePart[];
  /** O stream fica pausado no servidor enquanto isto não for respondido. */
  pendingApproval?: PendingApproval;
  /** Idem: pergunta do assistente aguardando o usuário. */
  pendingQuestion?: PendingQuestion;
}

interface ChatState {
  /** Streams ativos por sessionId — várias conversas podem gerar ao mesmo tempo. */
  streams: Record<string, StreamState>;
  send: (text: string, attachments?: ChatAttachment[]) => Promise<void>;
  respondApproval: (sessionId: string, approved: boolean) => void;
  respondQuestion: (sessionId: string, answer: string) => void;
  stop: (sessionId: string) => void;
}

const abortControllers = new Map<string, AbortController>();

/** Ferramentas que podem criar/alterar arquivos da pasta de trabalho. */
const FILE_MUTATING_TOOLS = [
  'portal_write_file',
  'portal_run_command',
  'portal_edit_file',
  'portal_delete_file',
  'portal_move_file',
];

export const useChat = create<ChatState>((set, get) => {
  const patchStream = (sessionId: string, patch: Partial<StreamState>) =>
    set((state) => {
      const stream = state.streams[sessionId];
      if (!stream) return state;
      return { streams: { ...state.streams, [sessionId]: { ...stream, ...patch } } };
    });

  const clearStream = (sessionId: string) =>
    set((state) => {
      const { [sessionId]: _gone, ...rest } = state.streams;
      return { streams: rest };
    });

  /** Título da sessão para prefixar toasts quando ela não está na tela. */
  const backgroundTitle = (sessionId: string): string | undefined => {
    const st = useSessions.getState();
    if (st.current?.id === sessionId) return undefined;
    const all = [...st.standalone, ...Object.values(st.byProject).flat()];
    return all.find((s) => s.id === sessionId)?.title ?? 'outra conversa';
  };

  const toastFor = (sessionId: string, message: string, kind: 'info' | 'error') => {
    const title = backgroundTitle(sessionId);
    useUi.getState().toast(title ? `[${title}] ${message}` : message, kind);
  };

  return {
    streams: {},

    send: async (text, attachments = []) => {
      const sessions = useSessions.getState();
      const session = sessions.current;
      // uma resposta por vez POR CONVERSA — outras sessões seguem livres
      if (!session || get().streams[session.id]) return;
      const sessionId = session.id;

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
      sessions.mutateSession(sessionId, (s) => ({ ...s, messages: [...s.messages, userMessage] }));

      // título otimista na sidebar: mesma regra do servidor (1ª linha da 1ª
      // mensagem, 60 chars) — sem esperar o fim do stream para refletir
      if (session.title === 'Nova conversa' && session.messages.length === 0) {
        const firstLine = text.split('\n')[0] || attachments[0]?.name || 'Nova conversa';
        const title = firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
        sessions.applyLocalTitle(sessionId, session.projectId ?? undefined, title);
      }

      set((state) => ({ streams: { ...state.streams, [sessionId]: { parts: [] } } }));
      const myController = new AbortController();
      abortControllers.set(sessionId, myController);
      // id da mensagem do assistente no servidor (para casar o usage_update)
      let serverAssistantId: string | undefined;

      const appendText = (delta: string) => {
        const stream = get().streams[sessionId];
        if (!stream) return;
        const parts = [...stream.parts];
        const last = parts[parts.length - 1];
        if (last?.type === 'text') {
          parts[parts.length - 1] = { type: 'text', text: last.text + delta };
        } else {
          parts.push({ type: 'text', text: delta });
        }
        patchStream(sessionId, { parts });
      };

      let errorInfo: { code: string; message: string } | undefined;

      try {
        await streamChat(
          { sessionId, text, ...(attachments.length ? { attachments } : {}) },
          {
            onMeta: (meta) => {
              serverAssistantId = meta.assistantMessageId;
              patchStream(sessionId, { requestId: meta.requestId });
            },
            onNotice: (data) => toastFor(sessionId, data.message, 'info'),
            onText: (data) => appendText(data.delta),
            onToolCall: (data) => {
              const stream = get().streams[sessionId];
              if (!stream) return;
              patchStream(sessionId, {
                parts: [
                  ...stream.parts,
                  { type: 'tool_call', callId: data.callId, toolName: data.toolName, input: data.input },
                ],
              });
            },
            onApprovalRequest: (data) =>
              patchStream(sessionId, {
                pendingApproval: {
                  callId: data.callId,
                  toolName: data.toolName,
                  command: data.command,
                  cwd: data.cwd,
                },
              }),
            onUserQuestion: (data) =>
              patchStream(sessionId, {
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
              const stream = get().streams[sessionId];
              if (!stream) return;
              // desfecho do comando/pergunta chegou: limpa o pendente do mesmo callId
              patchStream(sessionId, {
                ...(stream.pendingApproval?.callId === data.callId
                  ? { pendingApproval: undefined }
                  : {}),
                ...(stream.pendingQuestion?.callId === data.callId
                  ? { pendingQuestion: undefined }
                  : {}),
                parts: [
                  ...stream.parts,
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
              const finished = get().streams[sessionId]?.parts ?? [];
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
                // se o usuário voltou para a sessão no meio do stream, o reload
                // pode já ter trazido a resposta persistida — não duplica
                useSessions.getState().mutateSession(sessionId, (s) =>
                  s.messages.some((m) => m.id === assistantMessage.id)
                    ? s
                    : { ...s, messages: [...s.messages, assistantMessage] },
                );
              }
              if (done.updatedSession) useSessions.getState().refreshSummary(done.updatedSession);
              if (done.usage) void useCatalog.getState().loadQuota(true);
              if (done.finishReason === 'max_rounds') {
                toastFor(sessionId, 'A conversa atingiu o limite de rodadas de ferramentas.', 'info');
              }
              // a resposta acabou: libera a conversa já — o stream segue aberto
              // só esperando o usage_update (credits reais medidos na cota)
              clearStream(sessionId);
            },
            onUsageUpdate: (data) => {
              useSessions.getState().mutateSession(sessionId, (s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === data.messageId ? { ...m, usage: data.usage } : m,
                ),
              }));
              // o delta confirma que a cota mudou — atualiza o saldo do header
              void useCatalog.getState().loadQuota(true);
            },
          },
          myController.signal,
        );
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          errorInfo = { code: 'internal', message: (err as Error).message };
        }
      } finally {
        // só limpa se ainda formos o stream ativo desta sessão: o usage_update
        // mantém a conexão aberta após o done, e um novo send pode já ter começado
        if (abortControllers.get(sessionId) === myController) {
          clearStream(sessionId);
          abortControllers.delete(sessionId);
        }
      }

      if (errorInfo) {
        toastFor(sessionId, errorInfo.message, 'error');
        if (errorInfo.code === 'no_permissions') {
          // dispara a notificação de autorização na janela do VS Code
          void api.warmup().catch(() => undefined);
        }
      }
    },

    respondApproval: (sessionId, approved) => {
      const stream = get().streams[sessionId];
      if (!stream?.requestId || !stream.pendingApproval) return;
      const { requestId, pendingApproval } = stream;
      // limpa já: o desfecho real chega no tool_result deste callId
      patchStream(sessionId, { pendingApproval: undefined });
      api.respondApproval(requestId, pendingApproval.callId, approved).catch((err) => {
        useUi.getState().toast((err as Error).message, 'error');
      });
    },

    respondQuestion: (sessionId, answer) => {
      const stream = get().streams[sessionId];
      if (!stream?.requestId || !stream.pendingQuestion || !answer.trim()) return;
      const { requestId, pendingQuestion } = stream;
      // limpa já: o desfecho real chega no tool_result deste callId
      patchStream(sessionId, { pendingQuestion: undefined });
      api.respondQuestion(requestId, pendingQuestion.callId, answer.trim()).catch((err) => {
        useUi.getState().toast((err as Error).message, 'error');
      });
    },

    stop: (sessionId) => {
      const stream = get().streams[sessionId];
      if (!stream) return;
      if (stream.requestId) void api.cancelChat(stream.requestId).catch(() => undefined);
      // preserva o parcial localmente (o servidor também persiste)
      if (stream.parts.length) {
        const partial: ChatMessage = {
          id: `local-${Date.now()}-p`,
          role: 'assistant',
          parts: stream.parts,
          createdAt: new Date().toISOString(),
        };
        useSessions
          .getState()
          .mutateSession(sessionId, (s) => ({ ...s, messages: [...s.messages, partial] }));
      }
      abortControllers.get(sessionId)?.abort();
      abortControllers.delete(sessionId);
      clearStream(sessionId);
    },
  };
});

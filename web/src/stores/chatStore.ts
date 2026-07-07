import { create } from 'zustand';
import type { ChatAttachment, ChatMessage, MessagePart } from '@aiportal/shared';
import { api } from '../api/client';
import { attachChat, streamChat, type ChatStreamHandlers } from '../api/sseChat';
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

export interface SendOptions {
  /** Editar/regenerar: o servidor descarta o histórico a partir desta mensagem. */
  retryFromMessageId?: string;
}

interface ChatState {
  /** Streams ativos por sessionId — várias conversas podem gerar ao mesmo tempo. */
  streams: Record<string, StreamState>;
  send: (text: string, attachments?: ChatAttachment[], opts?: SendOptions) => Promise<void>;
  /** Reenvia a última mensagem do usuário, descartando a resposta anterior. */
  regenerate: (sessionId: string) => void;
  /** Reconecta a uma resposta que segue rodando no servidor (reload da página). */
  resume: (sessionId: string) => Promise<void>;
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

/** Espera entre tentativas de reconexão do stream (a graça do servidor é 120s). */
const REATTACH_DELAYS_MS = [800, 1500, 3000, 5000, 8000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Estado de UMA resposta em andamento, compartilhado entre conexão e reconexões. */
interface StreamCtx {
  done: boolean;
  errorInfo?: { code: string; message: string };
  serverAssistantId?: string;
  /** Id otimista da mensagem do usuário, trocado pelo id real no meta. */
  localUserMessageId?: string;
  modelId?: string;
}

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

  const makeHandlers = (sessionId: string, ctx: StreamCtx): ChatStreamHandlers => {
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

    return {
      onMeta: (meta) => {
        ctx.serverAssistantId = meta.assistantMessageId;
        patchStream(sessionId, { requestId: meta.requestId });
        // troca o id otimista pelo real: editar/regenerar dependem do id do servidor
        if (ctx.localUserMessageId) {
          const localId = ctx.localUserMessageId;
          ctx.localUserMessageId = undefined;
          useSessions.getState().mutateSession(sessionId, (s) => ({
            ...s,
            messages: s.messages.map((m) =>
              m.id === localId ? { ...m, id: meta.userMessageId } : m,
            ),
          }));
        }
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
        ctx.errorInfo = err;
      },
      onDone: (done) => {
        ctx.done = true;
        const finished = get().streams[sessionId]?.parts ?? [];
        if (finished.length || ctx.errorInfo) {
          const assistantMessage: ChatMessage = {
            id: ctx.serverAssistantId ?? `local-${Date.now()}-a`,
            role: 'assistant',
            parts: finished,
            ...(ctx.modelId ? { modelId: ctx.modelId } : {}),
            ...(done.usage ? { usage: done.usage } : {}),
            createdAt: new Date().toISOString(),
            ...(ctx.errorInfo ? { error: ctx.errorInfo } : {}),
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
    };
  };

  /** A geração terminou sem a gente ver o done: o servidor é a fonte da verdade. */
  const finalizeFromServer = async (sessionId: string) => {
    try {
      const fresh = await api.getSession(sessionId);
      useSessions.getState().mutateSession(sessionId, () => fresh);
      void useSessions.getState().loadSessions(fresh.projectId ?? null);
    } catch {
      // servidor fora do ar — o parcial local fica na tela até o próximo reload
    }
    clearStream(sessionId);
  };

  /** Reconexão esgotada: materializa o parcial na conversa em vez de descartá-lo. */
  const preservePartial = (sessionId: string, ctx: StreamCtx, message: string) => {
    const stream = get().streams[sessionId];
    if (stream?.parts.length) {
      const partial: ChatMessage = {
        id: ctx.serverAssistantId ?? `local-${Date.now()}-p`,
        role: 'assistant',
        parts: stream.parts,
        createdAt: new Date().toISOString(),
        error: { code: 'internal', message },
      };
      useSessions.getState().mutateSession(sessionId, (s) =>
        s.messages.some((m) => m.id === partial.id)
          ? s
          : { ...s, messages: [...s.messages, partial] },
      );
    }
    toastFor(sessionId, message, 'error');
    clearStream(sessionId);
  };

  /**
   * Laço de reconexão: o servidor segue gerando por até 120s sem cliente,
   * então uma queda de rede/reload não perde a resposta — reconecta, recebe
   * o replay completo e continua ao vivo (como o Copilot Chat).
   */
  const reattachLoop = async (
    sessionId: string,
    ctx: StreamCtx,
    controller: AbortController,
    immediate = false,
  ): Promise<void> => {
    const delays = immediate ? [0, ...REATTACH_DELAYS_MS] : REATTACH_DELAYS_MS;
    for (const delay of delays) {
      if (ctx.done || controller.signal.aborted) return;
      if (delay) await sleep(delay);
      if (ctx.done || controller.signal.aborted) return;
      try {
        const attached = await attachChat(
          sessionId,
          makeHandlers(sessionId, ctx),
          controller.signal,
          // replay reconstrói tudo do zero: zera o parcial só quando ele começa
          () => patchStream(sessionId, { parts: [], pendingApproval: undefined, pendingQuestion: undefined }),
        );
        if (!attached) {
          await finalizeFromServer(sessionId);
          return;
        }
        if (ctx.done || controller.signal.aborted) return;
        // o stream caiu de novo no meio — tenta a próxima janela
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        // servidor inacessível — próxima tentativa
      }
    }
    preservePartial(
      sessionId,
      ctx,
      'A conexão com o portal caiu e a reconexão falhou. A resposta pode ter continuado no servidor — reabra a conversa para conferir.',
    );
  };

  /** Encerramento comum a send/resume: limpeza + toast de erro. */
  const finishRun = (sessionId: string, ctx: StreamCtx, controller: AbortController) => {
    // só limpa se ainda formos o stream ativo desta sessão: o usage_update
    // mantém a conexão aberta após o done, e um novo send pode já ter começado
    if (abortControllers.get(sessionId) === controller) {
      clearStream(sessionId);
      abortControllers.delete(sessionId);
    }
    if (ctx.errorInfo) {
      toastFor(sessionId, ctx.errorInfo.message, 'error');
      if (ctx.errorInfo.code === 'no_permissions') {
        // dispara a notificação de autorização na janela do VS Code
        void api.warmup().catch(() => undefined);
      }
    }
  };

  return {
    streams: {},

    send: async (text, attachments = [], opts = {}) => {
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
      sessions.mutateSession(sessionId, (s) => {
        // editar/regenerar: descarta localmente o mesmo trecho que o servidor descarta
        let messages = s.messages;
        if (opts.retryFromMessageId) {
          const idx = messages.findIndex((m) => m.id === opts.retryFromMessageId);
          if (idx >= 0) messages = messages.slice(0, idx);
        }
        return { ...s, messages: [...messages, userMessage] };
      });

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
      const ctx: StreamCtx = {
        done: false,
        localUserMessageId: userMessage.id,
        modelId: session.modelId,
      };

      try {
        await streamChat(
          {
            sessionId,
            text,
            ...(attachments.length ? { attachments } : {}),
            ...(opts.retryFromMessageId ? { retryFromMessageId: opts.retryFromMessageId } : {}),
          },
          makeHandlers(sessionId, ctx),
          myController.signal,
        );
        // conexão encerrou sem done nem erro de request: rede caiu no meio —
        // o servidor segue gerando; tenta reconectar antes de desistir
        if (!ctx.done && !ctx.errorInfo && !myController.signal.aborted) {
          await reattachLoop(sessionId, ctx, myController);
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          await reattachLoop(sessionId, ctx, myController);
        }
      } finally {
        finishRun(sessionId, ctx, myController);
      }
    },

    regenerate: (sessionId) => {
      const session = useSessions.getState().current;
      if (!session || session.id !== sessionId || get().streams[sessionId]) return;
      const lastUser = [...session.messages].reverse().find((m) => m.role === 'user');
      if (!lastUser) return;
      const text = lastUser.parts
        .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      const attachments: ChatAttachment[] = lastUser.parts
        .filter((p): p is Extract<MessagePart, { type: 'attachment' }> => p.type === 'attachment')
        .map((p) => ({ name: p.name, content: p.content }));
      void get().send(text, attachments, { retryFromMessageId: lastUser.id });
    },

    resume: async (sessionId) => {
      if (get().streams[sessionId] || abortControllers.has(sessionId)) return;
      let active: { requestId: string | null };
      try {
        active = await api.chatActive(sessionId);
      } catch {
        return;
      }
      if (!active.requestId || get().streams[sessionId]) return;

      set((state) => ({ streams: { ...state.streams, [sessionId]: { parts: [] } } }));
      const myController = new AbortController();
      abortControllers.set(sessionId, myController);
      const ctx: StreamCtx = {
        done: false,
        modelId: useSessions.getState().current?.modelId,
      };
      try {
        await reattachLoop(sessionId, ctx, myController, true);
      } finally {
        finishRun(sessionId, ctx, myController);
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
      if (stream.requestId) {
        void api.cancelChat(stream.requestId).catch(() => undefined);
      } else {
        // stop antes do meta chegar: cancela pela sessão
        void api.cancelChatBySession(sessionId).catch(() => undefined);
      }
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

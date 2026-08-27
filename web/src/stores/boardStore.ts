import { create } from 'zustand';
import type { BoardNote, BoardOp, BoardState, PortalEvents } from '@aiportal/shared';
import { api } from '../api/client';
import { useUi } from './uiStore';

/**
 * Quadro colaborativo no cliente. Modelo de sincronização:
 * - mutação local aplica otimista e enfileira a operação (flush a cada 150ms);
 * - todo mundo (inclusive esta aba) recebe as operações pelo canal de eventos
 *   com a `revision` resultante — aplicar é idempotente, então o próprio eco
 *   serve de confirmação e avança a revision local;
 * - revision com buraco = evento perdido → refetch do quadro inteiro;
 * - a nota que estou editando/arrastando agora não é sobrescrita pelo eco
 *   (o texto/posição mais novos ainda não foram enviados).
 */

interface RemoteCursor {
  name: string;
  color: string;
  x: number;
  y: number;
  at: number;
}

interface BoardUiState {
  projectId?: string;
  board?: BoardState;
  loading: boolean;
  /** Nota selecionada (mostra paleta/comentários). */
  selectedId?: string;
  /** Nota com edição de texto/arrasto EM CURSO nesta aba (eco não sobrescreve). */
  activeNoteId?: string;
  cursors: Record<string, RemoteCursor>;

  open: (projectId: string) => Promise<void>;
  close: () => void;
  resync: () => Promise<void>;
  select: (id?: string) => void;
  setActiveNote: (id?: string) => void;
  /** Aplica localmente e enfileira para o servidor. */
  apply: (ops: BoardOp[]) => void;
  applyRemote: (event: PortalEvents['board_op']) => void;
  applyCursor: (event: PortalEvents['board_cursor']) => void;
  /** Remove cursores parados há mais de 6s (aba fechada sem aviso). */
  pruneCursors: () => void;
}

function applyOpsTo(board: BoardState, ops: BoardOp[], skipNoteId?: string): BoardState {
  let { notes, comments } = board;
  for (const op of ops) {
    if (op.type === 'note_upsert') {
      if (op.note.id === skipNoteId) continue;
      const exists = notes.some((n) => n.id === op.note.id);
      notes = exists ? notes.map((n) => (n.id === op.note.id ? op.note : n)) : [...notes, op.note];
    } else if (op.type === 'note_delete') {
      notes = notes.filter((n) => n.id !== op.id);
      comments = comments.filter((c) => c.noteId !== op.id);
    } else if (op.type === 'comment_add') {
      if (!comments.some((c) => c.id === op.comment.id)) comments = [...comments, op.comment];
    } else if (op.type === 'comment_delete') {
      comments = comments.filter((c) => c.id !== op.id);
    }
  }
  return { ...board, notes, comments };
}

/** Fila de envio: operações locais ainda não enviadas (coalesce por nota). */
let queue: BoardOp[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let sending = false;

export const useBoard = create<BoardUiState>((set, get) => {
  const flush = async (projectId: string): Promise<void> => {
    // o quadro pode ter trocado de projeto no meio: a fila é sempre do projeto
    // que a criou — nunca posta operações de um quadro no outro
    if (get().projectId !== projectId || sending || !queue.length) return;
    const batch = queue;
    queue = [];
    sending = true;
    try {
      await api.postBoardOps(projectId, batch);
    } catch (err) {
      useUi.getState().toast(`Falha ao salvar o quadro: ${(err as Error).message}`, 'error');
      // devolve para a fila: a próxima mutação (ou o resync) tenta de novo
      if (get().projectId === projectId) queue = [...batch, ...queue];
    } finally {
      sending = false;
      if (queue.length) scheduleFlush(projectId);
    }
  };

  const scheduleFlush = (projectId: string): void => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flush(projectId);
    }, 150);
  };

  return {
    loading: false,
    cursors: {},

    open: async (projectId) => {
      queue = [];
      set({ projectId, loading: true, board: undefined, selectedId: undefined, cursors: {} });
      try {
        const board = await api.getBoard(projectId);
        if (get().projectId === projectId) set({ board, loading: false });
      } catch (err) {
        useUi.getState().toast(`Falha ao abrir o quadro: ${(err as Error).message}`, 'error');
        set({ loading: false });
      }
    },

    close: () => {
      const { projectId } = get();
      if (projectId) {
        // último lote antes de sair (senão a mudança final se perderia)
        void flush(projectId);
        void api.sendBoardCursor(projectId, 0, 0, false).catch(() => undefined);
      }
      set({ projectId: undefined, board: undefined, selectedId: undefined, cursors: {} });
    },

    resync: async () => {
      const { projectId } = get();
      if (!projectId) return;
      try {
        const board = await api.getBoard(projectId);
        if (get().projectId === projectId) set({ board });
      } catch {
        // transitório; o próximo evento com buraco tenta de novo
      }
    },

    select: (id) => set({ selectedId: id }),
    setActiveNote: (id) => set({ activeNoteId: id }),

    apply: (ops) => {
      const { board, projectId } = get();
      if (!board || !projectId) return;
      set({ board: applyOpsTo(board, ops) });
      // coalesce: upsert repetido da mesma nota (drag/digitação) mantém só o último
      for (const op of ops) {
        if (op.type === 'note_upsert') {
          queue = queue.filter(
            (q) => !(q.type === 'note_upsert' && q.note.id === op.note.id),
          );
        }
        queue.push(op);
      }
      scheduleFlush(projectId);
    },

    applyRemote: (event) => {
      const { projectId, board, activeNoteId } = get();
      if (event.projectId !== projectId || !board) return;
      if (event.revision <= board.revision) return; // eco atrasado/já visto
      if (event.revision > board.revision + 1) {
        // evento perdido no vácuo: estado local não é confiável — refetch
        void get().resync();
        return;
      }
      // o próprio eco confirma e avança a revision. A nota em edição/arrasto
      // ativo nesta aba nunca é sobrescrita por evento (nem pelo eco, nem por
      // outra pessoa): a versão local é a mais nova e o próximo flush a envia.
      const next = applyOpsTo(board, event.ops, activeNoteId);
      set({ board: { ...next, revision: event.revision } });
    },

    applyCursor: (event) => {
      const { projectId, cursors } = get();
      if (event.projectId !== projectId) return;
      if (!event.active) {
        const { [event.clientId]: _gone, ...rest } = cursors;
        set({ cursors: rest });
        return;
      }
      set({
        cursors: {
          ...cursors,
          [event.clientId]: {
            name: event.name,
            color: event.color,
            x: event.x,
            y: event.y,
            at: Date.now(),
          },
        },
      });
    },

    pruneCursors: () => {
      const { cursors } = get();
      const now = Date.now();
      const alive = Object.fromEntries(
        Object.entries(cursors).filter(([, c]) => now - c.at < 6000),
      );
      if (Object.keys(alive).length !== Object.keys(cursors).length) set({ cursors: alive });
    },
  };
});

/** Nota nova com defaults sensatos (id/tempos preenchidos aqui). */
export function newNote(x: number, y: number, author: string): BoardNote {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    x,
    y,
    w: 220,
    color: 'yellow',
    text: '',
    author,
    createdAt: now,
    updatedAt: now,
  };
}

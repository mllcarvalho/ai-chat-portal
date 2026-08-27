import { create } from 'zustand';
import type {
  BoardNote,
  BoardOp,
  BoardShape,
  BoardShapeKind,
  BoardState,
  BoardText,
  PortalEvents,
} from '@aiportal/shared';
import { api, clientId } from '../api/client';
import { uuid } from '../lib/compat';
import { useUi } from './uiStore';

/**
 * Quadro colaborativo no cliente. Modelo de sincronização:
 * - mutação local aplica otimista e enfileira a operação (flush a cada 150ms);
 * - todo mundo (inclusive esta aba) recebe as operações pelo canal de eventos
 *   com a `revision` resultante — aplicar é idempotente, então o próprio eco
 *   serve de confirmação e avança a revision local;
 * - revision com buraco = evento perdido → refetch do quadro inteiro;
 * - o eco NUNCA sobrescreve um elemento que esta aba editou há pouco: entre
 *   o flush e o eco a pessoa pode já ter mexido de novo (arrasto contínuo),
 *   e um eco intermediário faria o card "pular para trás".
 */

/** Janela em que o eco do próprio lote é ignorado para um elemento editado aqui. */
const OWN_EDIT_GRACE_MS = 1500;

interface RemoteCursor {
  name: string;
  color: string;
  x: number;
  y: number;
  at: number;
}

/** Seleção: um elemento de qualquer tipo. */
export interface BoardSelection {
  kind: 'note' | 'text' | 'shape';
  id: string;
}

interface BoardUiState {
  projectId?: string;
  board?: BoardState;
  loading: boolean;
  selected?: BoardSelection;
  /** Elemento com edição/arrasto EM CURSO nesta aba (eco nunca sobrescreve). */
  activeId?: string;
  cursors: Record<string, RemoteCursor>;

  open: (projectId: string) => Promise<void>;
  close: () => void;
  resync: () => Promise<void>;
  select: (selection?: BoardSelection) => void;
  setActive: (id?: string) => void;
  /** Aplica localmente e enfileira para o servidor. */
  apply: (ops: BoardOp[]) => void;
  applyRemote: (event: PortalEvents['board_op']) => void;
  applyCursor: (event: PortalEvents['board_cursor']) => void;
  /** Remove cursores parados há mais de 6s (aba fechada sem aviso). */
  pruneCursors: () => void;
}

/** Ids editados localmente e quando — o eco desses é ignorado por um instante. */
const ownEdits = new Map<string, number>();

function opTargetId(op: BoardOp): string {
  switch (op.type) {
    case 'note_upsert':
      return op.note.id;
    case 'text_upsert':
      return op.text.id;
    case 'shape_upsert':
      return op.shape.id;
    case 'comment_add':
      return op.comment.id;
    default:
      return op.id;
  }
}

function replaceOrAdd<T extends { id: string }>(list: T[], item: T): T[] {
  return list.some((n) => n.id === item.id)
    ? list.map((n) => (n.id === item.id ? item : n))
    : [...list, item];
}

function applyOpsTo(board: BoardState, ops: BoardOp[], skip: (id: string) => boolean): BoardState {
  let { notes, comments, texts, shapes } = board;
  for (const op of ops) {
    switch (op.type) {
      case 'note_upsert':
        if (!skip(op.note.id)) notes = replaceOrAdd(notes, op.note);
        break;
      case 'note_delete':
        notes = notes.filter((n) => n.id !== op.id);
        comments = comments.filter((c) => c.noteId !== op.id);
        break;
      case 'comment_add':
        if (!comments.some((c) => c.id === op.comment.id)) comments = [...comments, op.comment];
        break;
      case 'comment_delete':
        comments = comments.filter((c) => c.id !== op.id);
        break;
      case 'text_upsert':
        if (!skip(op.text.id)) texts = replaceOrAdd(texts, op.text);
        break;
      case 'text_delete':
        texts = texts.filter((t) => t.id !== op.id);
        break;
      case 'shape_upsert':
        if (!skip(op.shape.id)) shapes = replaceOrAdd(shapes, op.shape);
        break;
      case 'shape_delete':
        shapes = shapes.filter((s) => s.id !== op.id);
        break;
    }
  }
  return { ...board, notes, comments, texts, shapes };
}

/** Quadros vindos de servidor antigo podem não ter as listas novas. */
function normalize(board: BoardState): BoardState {
  return {
    ...board,
    notes: board.notes ?? [],
    comments: board.comments ?? [],
    texts: board.texts ?? [],
    shapes: board.shapes ?? [],
  };
}

/** Fila de envio: operações locais ainda não enviadas (coalesce por elemento). */
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
      ownEdits.clear();
      set({ projectId, loading: true, board: undefined, selected: undefined, cursors: {} });
      try {
        const board = normalize(await api.getBoard(projectId));
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
      set({ projectId: undefined, board: undefined, selected: undefined, cursors: {} });
    },

    resync: async () => {
      const { projectId } = get();
      if (!projectId) return;
      try {
        const board = normalize(await api.getBoard(projectId));
        if (get().projectId === projectId) set({ board });
      } catch {
        // transitório; o próximo evento com buraco tenta de novo
      }
    },

    select: (selected) => set({ selected }),
    setActive: (id) => set({ activeId: id }),

    apply: (ops) => {
      const { board, projectId } = get();
      if (!board || !projectId) return;
      set({ board: applyOpsTo(board, ops, () => false) });
      const now = Date.now();
      for (const op of ops) {
        const id = opTargetId(op);
        ownEdits.set(id, now);
        // coalesce: upsert repetido do mesmo elemento (arrasto/digitação) mantém só o último
        if (op.type === 'note_upsert' || op.type === 'text_upsert' || op.type === 'shape_upsert') {
          queue = queue.filter((q) => !(q.type === op.type && opTargetId(q) === id));
        }
        queue.push(op);
      }
      scheduleFlush(projectId);
    },

    applyRemote: (event) => {
      const { projectId, board, activeId } = get();
      if (event.projectId !== projectId || !board) return;
      if (event.revision <= board.revision) return; // eco atrasado/já visto
      if (event.revision > board.revision + 1) {
        // evento perdido no vácuo: estado local não é confiável — refetch
        void get().resync();
        return;
      }
      const now = Date.now();
      const skip = (id: string): boolean => {
        // em edição/arrasto ativo aqui: a versão local é sempre a mais nova
        if (id === activeId) return true;
        // eco do próprio lote de um elemento mexido há pouco: o flush
        // seguinte (já na fila) carrega a versão definitiva
        const at = ownEdits.get(id);
        return event.origin === clientId && at !== undefined && now - at < OWN_EDIT_GRACE_MS;
      };
      set({ board: { ...applyOpsTo(board, event.ops, skip), revision: event.revision } });
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

const stamp = () => new Date().toISOString();

/** Nota nova com defaults sensatos (id/tempos preenchidos aqui). */
export function newNote(x: number, y: number, author: string): BoardNote {
  const now = stamp();
  return { id: uuid(), x, y, w: 220, color: 'yellow', text: '', author, createdAt: now, updatedAt: now };
}

export function newText(x: number, y: number, author: string): BoardText {
  const now = stamp();
  return {
    id: uuid(),
    x,
    y,
    w: 260,
    text: '',
    size: 'md',
    color: 'ink',
    author,
    createdAt: now,
    updatedAt: now,
  };
}

export function newShape(
  kind: BoardShapeKind,
  x: number,
  y: number,
  author: string,
  style: Pick<BoardShape, 'stroke' | 'color' | 'width'>,
): BoardShape {
  const now = stamp();
  const base = { id: uuid(), kind, x, y, ...style, author, createdAt: now, updatedAt: now };
  return kind === 'line' || kind === 'arrow' ? { ...base, x2: x, y2: y } : { ...base, w: 0, h: 0 };
}

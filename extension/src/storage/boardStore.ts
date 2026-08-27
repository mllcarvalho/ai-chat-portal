import * as path from 'node:path';
import type {
  BoardComment,
  BoardNote,
  BoardOp,
  BoardShape,
  BoardState,
  BoardText,
} from '@aiportal/shared';
import { emitBus } from '../events/bus';
import { readJson, writeJsonAtomic } from './jsonStore';
import { PROJECT_META_DIR } from './paths';
import { getProject, projectDir } from './projectStore';

/**
 * Quadro colaborativo do projeto (post-its, textos livres, formas e
 * comentários). Persistência num board.json por projeto, sincronização por
 * OPERAÇÕES: o servidor aplica cada lote sobre o estado em memória
 * (single-thread do Node serializa lotes concorrentes), incrementa `revision`
 * e faz broadcast — os clientes aplicam as operações direto; se a revision
 * pular (evento perdido), refazem o GET. Granularidade de conflito = o
 * elemento inteiro (última escrita vence): para um quadro de squad isso
 * resolve; texto co-editado caractere a caractere pediria CRDT, o que não se
 * justifica aqui.
 */

const MAX_NOTES = 500;
const MAX_COMMENTS = 2000;
const MAX_TEXTS = 500;
const MAX_SHAPES = 1000;
const MAX_TEXT = 4000;
const COORD = 20_000;

const cache = new Map<string, BoardState>();

function boardPath(projectId: string): string | undefined {
  const project = getProject(projectId);
  if (!project) return undefined;
  return path.join(projectDir(project), PROJECT_META_DIR, 'board.json');
}

export function getBoard(projectId: string): BoardState | undefined {
  const cached = cache.get(projectId);
  if (cached) return cached;
  const file = boardPath(projectId);
  if (!file) return undefined;
  const stored = readJson<Partial<BoardState>>(file);
  // quadros gravados antes de textos/formas existirem não têm as listas
  const board: BoardState = {
    revision: stored?.revision ?? 0,
    notes: stored?.notes ?? [],
    comments: stored?.comments ?? [],
    texts: stored?.texts ?? [],
    shapes: stored?.shapes ?? [],
    updatedAt: stored?.updatedAt ?? new Date().toISOString(),
  };
  cache.set(projectId, board);
  return board;
}

const clamp = (n: unknown, min: number, max: number, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;

const NOTE_COLORS = ['yellow', 'orange', 'blue', 'green', 'pink', 'purple'] as const;
const STROKE_COLORS = ['ink', 'blue', 'orange', 'green', 'red', 'purple'] as const;
const STROKE_STYLES = ['solid', 'dashed', 'dotted'] as const;
const SHAPE_KINDS = ['line', 'arrow', 'rect', 'ellipse'] as const;
const TEXT_SIZES = ['sm', 'md', 'lg'] as const;

const cleanId = (id: unknown): string => String(id ?? '').slice(0, 64);

/** Normaliza uma nota vinda do cliente (limites de canvas/texto, campos obrigatórios). */
function sanitizeNote(raw: BoardNote, existing: BoardNote | undefined, author: string): BoardNote {
  const now = new Date().toISOString();
  return {
    id: cleanId(raw.id),
    x: clamp(raw.x, -COORD, COORD, 0),
    y: clamp(raw.y, -COORD, COORD, 0),
    w: clamp(raw.w, 140, 640, 220),
    color: oneOf(raw.color, NOTE_COLORS, 'yellow'),
    text: String(raw.text ?? '').slice(0, MAX_TEXT),
    author: existing?.author ?? author,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function sanitizeText(raw: BoardText, existing: BoardText | undefined, author: string): BoardText {
  const now = new Date().toISOString();
  return {
    id: cleanId(raw.id),
    x: clamp(raw.x, -COORD, COORD, 0),
    y: clamp(raw.y, -COORD, COORD, 0),
    w: clamp(raw.w, 80, 1200, 260),
    text: String(raw.text ?? '').slice(0, MAX_TEXT),
    size: oneOf(raw.size, TEXT_SIZES, 'md'),
    color: oneOf(raw.color, STROKE_COLORS, 'ink'),
    author: existing?.author ?? author,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function sanitizeShape(
  raw: BoardShape,
  existing: BoardShape | undefined,
  author: string,
): BoardShape {
  const now = new Date().toISOString();
  const kind = oneOf(raw.kind, SHAPE_KINDS, 'line');
  const base = {
    id: cleanId(raw.id),
    kind,
    x: clamp(raw.x, -COORD, COORD, 0),
    y: clamp(raw.y, -COORD, COORD, 0),
    stroke: oneOf(raw.stroke, STROKE_STYLES, 'solid'),
    color: oneOf(raw.color, STROKE_COLORS, 'ink'),
    width: clamp(raw.width, 1, 8, 2),
    author: existing?.author ?? author,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return kind === 'line' || kind === 'arrow'
    ? { ...base, x2: clamp(raw.x2, -COORD, COORD, base.x + 100), y2: clamp(raw.y2, -COORD, COORD, base.y) }
    : { ...base, w: clamp(raw.w, 4, 4000, 200), h: clamp(raw.h, 4, 4000, 120) };
}

/** Insere ou substitui pelo id, respeitando o teto de itens. */
function upsert<T extends { id: string }>(list: T[], item: T, max: number): boolean {
  const idx = list.findIndex((n) => n.id === item.id);
  if (idx >= 0) {
    list[idx] = item;
    return true;
  }
  if (list.length >= max) return false;
  list.push(item);
  return true;
}

/**
 * Aplica um lote de operações e persiste. Retorna a revision resultante (ou
 * undefined se o projeto não existe). Broadcast com a origem para a aba
 * causadora ignorar o próprio eco.
 */
export function applyBoardOps(
  projectId: string,
  ops: BoardOp[],
  author: string,
  origin?: string,
): number | undefined {
  const board = getBoard(projectId);
  const file = boardPath(projectId);
  if (!board || !file) return undefined;

  const applied: BoardOp[] = [];
  for (const op of ops) {
    if (op.type === 'note_upsert' && op.note?.id) {
      const existing = board.notes.find((n) => n.id === op.note.id);
      const note = sanitizeNote(op.note, existing, author);
      if (upsert(board.notes, note, MAX_NOTES)) applied.push({ type: 'note_upsert', note });
    } else if (op.type === 'note_delete' && op.id) {
      board.notes = board.notes.filter((n) => n.id !== op.id);
      board.comments = board.comments.filter((c) => c.noteId !== op.id);
      applied.push(op);
    } else if (op.type === 'comment_add' && op.comment?.id && op.comment.noteId) {
      if (board.comments.length >= MAX_COMMENTS) continue;
      if (!board.notes.some((n) => n.id === op.comment.noteId)) continue;
      const comment: BoardComment = {
        id: cleanId(op.comment.id),
        noteId: op.comment.noteId,
        author,
        text: String(op.comment.text ?? '').slice(0, MAX_TEXT),
        createdAt: new Date().toISOString(),
      };
      if (!comment.text.trim()) continue;
      board.comments.push(comment);
      applied.push({ type: 'comment_add', comment });
    } else if (op.type === 'comment_delete' && op.id) {
      board.comments = board.comments.filter((c) => c.id !== op.id);
      applied.push(op);
    } else if (op.type === 'text_upsert' && op.text?.id) {
      const existing = board.texts.find((t) => t.id === op.text.id);
      const text = sanitizeText(op.text, existing, author);
      if (upsert(board.texts, text, MAX_TEXTS)) applied.push({ type: 'text_upsert', text });
    } else if (op.type === 'text_delete' && op.id) {
      board.texts = board.texts.filter((t) => t.id !== op.id);
      applied.push(op);
    } else if (op.type === 'shape_upsert' && op.shape?.id) {
      const existing = board.shapes.find((s) => s.id === op.shape.id);
      const shape = sanitizeShape(op.shape, existing, author);
      if (upsert(board.shapes, shape, MAX_SHAPES)) applied.push({ type: 'shape_upsert', shape });
    } else if (op.type === 'shape_delete' && op.id) {
      board.shapes = board.shapes.filter((s) => s.id !== op.id);
      applied.push(op);
    }
  }

  if (!applied.length) return board.revision;
  board.revision += 1;
  board.updatedAt = new Date().toISOString();
  writeJsonAtomic(file, board);
  emitBus('board_op', { projectId, revision: board.revision, ops: applied, origin });
  return board.revision;
}

/** Projeto excluído/renomeado: derruba o cache para reler do disco. */
export function dropBoardCache(projectId: string): void {
  cache.delete(projectId);
}

import * as path from 'node:path';
import type { BoardComment, BoardNote, BoardOp, BoardState } from '@aiportal/shared';
import { emitBus } from '../events/bus';
import { readJson, writeJsonAtomic } from './jsonStore';
import { PROJECT_META_DIR } from './paths';
import { getProject, projectDir } from './projectStore';

/**
 * Quadro colaborativo do projeto (post-its + comentários). Persistência num
 * board.json por projeto, sincronização por OPERAÇÕES: o servidor aplica cada
 * lote sobre o estado em memória (single-thread do Node serializa lotes
 * concorrentes), incrementa `revision` e faz broadcast — os clientes aplicam
 * as operações direto; se a revision pular (evento perdido), refazem o GET.
 * Granularidade de conflito = a nota inteira (última escrita vence): para
 * post-its de squad isso resolve; texto co-editado caractere a caractere
 * pediria CRDT, o que não se justifica aqui.
 */

const MAX_NOTES = 500;
const MAX_COMMENTS = 2000;
const MAX_TEXT = 4000;

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
  const board = readJson<BoardState>(file) ?? {
    revision: 0,
    notes: [],
    comments: [],
    updatedAt: new Date().toISOString(),
  };
  cache.set(projectId, board);
  return board;
}

const clamp = (n: unknown, min: number, max: number, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;

const COLORS = new Set(['yellow', 'orange', 'blue', 'green', 'pink', 'purple']);

/** Normaliza uma nota vinda do cliente (limites de canvas/texto, campos obrigatórios). */
function sanitizeNote(raw: BoardNote, existing: BoardNote | undefined, author: string): BoardNote {
  const now = new Date().toISOString();
  return {
    id: String(raw.id).slice(0, 64),
    x: clamp(raw.x, -20_000, 20_000, 0),
    y: clamp(raw.y, -20_000, 20_000, 0),
    w: clamp(raw.w, 140, 640, 220),
    color: COLORS.has(raw.color) ? raw.color : 'yellow',
    text: String(raw.text ?? '').slice(0, MAX_TEXT),
    author: existing?.author ?? author,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
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
      if (!existing && board.notes.length >= MAX_NOTES) continue;
      const note = sanitizeNote(op.note, existing, author);
      if (existing) Object.assign(existing, note);
      else board.notes.push(note);
      applied.push({ type: 'note_upsert', note });
    } else if (op.type === 'note_delete' && op.id) {
      board.notes = board.notes.filter((n) => n.id !== op.id);
      board.comments = board.comments.filter((c) => c.noteId !== op.id);
      applied.push(op);
    } else if (op.type === 'comment_add' && op.comment?.id && op.comment.noteId) {
      if (board.comments.length >= MAX_COMMENTS) continue;
      if (!board.notes.some((n) => n.id === op.comment.noteId)) continue;
      const comment: BoardComment = {
        id: String(op.comment.id).slice(0, 64),
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Circle,
  MessageSquareText,
  Minus,
  MousePointer2,
  MoveRight,
  Send,
  Square,
  StickyNote,
  Trash2,
  Type,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  BoardNote,
  BoardNoteColor,
  BoardShape,
  BoardShapeKind,
  BoardStrokeColor,
  BoardStrokeStyle,
  BoardText,
} from '@aiportal/shared';
import { api } from '../../api/client';
import { uuid } from '../../lib/compat';
import { newNote, newShape, newText, useBoard, type BoardSelection } from '../../stores/boardStore';
import { useCollab } from '../../stores/collabStore';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';

/**
 * Quadro do squad. Toda a interação de ponteiro passa por UM lugar (o canvas,
 * com captura de ponteiro): o alvo é descoberto por hit-test nos atributos
 * data-el/data-id dos elementos. Isso evita o que acontecia com handlers
 * espalhados por card (capturas concorrentes, pan disparando durante um
 * arrasto): existe sempre no máximo uma interação em curso.
 */

const NOTE_COLORS: BoardNoteColor[] = ['yellow', 'orange', 'blue', 'green', 'pink', 'purple'];
const STROKE_COLORS: BoardStrokeColor[] = ['ink', 'blue', 'orange', 'green', 'red', 'purple'];
const STROKE_HEX: Record<BoardStrokeColor, string> = {
  ink: '#26324e',
  blue: '#1d4fa0',
  orange: '#ec7000',
  green: '#178246',
  red: '#c93a2c',
  purple: '#7c3aed',
};
const STROKE_STYLES: Array<{ id: BoardStrokeStyle; label: string }> = [
  { id: 'solid', label: 'Sólido' },
  { id: 'dashed', label: 'Tracejado' },
  { id: 'dotted', label: 'Pontilhado' },
];
const WIDTHS = [2, 3, 5];
const TEXT_SIZES: Array<{ id: BoardText['size']; label: string }> = [
  { id: 'sm', label: 'Pequeno' },
  { id: 'md', label: 'Médio' },
  { id: 'lg', label: 'Grande' },
];
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2;
/** Arrasto menor que isto é clique: não cria forma nem conta como movimento. */
const DRAG_THRESHOLD = 3;

type Tool = 'select' | 'note' | 'text' | BoardShapeKind;

const TOOLS: Array<{ id: Tool; label: string; icon: JSX.Element }> = [
  { id: 'select', label: 'Selecionar / mover (V)', icon: <MousePointer2 className="icon" aria-hidden /> },
  { id: 'note', label: 'Post-it (N)', icon: <StickyNote className="icon" aria-hidden /> },
  { id: 'text', label: 'Texto livre (T)', icon: <Type className="icon" aria-hidden /> },
  { id: 'line', label: 'Linha (L)', icon: <Minus className="icon" aria-hidden /> },
  { id: 'arrow', label: 'Seta (A)', icon: <MoveRight className="icon" aria-hidden /> },
  { id: 'rect', label: 'Retângulo (R)', icon: <Square className="icon" aria-hidden /> },
  { id: 'ellipse', label: 'Elipse (E)', icon: <Circle className="icon" aria-hidden /> },
];
const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  n: 'note',
  t: 'text',
  l: 'line',
  a: 'arrow',
  r: 'rect',
  e: 'ellipse',
};

type Interaction =
  | { kind: 'pan'; startX: number; startY: number; baseX: number; baseY: number }
  | {
      kind: 'move';
      sel: BoardSelection;
      startX: number;
      startY: number;
      origin: { x: number; y: number; x2?: number; y2?: number };
      moved: boolean;
    }
  | {
      kind: 'draw';
      id: string;
      shapeKind: BoardShapeKind;
      startX: number;
      startY: number;
      created: boolean;
    }
  | { kind: 'endpoint'; id: string; which: 1 | 2 }
  | { kind: 'resize'; id: string };

/** Iniciais para o avatar de presença ("Ana Souza" → "AS"). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

const stamped = <T extends { updatedAt: string }>(item: T): T => ({
  ...item,
  updatedAt: new Date().toISOString(),
});

/** Textarea que acompanha o conteúdo (sem depender de field-sizing). */
function AutoTextarea(props: {
  value: string;
  placeholder: string;
  className: string;
  autoFocus?: boolean;
  onChange: (value: string) => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [props.value]);
  useEffect(() => {
    if (props.autoFocus) ref.current?.focus();
    // só na montagem: o foco é para a criação, não para cada re-render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <textarea
      ref={ref}
      className={props.className}
      value={props.value}
      placeholder={props.placeholder}
      rows={1}
      onChange={(e) => props.onChange(e.target.value)}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
    />
  );
}

function dashArray(shape: BoardShape): string | undefined {
  if (shape.stroke === 'dashed') return `${shape.width * 4} ${shape.width * 3}`;
  if (shape.stroke === 'dotted') return `0.1 ${shape.width * 2.5}`;
  return undefined;
}

function ShapeView(props: { shape: BoardShape; selected: boolean; zoom: number }) {
  const { shape, selected, zoom } = props;
  const color = STROKE_HEX[shape.color];
  const common = {
    stroke: color,
    strokeWidth: shape.width,
    strokeDasharray: dashArray(shape),
    strokeLinecap: 'round' as const,
    fill: 'none',
  };
  // área de clique bem mais larga que o traço (mirar numa linha de 2px é chato)
  const hit = { stroke: 'transparent', strokeWidth: Math.max(14, shape.width * 3), fill: 'none' };
  const handle = 6 / zoom;
  const w = shape.w ?? 0;
  const h = shape.h ?? 0;
  const x2 = shape.x2 ?? shape.x;
  const y2 = shape.y2 ?? shape.y;
  const isLine = shape.kind === 'line' || shape.kind === 'arrow';
  return (
    <g
      data-el="shape"
      data-id={shape.id}
      className={selected ? 'board-shape board-shape--selected' : 'board-shape'}
    >
      {isLine ? (
        <>
          <line x1={shape.x} y1={shape.y} x2={x2} y2={y2} {...hit} />
          <line
            x1={shape.x}
            y1={shape.y}
            x2={x2}
            y2={y2}
            {...common}
            markerEnd={shape.kind === 'arrow' ? `url(#arrow-${shape.color})` : undefined}
          />
        </>
      ) : shape.kind === 'rect' ? (
        <>
          <rect x={shape.x} y={shape.y} width={w} height={h} {...hit} />
          <rect x={shape.x} y={shape.y} width={w} height={h} rx={4} {...common} />
        </>
      ) : (
        <>
          <ellipse cx={shape.x + w / 2} cy={shape.y + h / 2} rx={w / 2} ry={h / 2} {...hit} />
          <ellipse cx={shape.x + w / 2} cy={shape.y + h / 2} rx={w / 2} ry={h / 2} {...common} />
        </>
      )}
      {selected && isLine && (
        <>
          <circle data-el="endpoint" data-id={shape.id} data-which="1" className="board-handle" cx={shape.x} cy={shape.y} r={handle} />
          <circle data-el="endpoint" data-id={shape.id} data-which="2" className="board-handle" cx={x2} cy={y2} r={handle} />
        </>
      )}
      {selected && !isLine && (
        <>
          <rect className="board-selection-box" x={shape.x} y={shape.y} width={w} height={h} strokeWidth={1 / zoom} />
          <rect
            data-el="resize"
            data-id={shape.id}
            className="board-handle"
            x={shape.x + w - handle}
            y={shape.y + h - handle}
            width={handle * 2}
            height={handle * 2}
          />
        </>
      )}
    </g>
  );
}

export function BoardView() {
  const viewProjectId = useSessions((s) => s.viewProjectId);
  const projects = useSessions((s) => s.projects);
  const setView = useUi((s) => s.setView);
  const board = useBoard((s) => s.board);
  const loading = useBoard((s) => s.loading);
  const selected = useBoard((s) => s.selected);
  const cursors = useBoard((s) => s.cursors);
  const openBoard = useBoard((s) => s.open);
  const closeBoard = useBoard((s) => s.close);
  const select = useBoard((s) => s.select);
  const setActive = useBoard((s) => s.setActive);
  const apply = useBoard((s) => s.apply);
  const pruneCursors = useBoard((s) => s.pruneCursors);
  const identity = useCollab((s) => s.identity);
  const peers = useCollab((s) => s.peers);
  const setViewing = useCollab((s) => s.setViewing);

  const project = projects.find((p) => p.id === viewProjectId);
  const [pan, setPan] = useState({ x: 80, y: 60 });
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState<Tool>('select');
  const [style, setStyle] = useState<{ stroke: BoardStrokeStyle; color: BoardStrokeColor; width: number }>({
    stroke: 'solid',
    color: 'ink',
    width: 2,
  });
  const [panning, setPanning] = useState(false);
  const [commentsFor, setCommentsFor] = useState<string | undefined>();
  const [commentDraft, setCommentDraft] = useState('');
  const [freshId, setFreshId] = useState<string>();
  const canvasRef = useRef<HTMLDivElement>(null);
  const interaction = useRef<Interaction | null>(null);
  // pan/zoom/board também em refs: os handlers de ponteiro leem o valor atual
  // sem depender de re-render (o React pode ainda não ter aplicado o setState)
  const view = useRef({ pan, zoom });
  view.current = { pan, zoom };
  const boardRef = useRef(board);
  boardRef.current = board;
  const lastCursorSent = useRef(0);

  useEffect(() => {
    if (!viewProjectId) return;
    void openBoard(viewProjectId);
    setViewing({ projectId: viewProjectId, board: true });
    return () => {
      closeBoard();
      setViewing({});
    };
  }, [viewProjectId, openBoard, closeBoard, setViewing]);

  useEffect(() => {
    const timer = setInterval(pruneCursors, 2000);
    return () => clearInterval(timer);
  }, [pruneCursors]);

  const myName = identity?.name ?? 'Você';

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const { pan: p, zoom: z } = view.current;
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left - p.x) / z, y: (clientY - rect.top - p.y) / z };
  }, []);

  const findNote = (id: string) => boardRef.current?.notes.find((n) => n.id === id);
  const findText = (id: string) => boardRef.current?.texts.find((t) => t.id === id);
  const findShape = (id: string) => boardRef.current?.shapes.find((s) => s.id === id);

  const upsertNote = useCallback(
    (note: BoardNote) => apply([{ type: 'note_upsert', note: stamped(note) }]),
    [apply],
  );
  const upsertText = useCallback(
    (text: BoardText) => apply([{ type: 'text_upsert', text: stamped(text) }]),
    [apply],
  );
  const upsertShape = useCallback(
    (shape: BoardShape) => apply([{ type: 'shape_upsert', shape: stamped(shape) }]),
    [apply],
  );

  const deleteSelection = useCallback(
    (sel: BoardSelection | undefined = useBoard.getState().selected) => {
      if (!sel) return;
      if (sel.kind === 'note') apply([{ type: 'note_delete', id: sel.id }]);
      else if (sel.kind === 'text') apply([{ type: 'text_delete', id: sel.id }]);
      else apply([{ type: 'shape_delete', id: sel.id }]);
      select(undefined);
      setCommentsFor((c) => (c === sel.id ? undefined : c));
    },
    [apply, select],
  );

  // ---- zoom mantendo o ponto sob o cursor parado (sem cursor: o centro) ----
  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const { pan: p, zoom: z } = view.current;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor));
    if (next === z) return;
    const mx = clientX !== undefined && rect ? clientX - rect.left : (rect?.width ?? 0) / 2;
    const my = clientY !== undefined && rect ? clientY - rect.top : (rect?.height ?? 0) / 2;
    const ratio = next / z;
    setPan({ x: mx - (mx - p.x) * ratio, y: my - (my - p.y) * ratio });
    setZoom(next);
  }, []);

  // wheel nativo (não-passivo): o React registra onWheel como passivo e não
  // deixa cancelar o scroll/zoom da página. Durante uma interação de arrasto
  // a roda é IGNORADA — um scroll de inércia do trackpad no meio de um arrasto
  // movia o mundo inteiro debaixo do card (o "arrasta um, movem todos").
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (interaction.current) return;
      if (e.ctrlKey || e.metaKey) zoomAt(e.deltaY < 0 ? 1.1 : 0.9, e.clientX, e.clientY);
      else setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // ---- teclado: apagar seleção, Esc, atalhos de ferramenta ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target?.closest('textarea, input, [contenteditable]');
      if (e.key === 'Escape') {
        target?.blur?.();
        select(undefined);
        setTool('select');
        return;
      }
      if (typing) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (useBoard.getState().selected) {
          e.preventDefault();
          deleteSelection();
        }
        return;
      }
      const t = TOOL_KEYS[e.key.toLowerCase()];
      if (t && !e.metaKey && !e.ctrlKey && !e.altKey) setTool(t);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteSelection, select]);

  // ---- ponteiro: uma interação por vez, sempre capturada pelo canvas ----
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // controles nativos (digitar, botões, painéis) seguem o fluxo normal do browser
    if (target.closest('textarea, input, button, .board-el-toolbar, .board-comments')) return;
    const canvas = e.currentTarget as HTMLElement;
    const hit = target.closest<HTMLElement>('[data-el]');
    const world = toWorld(e.clientX, e.clientY);

    if (hit?.dataset.el && hit.dataset.id) {
      const id = hit.dataset.id;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      if (hit.dataset.el === 'endpoint') {
        select({ kind: 'shape', id });
        setActive(id);
        interaction.current = { kind: 'endpoint', id, which: hit.dataset.which === '1' ? 1 : 2 };
        return;
      }
      if (hit.dataset.el === 'resize') {
        select({ kind: 'shape', id });
        setActive(id);
        interaction.current = { kind: 'resize', id };
        return;
      }
      const kind = hit.dataset.el as BoardSelection['kind'];
      const item = kind === 'note' ? findNote(id) : kind === 'text' ? findText(id) : findShape(id);
      if (!item) return;
      const shape = kind === 'shape' ? (item as BoardShape) : undefined;
      select({ kind, id });
      setTool('select');
      setActive(id);
      interaction.current = {
        kind: 'move',
        sel: { kind, id },
        startX: e.clientX,
        startY: e.clientY,
        origin: { x: item.x, y: item.y, x2: shape?.x2, y2: shape?.y2 },
        moved: false,
      };
      return;
    }

    // canvas vazio
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    if (tool === 'select') {
      select(undefined);
      const { pan: p } = view.current;
      interaction.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, baseX: p.x, baseY: p.y };
      setPanning(true);
      return;
    }
    if (tool === 'note') {
      const note = newNote(Math.round(world.x - 110), Math.round(world.y - 16), myName);
      apply([{ type: 'note_upsert', note }]);
      select({ kind: 'note', id: note.id });
      setFreshId(note.id);
      setTool('select');
      return;
    }
    if (tool === 'text') {
      const text = newText(Math.round(world.x), Math.round(world.y - 12), myName);
      apply([{ type: 'text_upsert', text }]);
      select({ kind: 'text', id: text.id });
      setFreshId(text.id);
      setTool('select');
      return;
    }
    // ferramentas de forma: a forma só nasce quando o arrasto passa do limiar
    interaction.current = {
      kind: 'draw',
      id: uuid(),
      shapeKind: tool,
      startX: world.x,
      startY: world.y,
      created: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const it = interaction.current;
    const { zoom: z } = view.current;
    const world = toWorld(e.clientX, e.clientY);

    if (it?.kind === 'pan') {
      setPan({ x: it.baseX + (e.clientX - it.startX), y: it.baseY + (e.clientY - it.startY) });
    } else if (it?.kind === 'move') {
      const dx = (e.clientX - it.startX) / z;
      const dy = (e.clientY - it.startY) / z;
      if (!it.moved && Math.hypot(e.clientX - it.startX, e.clientY - it.startY) < DRAG_THRESHOLD) return;
      it.moved = true;
      const nx = Math.round(it.origin.x + dx);
      const ny = Math.round(it.origin.y + dy);
      if (it.sel.kind === 'note') {
        const n = findNote(it.sel.id);
        if (n) upsertNote({ ...n, x: nx, y: ny });
      } else if (it.sel.kind === 'text') {
        const t = findText(it.sel.id);
        if (t) upsertText({ ...t, x: nx, y: ny });
      } else {
        const s = findShape(it.sel.id);
        if (s) {
          upsertShape({
            ...s,
            x: nx,
            y: ny,
            ...(it.origin.x2 !== undefined ? { x2: Math.round(it.origin.x2 + dx) } : {}),
            ...(it.origin.y2 !== undefined ? { y2: Math.round(it.origin.y2 + dy) } : {}),
          });
        }
      }
    } else if (it?.kind === 'draw') {
      const dist = Math.hypot((world.x - it.startX) * z, (world.y - it.startY) * z);
      if (!it.created && dist < DRAG_THRESHOLD) return;
      const existing = findShape(it.id);
      if (!existing) {
        it.created = true;
        select({ kind: 'shape', id: it.id });
        setActive(it.id);
      }
      const shape: BoardShape = {
        ...(existing ??
          newShape(it.shapeKind, Math.round(it.startX), Math.round(it.startY), myName, style)),
        id: it.id,
      };
      if (it.shapeKind === 'line' || it.shapeKind === 'arrow') {
        shape.x2 = Math.round(world.x);
        shape.y2 = Math.round(world.y);
      } else {
        // caixa normalizada: dá para arrastar em qualquer direção
        shape.x = Math.round(Math.min(it.startX, world.x));
        shape.y = Math.round(Math.min(it.startY, world.y));
        shape.w = Math.round(Math.abs(world.x - it.startX));
        shape.h = Math.round(Math.abs(world.y - it.startY));
      }
      upsertShape(shape);
    } else if (it?.kind === 'endpoint') {
      const s = findShape(it.id);
      if (s) {
        upsertShape(
          it.which === 1
            ? { ...s, x: Math.round(world.x), y: Math.round(world.y) }
            : { ...s, x2: Math.round(world.x), y2: Math.round(world.y) },
        );
      }
    } else if (it?.kind === 'resize') {
      const s = findShape(it.id);
      if (s) {
        upsertShape({
          ...s,
          w: Math.max(4, Math.round(world.x - s.x)),
          h: Math.max(4, Math.round(world.y - s.y)),
        });
      }
    }

    // cursor compartilhado (throttle ~12/s; só faz sentido com mais gente aqui)
    const now = Date.now();
    if (viewProjectId && peers.length > 1 && now - lastCursorSent.current > 80) {
      lastCursorSent.current = now;
      void api
        .sendBoardCursor(viewProjectId, Math.round(world.x), Math.round(world.y), true)
        .catch(() => undefined);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const it = interaction.current;
    interaction.current = null;
    setPanning(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // captura já solta (pointercancel) — nada a fazer
    }
    if (!it) return;
    setActive(undefined);
    if (it.kind === 'draw') {
      // clique sem arrasto não cria forma; arrasto minúsculo também não
      const s = findShape(it.id);
      const tiny =
        s &&
        (s.kind === 'line' || s.kind === 'arrow'
          ? Math.hypot((s.x2 ?? s.x) - s.x, (s.y2 ?? s.y) - s.y) < 4
          : (s.w ?? 0) < 4 || (s.h ?? 0) < 4);
      if (s && tiny) {
        apply([{ type: 'shape_delete', id: s.id }]);
        select(undefined);
      }
      setTool('select');
    }
  };

  // ---- estilo do traço: vale para as próximas formas e muda a selecionada na hora ----
  const patchStyle = (patch: Partial<typeof style>) => {
    setStyle((s) => ({ ...s, ...patch }));
    if (selected?.kind === 'shape') {
      const s = findShape(selected.id);
      if (s) upsertShape({ ...s, ...patch });
    }
  };

  const boardViewers = useMemo(
    () => peers.filter((p) => p.viewing?.projectId === viewProjectId && p.viewing?.board),
    [peers, viewProjectId],
  );

  const selectedShape =
    selected?.kind === 'shape' ? board?.shapes.find((s) => s.id === selected.id) : undefined;
  const showStrokeStyle =
    selectedShape !== undefined || (tool !== 'select' && tool !== 'note' && tool !== 'text');
  const currentStyle = selectedShape
    ? { stroke: selectedShape.stroke, color: selectedShape.color, width: selectedShape.width }
    : style;

  const commentsNote = board?.notes.find((n) => n.id === commentsFor);
  const noteComments = useMemo(
    () => (board && commentsFor ? board.comments.filter((c) => c.noteId === commentsFor) : []),
    [board, commentsFor],
  );

  const sendComment = () => {
    const text = commentDraft.trim();
    if (!text || !commentsFor) return;
    apply([
      {
        type: 'comment_add',
        comment: {
          id: uuid(),
          noteId: commentsFor,
          author: myName,
          text,
          createdAt: new Date().toISOString(),
        },
      },
    ]);
    setCommentDraft('');
  };

  if (!project) return null;

  const isEmpty =
    !loading && !!board && !board.notes.length && !board.texts.length && !board.shapes.length;

  return (
    <div className="board">
      <div className="board__toolbar">
        <button className="btn btn--ghost" onClick={() => setView('chat')} title="Voltar para o projeto">
          <ArrowLeft className="icon" aria-hidden /> {project.name}
        </button>
        <span className="board__title">
          <StickyNote className="icon" aria-hidden /> Quadro do squad
        </span>
        <div className="board__presence" title="Quem está no quadro agora">
          {boardViewers.map((peer) => (
            <span
              key={peer.clientId}
              className="collab-avatar"
              style={{ background: peer.color }}
              title={`${peer.name}${peer.role === 'host' ? ' (host)' : ''}`}
            >
              {initials(peer.name)}
            </span>
          ))}
        </div>

        <div className="board__tools" role="toolbar" aria-label="Ferramentas do quadro">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`board-tool${tool === t.id ? ' board-tool--active' : ''}`}
              title={t.label}
              onClick={() => {
                setTool(t.id);
                if (t.id !== 'select') select(undefined);
              }}
            >
              {t.icon}
            </button>
          ))}
        </div>

        {showStrokeStyle && (
          <div className="board__style" aria-label="Estilo do traço">
            {STROKE_STYLES.map((s) => (
              <button
                key={s.id}
                className={`board-tool board-tool--stroke${currentStyle.stroke === s.id ? ' board-tool--active' : ''}`}
                title={s.label}
                onClick={() => patchStyle({ stroke: s.id })}
              >
                <svg width="22" height="8" viewBox="0 0 22 8" aria-hidden>
                  <line
                    x1="1"
                    y1="4"
                    x2="21"
                    y2="4"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeDasharray={s.id === 'dashed' ? '5 3' : s.id === 'dotted' ? '0.1 3.5' : undefined}
                  />
                </svg>
              </button>
            ))}
            <span className="board__style-sep" />
            {STROKE_COLORS.map((c) => (
              <button
                key={c}
                className={`board-swatch${currentStyle.color === c ? ' board-swatch--current' : ''}`}
                style={{ background: STROKE_HEX[c] }}
                title={c}
                onClick={() => patchStyle({ color: c })}
              />
            ))}
            <span className="board__style-sep" />
            {WIDTHS.map((w) => (
              <button
                key={w}
                className={`board-tool board-tool--stroke${currentStyle.width === w ? ' board-tool--active' : ''}`}
                title={`Espessura ${w}`}
                onClick={() => patchStyle({ width: w })}
              >
                <svg width="22" height="10" viewBox="0 0 22 10" aria-hidden>
                  <line x1="2" y1="5" x2="20" y2="5" stroke="currentColor" strokeWidth={w} strokeLinecap="round" />
                </svg>
              </button>
            ))}
          </div>
        )}

        <div className="board__actions">
          {selected && (
            <button
              className="btn btn--sm btn--ghost"
              onClick={() => deleteSelection()}
              title="Excluir selecionado (Delete)"
            >
              <Trash2 className="icon" aria-hidden />
            </button>
          )}
          <button className="btn btn--sm" onClick={() => zoomAt(0.9)} title="Afastar">
            <ZoomOut className="icon" aria-hidden />
          </button>
          <span className="board__zoom">{Math.round(zoom * 100)}%</span>
          <button className="btn btn--sm" onClick={() => zoomAt(1.1)} title="Aproximar">
            <ZoomIn className="icon" aria-hidden />
          </button>
        </div>
      </div>

      <div
        ref={canvasRef}
        className={`board__canvas${panning ? ' board__canvas--dragging' : ''}${
          tool !== 'select' ? ' board__canvas--tool' : ''
        }`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {loading && <div className="board__hint">Carregando o quadro…</div>}
        {isEmpty && (
          <div className="board__hint">
            Escolha uma ferramenta na barra (post-it, texto, linha, seta, caixa) e clique ou
            arraste no quadro. Todo mundo do projeto vê e edita o mesmo quadro, ao vivo.
          </div>
        )}
        <div
          className="board__world"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          <svg className="board-shapes" width="1" height="1">
            <defs>
              {STROKE_COLORS.map((c) => (
                <marker
                  key={c}
                  id={`arrow-${c}`}
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                  markerUnits="strokeWidth"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={STROKE_HEX[c]} />
                </marker>
              ))}
            </defs>
            {board?.shapes.map((shape) => (
              <ShapeView key={shape.id} shape={shape} selected={selected?.id === shape.id} zoom={zoom} />
            ))}
          </svg>

          {board?.texts.map((text) => {
            const isSel = selected?.id === text.id;
            return (
              <div
                key={text.id}
                data-el="text"
                data-id={text.id}
                className={`board-text board-text--${text.size}${isSel ? ' board-text--selected' : ''}`}
                style={{ left: text.x, top: text.y, width: text.w, color: STROKE_HEX[text.color] }}
              >
                <AutoTextarea
                  className="board-text__input"
                  value={text.text}
                  placeholder="Texto…"
                  autoFocus={text.id === freshId}
                  onChange={(value) => upsertText({ ...text, text: value })}
                  onFocus={() => setActive(text.id)}
                  onBlur={() => setActive(undefined)}
                />
                {isSel && (
                  <div className="board-el-toolbar">
                    {TEXT_SIZES.map((size) => (
                      <button
                        key={size.id}
                        className={`board-tool board-tool--stroke board-tool--size-${size.id}${
                          text.size === size.id ? ' board-tool--active' : ''
                        }`}
                        title={size.label}
                        onClick={() => upsertText({ ...text, size: size.id })}
                      >
                        A
                      </button>
                    ))}
                    <span className="board__style-sep" />
                    {STROKE_COLORS.map((c) => (
                      <button
                        key={c}
                        className={`board-swatch${text.color === c ? ' board-swatch--current' : ''}`}
                        style={{ background: STROKE_HEX[c] }}
                        title={c}
                        onClick={() => upsertText({ ...text, color: c })}
                      />
                    ))}
                    <button
                      className="board-note__delete"
                      title="Excluir texto"
                      onClick={() => deleteSelection({ kind: 'text', id: text.id })}
                    >
                      <Trash2 className="icon icon--sm" aria-hidden />
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {board?.notes.map((note) => {
            const isSel = selected?.id === note.id;
            const count = board.comments.filter((c) => c.noteId === note.id).length;
            return (
              <div
                key={note.id}
                data-el="note"
                data-id={note.id}
                className={`board-note board-note--${note.color}${isSel ? ' board-note--selected' : ''}`}
                style={{ left: note.x, top: note.y, width: note.w }}
              >
                <div className="board-note__head">
                  <span className="board-note__author" title={note.author}>
                    {note.author}
                  </span>
                  <button
                    className={`board-note__comments${count ? ' board-note__comments--some' : ''}`}
                    title={count ? `${count} comentário(s)` : 'Comentar'}
                    onClick={() => {
                      select({ kind: 'note', id: note.id });
                      setCommentsFor(note.id);
                    }}
                  >
                    <MessageSquareText className="icon icon--sm" aria-hidden />
                    {count > 0 && <span>{count}</span>}
                  </button>
                </div>
                <AutoTextarea
                  className="board-note__text"
                  value={note.text}
                  placeholder="Escreva…"
                  autoFocus={note.id === freshId}
                  onChange={(value) => upsertNote({ ...note, text: value })}
                  onFocus={() => setActive(note.id)}
                  onBlur={() => setActive(undefined)}
                />
                {isSel && (
                  <div className="board-el-toolbar">
                    {NOTE_COLORS.map((color) => (
                      <button
                        key={color}
                        className={`board-swatch board-swatch--${color}${
                          note.color === color ? ' board-swatch--current' : ''
                        }`}
                        title={color}
                        onClick={() => upsertNote({ ...note, color })}
                      />
                    ))}
                    <button
                      className="board-note__delete"
                      title="Excluir nota"
                      onClick={() => deleteSelection({ kind: 'note', id: note.id })}
                    >
                      <Trash2 className="icon icon--sm" aria-hidden />
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {Object.entries(cursors).map(([id, cursor]) => (
            <div
              key={id}
              className="board-cursor"
              style={{ left: cursor.x, top: cursor.y, color: cursor.color }}
            >
              <svg width="14" height="18" viewBox="0 0 14 18" aria-hidden>
                <path d="M1 1 L13 9 L7.5 10.5 L5 17 Z" fill="currentColor" />
              </svg>
              <span className="board-cursor__name" style={{ background: cursor.color }}>
                {cursor.name}
              </span>
            </div>
          ))}
        </div>
      </div>

      {commentsNote && (
        <aside className="board-comments">
          <div className="board-comments__head">
            <span className="board-comments__title">Comentários</span>
            <button className="btn btn--ghost btn--sm" onClick={() => setCommentsFor(undefined)} title="Fechar">
              <X className="icon" aria-hidden />
            </button>
          </div>
          <p className="board-comments__note">“{commentsNote.text || 'Nota sem texto'}”</p>
          <div className="board-comments__list">
            {noteComments.length === 0 && (
              <p className="board-comments__empty">Nenhum comentário ainda.</p>
            )}
            {noteComments.map((comment) => (
              <div key={comment.id} className="board-comments__item">
                <span className="board-comments__author">{comment.author}</span>
                <span className="board-comments__text">{comment.text}</span>
              </div>
            ))}
          </div>
          <div className="board-comments__composer">
            <input
              value={commentDraft}
              placeholder="Comentar…"
              onChange={(e) => setCommentDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') sendComment();
              }}
            />
            <button className="btn btn--primary btn--sm" onClick={sendComment} title="Enviar">
              <Send className="icon" aria-hidden />
            </button>
          </div>
        </aside>
      )}

      <button
        className="board__zoom-reset"
        onClick={() => {
          setZoom(1);
          setPan({ x: 80, y: 60 });
        }}
        title="Recentralizar o quadro"
      >
        recentralizar
      </button>
    </div>
  );
}

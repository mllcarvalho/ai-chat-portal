import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  MessageSquareText,
  Plus,
  Send,
  StickyNote,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { BoardNote, BoardNoteColor } from '@aiportal/shared';
import { api } from '../../api/client';
import { newNote, useBoard } from '../../stores/boardStore';
import { useCollab } from '../../stores/collabStore';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';

const COLORS: BoardNoteColor[] = ['yellow', 'orange', 'blue', 'green', 'pink', 'purple'];
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2;

/** Iniciais para o avatar de presença ("Ana Souza" → "AS"). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

function NoteCard(props: {
  note: BoardNote;
  zoom: number;
  selected: boolean;
  commentCount: number;
  onSelect: () => void;
  onChange: (note: BoardNote) => void;
  onDelete: () => void;
  onOpenComments: () => void;
  onDragStateChange: (dragging: boolean) => void;
}) {
  const { note, zoom, selected, commentCount } = props;
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number }>();
  const setActiveNote = useBoard((s) => s.setActiveNote);

  const startDrag = (e: React.PointerEvent) => {
    // arrastar pela faixa superior; clique nos controles não arrasta
    if ((e.target as HTMLElement).closest('button, textarea')) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: note.x, baseY: note.y };
    setActiveNote(note.id);
    props.onDragStateChange(true);
    props.onSelect();
  };

  const moveDrag = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    props.onChange({
      ...note,
      x: Math.round(drag.baseX + (e.clientX - drag.startX) / zoom),
      y: Math.round(drag.baseY + (e.clientY - drag.startY) / zoom),
    });
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = undefined;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    setActiveNote(undefined);
    props.onDragStateChange(false);
  };

  return (
    <div
      className={`board-note board-note--${note.color}${selected ? ' board-note--selected' : ''}`}
      style={{ left: note.x, top: note.y, width: note.w }}
      onPointerDown={(e) => {
        e.stopPropagation();
        props.onSelect();
      }}
    >
      <div
        className="board-note__head"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="board-note__author" title={note.author}>
          {note.author}
        </span>
        <button
          className={`board-note__comments${commentCount ? ' board-note__comments--some' : ''}`}
          title={commentCount ? `${commentCount} comentário(s)` : 'Comentar'}
          onClick={(e) => {
            e.stopPropagation();
            props.onOpenComments();
          }}
        >
          <MessageSquareText className="icon icon--sm" aria-hidden />
          {commentCount > 0 && <span>{commentCount}</span>}
        </button>
      </div>
      <textarea
        className="board-note__text"
        value={note.text}
        placeholder="Escreva…"
        onFocus={() => setActiveNote(note.id)}
        onBlur={() => setActiveNote(undefined)}
        onChange={(e) => props.onChange({ ...note, text: e.target.value })}
      />
      {selected && (
        <div className="board-note__toolbar" onPointerDown={(e) => e.stopPropagation()}>
          {COLORS.map((color) => (
            <button
              key={color}
              className={`board-swatch board-swatch--${color}${
                note.color === color ? ' board-swatch--current' : ''
              }`}
              title={color}
              onClick={() => props.onChange({ ...note, color })}
            />
          ))}
          <button className="board-note__delete" title="Excluir nota" onClick={props.onDelete}>
            <Trash2 className="icon icon--sm" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}

export function BoardView() {
  const viewProjectId = useSessions((s) => s.viewProjectId);
  const projects = useSessions((s) => s.projects);
  const setView = useUi((s) => s.setView);
  const board = useBoard((s) => s.board);
  const loading = useBoard((s) => s.loading);
  const selectedId = useBoard((s) => s.selectedId);
  const cursors = useBoard((s) => s.cursors);
  const openBoard = useBoard((s) => s.open);
  const closeBoard = useBoard((s) => s.close);
  const select = useBoard((s) => s.select);
  const apply = useBoard((s) => s.apply);
  const pruneCursors = useBoard((s) => s.pruneCursors);
  const identity = useCollab((s) => s.identity);
  const peers = useCollab((s) => s.peers);
  const setViewing = useCollab((s) => s.setViewing);

  const project = projects.find((p) => p.id === viewProjectId);
  const [pan, setPan] = useState({ x: 80, y: 60 });
  const [zoom, setZoom] = useState(1);
  const [commentsFor, setCommentsFor] = useState<string | undefined>();
  const [commentDraft, setCommentDraft] = useState('');
  const [dragging, setDragging] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number }>();
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

  const toWorld = useCallback(
    (clientX: number, clientY: number) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left - pan.x) / zoom,
        y: (clientY - rect.top - pan.y) / zoom,
      };
    },
    [pan, zoom],
  );

  const myName = identity?.name ?? 'Você';

  const upsertNote = useCallback(
    (note: BoardNote) =>
      apply([{ type: 'note_upsert', note: { ...note, updatedAt: new Date().toISOString() } }]),
    [apply],
  );

  const addNoteAt = (clientX: number, clientY: number) => {
    const { x, y } = toWorld(clientX, clientY);
    const note = newNote(Math.round(x - 110), Math.round(y - 20), myName);
    apply([{ type: 'note_upsert', note }]);
    select(note.id);
  };

  const zoomBy = (factor: number) =>
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor)));

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.1 : 0.9);
    } else {
      setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    }
  };

  const startPan = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    panRef.current = { startX: e.clientX, startY: e.clientY, baseX: pan.x, baseY: pan.y };
    select(undefined);
  };

  const movePointer = (e: React.PointerEvent) => {
    const p = panRef.current;
    if (p) {
      setPan({ x: p.baseX + (e.clientX - p.startX), y: p.baseY + (e.clientY - p.startY) });
    }
    // cursor compartilhado (throttle ~12/s; só faz sentido com mais gente aqui)
    const now = Date.now();
    if (viewProjectId && peers.length > 1 && now - lastCursorSent.current > 80) {
      lastCursorSent.current = now;
      const { x, y } = toWorld(e.clientX, e.clientY);
      void api.sendBoardCursor(viewProjectId, Math.round(x), Math.round(y), true).catch(() => undefined);
    }
  };

  const endPan = (e: React.PointerEvent) => {
    if (!panRef.current) return;
    panRef.current = undefined;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  };

  const boardViewers = useMemo(
    () => peers.filter((p) => p.viewing?.projectId === viewProjectId && p.viewing?.board),
    [peers, viewProjectId],
  );

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
          id: crypto.randomUUID(),
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

  return (
    <div className="board">
      <div className="board__toolbar">
        <button
          className="btn btn--ghost"
          onClick={() => setView('chat')}
          title="Voltar para o projeto"
        >
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
        <div className="board__actions">
          <button
            className="btn btn--primary btn--sm"
            onClick={() => {
              const rect = canvasRef.current?.getBoundingClientRect();
              if (rect) addNoteAt(rect.left + rect.width / 2, rect.top + rect.height / 3);
            }}
          >
            <Plus className="icon" aria-hidden /> Nota
          </button>
          <button className="btn btn--sm" onClick={() => zoomBy(0.9)} title="Afastar">
            <ZoomOut className="icon" aria-hidden />
          </button>
          <span className="board__zoom">{Math.round(zoom * 100)}%</span>
          <button className="btn btn--sm" onClick={() => zoomBy(1.1)} title="Aproximar">
            <ZoomIn className="icon" aria-hidden />
          </button>
        </div>
      </div>

      <div
        ref={canvasRef}
        className={`board__canvas${dragging || panRef.current ? ' board__canvas--dragging' : ''}`}
        onWheel={onWheel}
        onPointerDown={startPan}
        onPointerMove={movePointer}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onDoubleClick={(e) => {
          if (e.target === e.currentTarget) addNoteAt(e.clientX, e.clientY);
        }}
      >
        {loading && <div className="board__hint">Carregando o quadro…</div>}
        {!loading && board && board.notes.length === 0 && (
          <div className="board__hint">
            Dê dois cliques em qualquer lugar (ou use “+ Nota”) para criar o primeiro post-it.
            Todo mundo do projeto vê e edita o mesmo quadro, ao vivo.
          </div>
        )}
        <div
          className="board__world"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          {board?.notes.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              zoom={zoom}
              selected={selectedId === note.id}
              commentCount={board.comments.filter((c) => c.noteId === note.id).length}
              onSelect={() => select(note.id)}
              onChange={upsertNote}
              onDelete={() => {
                apply([{ type: 'note_delete', id: note.id }]);
                if (commentsFor === note.id) setCommentsFor(undefined);
              }}
              onOpenComments={() => setCommentsFor(note.id)}
              onDragStateChange={setDragging}
            />
          ))}
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
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => setCommentsFor(undefined)}
              title="Fechar"
            >
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

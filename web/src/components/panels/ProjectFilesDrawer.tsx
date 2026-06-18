import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileEntry } from '@aiportal/shared';
import { api } from '../../api/client';
import { extractDocumentText, isConvertibleDocument } from '../../lib/extractDocument';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';
import { Markdown } from '../common/Markdown';
import { Modal } from '../common/Modal';

const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

/** Limite por arquivo enviado (o servidor recusa acima de 2 MB). */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

const PANEL_WIDTH_KEY = 'aiportal.filesPanelWidth';
const PANEL_MIN_WIDTH = 280;

function savedPanelWidth(): number | undefined {
  const value = Number(localStorage.getItem(PANEL_WIDTH_KEY));
  return Number.isFinite(value) && value >= PANEL_MIN_WIDTH ? value : undefined;
}

function clampPanelWidth(width: number): number {
  return Math.min(Math.round(window.innerWidth * 0.7), Math.max(PANEL_MIN_WIDTH, width));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Caminhos de todas as pastas da árvore (para recolher/expandir tudo). */
function collectDirPaths(entries: FileEntry[], acc: string[] = []): string[] {
  for (const entry of entries) {
    if (entry.type === 'dir') {
      acc.push(entry.path);
      if (entry.children) collectDirPaths(entry.children, acc);
    }
  }
  return acc;
}

function TreeLevel(props: {
  entries: FileEntry[];
  depth: number;
  contextFiles: string[];
  canPin: boolean;
  collapsed: Set<string>;
  onToggleDir: (path: string) => void;
  onOpen: (entry: FileEntry) => void;
  onTogglePin: (entry: FileEntry) => void;
  onDownload: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
}) {
  return (
    <>
      {props.entries.map((entry) => {
        const pinned = props.contextFiles.includes(entry.path);
        const isDir = entry.type === 'dir';
        const isCollapsed = isDir && props.collapsed.has(entry.path);
        return (
          <div key={entry.path} style={{ paddingLeft: props.depth * 14 }}>
            <div className={`file-tree__row${pinned ? ' file-tree__row--pinned' : ''}`}>
              <button
                className={`file-tree__item${isDir ? ' file-tree__item--dir' : ''}`}
                onClick={() => (isDir ? props.onToggleDir(entry.path) : props.onOpen(entry))}
                title={isDir ? (isCollapsed ? 'Expandir pasta' : 'Recolher pasta') : undefined}
              >
                <span className="file-tree__chevron">{isDir ? (isCollapsed ? '▶' : '▼') : ''}</span>
                <span>{isDir ? '📁' : '📄'}</span>
                <span className="file-tree__name">{entry.name}</span>
                {entry.type === 'file' && (
                  <span className="file-tree__size">{formatSize(entry.size)}</span>
                )}
              </button>
              {entry.type === 'file' && (
                <span className="file-tree__actions">
                  {props.canPin && (
                    <button
                      className={`file-tree__pin${pinned ? ' file-tree__pin--on' : ''}`}
                      title={
                        pinned
                          ? 'Remover do contexto da conversa'
                          : 'Fixar no contexto da conversa'
                      }
                      onClick={() => props.onTogglePin(entry)}
                    >
                      📌
                    </button>
                  )}
                  <button
                    className="file-tree__dl"
                    title="Baixar arquivo"
                    onClick={() => props.onDownload(entry)}
                  >
                    ⬇
                  </button>
                  <button
                    className="file-tree__delete"
                    title="Excluir arquivo"
                    onClick={() => props.onDelete(entry)}
                  >
                    🗑
                  </button>
                </span>
              )}
            </div>
            {entry.children && !isCollapsed && (
              <TreeLevel
                entries={entry.children}
                depth={props.depth + 1}
                contextFiles={props.contextFiles}
                canPin={props.canPin}
                collapsed={props.collapsed}
                onToggleDir={props.onToggleDir}
                onOpen={props.onOpen}
                onTogglePin={props.onTogglePin}
                onDownload={props.onDownload}
                onDelete={props.onDelete}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export function ProjectFilesDrawer() {
  const session = useSessions((s) => s.current);
  const patchCurrent = useSessions((s) => s.patchCurrent);
  const viewProjectId = useSessions((s) => s.viewProjectId);
  const projects = useSessions((s) => s.projects);
  const closePanel = useUi((s) => s.closePanel);
  const toast = useUi((s) => s.toast);
  const confirm = useUi((s) => s.confirm);
  const filesVersion = useUi((s) => s.filesVersion);
  const projectId = session?.projectId ?? viewProjectId;
  const project = projects.find((p) => p.id === projectId);
  // conversa avulsa aberta: o painel mostra o workspace próprio dela
  const workspaceSessionId = !projectId && session ? session.id : undefined;
  const [tree, setTree] = useState<FileEntry[]>([]);
  const [viewing, setViewing] = useState<{ path: string; content: string; truncated: boolean }>();
  /** Leitura ampliada (modal largo) do arquivo aberto. */
  const [reader, setReader] = useState(false);
  /** Edição do arquivo aberto (vale para o drawer e para a visão ampliada). */
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [width, setWidth] = useState<number | undefined>(savedPanelWidth);
  const [resizing, setResizing] = useState(false);
  /** Pastas recolhidas (expandidas por padrão). */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const uploadRef = useRef<HTMLInputElement>(null);

  const toggleDir = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const allDirs = collectDirPaths(tree);
  const allCollapsed = allDirs.length > 0 && allDirs.every((p) => collapsed.has(p));

  // pin só funciona com a conversa dona da pasta exibida (projeto ou workspace)
  const canPin = !!session && (!!workspaceSessionId || session.projectId === projectId);
  const contextFiles = (canPin && session?.contextFiles) || [];

  const reload = useCallback(async () => {
    try {
      if (projectId) setTree(await api.projectFiles(projectId));
      else if (workspaceSessionId) setTree(await api.sessionFiles(workspaceSessionId));
    } catch {
      setTree([]);
    }
  }, [projectId, workspaceSessionId]);

  // recarrega ao abrir e sempre que o assistente mexe nos arquivos (filesVersion)
  useEffect(() => {
    void reload();
  }, [reload, filesVersion]);

  const openFile = async (entry: FileEntry) => {
    setEditing(false);
    try {
      const data = projectId
        ? await api.projectFileContent(projectId, entry.path)
        : await api.sessionFileContent(workspaceSessionId!, entry.path);
      setViewing({ path: entry.path, ...data });
    } catch {
      setViewing({ path: entry.path, content: '(não foi possível ler este arquivo)', truncated: false });
    }
  };

  const startEdit = () => {
    if (!viewing) return;
    setDraft(viewing.content);
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!viewing) return;
    try {
      if (projectId) await api.writeProjectFile(projectId, viewing.path, draft);
      else if (workspaceSessionId) await api.writeSessionFile(workspaceSessionId, viewing.path, draft);
      setViewing({ ...viewing, content: draft });
      setEditing(false);
      toast('Arquivo salvo.', 'ok');
      await reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const closeViewer = async () => {
    if (editing && viewing && draft !== viewing.content) {
      const ok = await confirm({
        title: 'Descartar alterações',
        message: 'O arquivo tem alterações não salvas. Descartar?',
        confirmLabel: 'Descartar',
        danger: true,
      });
      if (!ok) return;
    }
    setEditing(false);
    setViewing(undefined);
  };

  const togglePin = async (entry: FileEntry) => {
    if (!canPin || !session) return;
    const curr = session.contextFiles ?? [];
    const next = curr.includes(entry.path)
      ? curr.filter((p) => p !== entry.path)
      : [...curr, entry.path];
    await patchCurrent({ contextFiles: next });
  };

  const downloadFile = async (path: string) => {
    try {
      if (projectId) await api.downloadProjectFile(projectId, path);
      else if (workspaceSessionId) await api.downloadSessionFile(workspaceSessionId, path);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const deleteFile = async (entry: FileEntry) => {
    const ok = await confirm({
      title: 'Excluir arquivo',
      message: `Excluir o arquivo "${entry.path}"?`,
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!ok) return;
    try {
      if (projectId) await api.deleteProjectFile(projectId, entry.path);
      else if (workspaceSessionId) await api.deleteSessionFile(workspaceSessionId, entry.path);
      if (canPin && session?.contextFiles?.includes(entry.path)) {
        await patchCurrent({
          contextFiles: session.contextFiles.filter((p) => p !== entry.path),
        });
      }
      await reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const uploadFiles = async (files: FileList | File[]) => {
    let okCount = 0;
    for (const file of Array.from(files)) {
      if (file.size > MAX_UPLOAD_BYTES) {
        toast(`"${file.name}" passa de 2 MB e não foi enviado.`, 'error');
        continue;
      }
      try {
        // Excel/Word/PDF viram .md na pasta de trabalho — assim o arquivo pode
        // ser fixado no contexto e lido pelas ferramentas (que só leem texto)
        let name = file.name;
        let content: string;
        if (isConvertibleDocument(name)) {
          content = await extractDocumentText(file);
          name = name.replace(/\.[^.]+$/, '.md');
        } else {
          content = await file.text();
        }
        if (projectId) await api.writeProjectFile(projectId, name, content);
        else if (workspaceSessionId) {
          await api.writeSessionFile(workspaceSessionId, name, content);
        }
        okCount++;
      } catch (err) {
        toast(`"${file.name}": ${(err as Error).message}`, 'error');
      }
    }
    if (okCount) {
      toast(`${okCount} arquivo${okCount === 1 ? '' : 's'} adicionado${okCount === 1 ? '' : 's'}.`, 'ok');
      await reload();
    }
  };

  if (!project && !workspaceSessionId) return null;

  return (
    <aside
      className={`files-panel${dragOver ? ' files-panel--dragover' : ''}${resizing ? ' files-panel--resizing' : ''}`}
      style={width ? { width: clampPanelWidth(width) } : undefined}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragOver(false);
        void uploadFiles(e.dataTransfer.files);
      }}
    >
      <div
        className="files-panel__resizer"
        title="Arraste para redimensionar"
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          setResizing(true);
        }}
        onPointerMove={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
          setWidth(clampPanelWidth(window.innerWidth - e.clientX));
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          setResizing(false);
          if (width) localStorage.setItem(PANEL_WIDTH_KEY, String(clampPanelWidth(width)));
        }}
      />
      <div className="files-panel__head">
        <span className="files-panel__title">
          📄 Arquivos · {project ? project.name : 'workspace da conversa'}
        </span>
        <button className="modal__close" onClick={closePanel} aria-label="Fechar painel">
          ×
        </button>
      </div>
      <div className="files-panel__toolbar">
        <input
          ref={uploadRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void uploadFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          className="btn btn--sm"
          onClick={() => uploadRef.current?.click()}
          title="Adicionar arquivos de fora (ou arraste para o painel)"
        >
          ⬆ Adicionar
        </button>
        <button className="btn btn--sm btn--ghost" onClick={() => void reload()}>
          ↻ Atualizar
        </button>
        {allDirs.length > 0 && (
          <button
            className="btn btn--sm btn--ghost"
            title={allCollapsed ? 'Expandir todas as pastas' : 'Recolher todas as pastas'}
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(allDirs))}
          >
            {allCollapsed ? '▶ Expandir tudo' : '▼ Recolher tudo'}
          </button>
        )}
      </div>
      {canPin && (
        <div className="files-panel__hint">
          📌 fixa o arquivo no contexto da conversa atual
          {contextFiles.length > 0 && ` · ${contextFiles.length} fixado${contextFiles.length === 1 ? '' : 's'}`}
        </div>
      )}
      <div className="files-panel__body">
        {viewing ? (
          <div className="file-viewer">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <button className="btn btn--ghost btn--sm" onClick={() => void closeViewer()}>
                ← voltar
              </button>
              <span
                style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {viewing.path}
              </span>
              {editing ? (
                <>
                  <button className="btn btn--primary btn--sm" onClick={() => void saveEdit()}>
                    💾 Salvar
                  </button>
                  <button className="btn btn--ghost btn--sm" onClick={() => setEditing(false)}>
                    Cancelar
                  </button>
                </>
              ) : (
                <button
                  className="btn btn--sm"
                  title={
                    viewing.truncated
                      ? 'Arquivo grande demais para editar aqui'
                      : 'Editar o conteúdo do arquivo'
                  }
                  disabled={viewing.truncated}
                  onClick={startEdit}
                >
                  ✏️ Editar
                </button>
              )}
              <button className="btn btn--sm" title="Abrir em visão maior" onClick={() => setReader(true)}>
                ⤢ Ampliar
              </button>
              <button className="btn btn--sm" title="Baixar arquivo" onClick={() => void downloadFile(viewing.path)}>
                ⬇ Baixar
              </button>
            </div>
            {editing ? (
              <textarea
                className="page-card__editor"
                style={{ flex: 1, width: '100%', minHeight: 280 }}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            ) : (
              <pre>{viewing.content}</pre>
            )}
            {viewing.truncated && (
              <div className="empty-state">Arquivo grande — exibindo só o início.</div>
            )}
          </div>
        ) : (
          <div className="file-tree">
            {tree.length === 0 && (
              <div className="empty-state">
                Pasta vazia. Adicione arquivos acima ou peça ao assistente para gerar (modo Agent).
              </div>
            )}
            <TreeLevel
              entries={tree}
              depth={0}
              contextFiles={contextFiles}
              canPin={canPin}
              collapsed={collapsed}
              onToggleDir={toggleDir}
              onOpen={(e) => void openFile(e)}
              onTogglePin={(e) => void togglePin(e)}
              onDownload={(e) => void downloadFile(e.path)}
              onDelete={(e) => void deleteFile(e)}
            />
          </div>
        )}
      </div>
      {reader && viewing && (
        <Modal title={viewing.path} wide onClose={() => setReader(false)}>
          <div className="file-reader">
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginBottom: 10 }}>
              {editing ? (
                <>
                  <button className="btn btn--primary btn--sm" onClick={() => void saveEdit()}>
                    💾 Salvar
                  </button>
                  <button className="btn btn--ghost btn--sm" onClick={() => setEditing(false)}>
                    Cancelar
                  </button>
                </>
              ) : (
                <button
                  className="btn btn--sm"
                  title={
                    viewing.truncated
                      ? 'Arquivo grande demais para editar aqui'
                      : 'Editar o markdown bruto do arquivo'
                  }
                  disabled={viewing.truncated}
                  onClick={startEdit}
                >
                  ✏️ Editar
                </button>
              )}
            </div>
            {editing ? (
              <textarea
                className="page-card__editor"
                style={{ width: '100%', minHeight: '60vh' }}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            ) : isMarkdown(viewing.path) ? (
              <Markdown text={viewing.content} />
            ) : (
              <pre>{viewing.content}</pre>
            )}
            {viewing.truncated && (
              <div className="empty-state">Arquivo grande — exibindo só o início. Use ⬇ Baixar para o conteúdo completo.</div>
            )}
          </div>
        </Modal>
      )}
    </aside>
  );
}

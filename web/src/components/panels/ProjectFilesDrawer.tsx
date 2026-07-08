import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileEntry } from '@aiportal/shared';
import { api } from '../../api/client';
import { extractDocumentText, isConvertibleDocument } from '../../lib/extractDocument';
import { usePreview } from '../../stores/previewStore';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';
import { ContextMenu, type ContextMenuItem } from '../common/ContextMenu';
import { FilePreview, hasPreview, isMarkdown } from '../common/fileView';
import { Markdown } from '../common/Markdown';
import { Modal } from '../common/Modal';

/** Limite por arquivo enviado (o servidor recusa acima de 2 MB). */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** Arquivo com o caminho relativo de destino na pasta de trabalho. */
interface UploadItem {
  file: File;
  relPath: string;
}

/** Pastas/arquivos pulados ao enviar uma pasta inteira. */
const IGNORED_DIRS = new Set(['node_modules', '.git', '.aiportal']);
const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db']);

function isIgnoredPath(relPath: string): boolean {
  const parts = relPath.split('/');
  return IGNORED_FILES.has(parts[parts.length - 1]) || parts.some((p) => IGNORED_DIRS.has(p));
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  // readEntries devolve em lotes de até 100 — repete até esvaziar
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (!batch.length) return all;
    all.push(...batch);
  }
}

async function collectEntry(entry: FileSystemEntry, base: string, acc: UploadItem[]): Promise<void> {
  const relPath = base ? `${base}/${entry.name}` : entry.name;
  if (entry.isFile) {
    if (!IGNORED_FILES.has(entry.name)) {
      acc.push({ file: await entryFile(entry as FileSystemFileEntry), relPath });
    }
    return;
  }
  if (entry.isDirectory && !IGNORED_DIRS.has(entry.name)) {
    for (const child of await readAllEntries(entry as FileSystemDirectoryEntry)) {
      await collectEntry(child, relPath, acc);
    }
  }
}

/** Extrai arquivos (inclusive pastas arrastadas) de um drop. */
async function collectDropped(dt: DataTransfer): Promise<UploadItem[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (!entries.length) {
    return Array.from(dt.files).map((file) => ({ file, relPath: file.name }));
  }
  const acc: UploadItem[] = [];
  for (const entry of entries) await collectEntry(entry, '', acc);
  return acc;
}

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
  onMenu: (entry: FileEntry, x: number, y: number) => void;
}) {
  return (
    <>
      {props.entries.map((entry) => {
        const pinned = props.contextFiles.includes(entry.path);
        const isDir = entry.type === 'dir';
        const isCollapsed = isDir && props.collapsed.has(entry.path);
        return (
          <div key={entry.path} style={{ paddingLeft: props.depth * 14 }}>
            <div
              className={`file-tree__row${pinned ? ' file-tree__row--pinned' : ''}`}
              onContextMenu={(e) => {
                e.preventDefault();
                props.onMenu(entry, e.clientX, e.clientY);
              }}
            >
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
              {entry.type === 'file' && props.canPin && (
                <span className="file-tree__actions">
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
                onMenu={props.onMenu}
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
  const previewEnabled = usePreview((s) => s.enabled);
  const openPreviewTab = usePreview((s) => s.openTab);
  const previewApplyRename = usePreview((s) => s.applyRename);
  const previewApplyDelete = usePreview((s) => s.applyDelete);
  const previewScopeKey = projectId
    ? `project:${projectId}`
    : workspaceSessionId
      ? `session:${workspaceSessionId}`
      : '';
  const [tree, setTree] = useState<FileEntry[]>([]);
  const [viewing, setViewing] = useState<{ path: string; content: string; truncated: boolean }>();
  /** Leitura ampliada (modal largo) do arquivo aberto. */
  const [reader, setReader] = useState(false);
  /** Edição do arquivo aberto (vale para o drawer e para a visão ampliada). */
  const [editing, setEditing] = useState(false);
  /** Ver o código-fonte em vez do preview (arquivos .html/.excalidraw). */
  const [showSource, setShowSource] = useState(false);
  const [draft, setDraft] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [width, setWidth] = useState<number | undefined>(savedPanelWidth);
  const [resizing, setResizing] = useState(false);
  /** Pastas recolhidas (expandidas por padrão). */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** Menu de contexto aberto (botão direito num arquivo/pasta). */
  const [menu, setMenu] = useState<{ entry: FileEntry; x: number; y: number }>();
  /** Renomeando arquivo/pasta (modal com input). */
  const [renaming, setRenaming] = useState<FileEntry>();
  const [renameDraft, setRenameDraft] = useState('');
  /** Progresso do envio em lote (pasta inteira). */
  const [uploading, setUploading] = useState<{ done: number; total: number }>();
  const uploadRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

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
    // modo preview ligado: abre como aba no painel central, não no drawer
    if (previewEnabled) {
      openPreviewTab(previewScopeKey, { path: entry.path, name: entry.name });
      return;
    }
    setEditing(false);
    setShowSource(false);
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

  const revealFile = async (path: string) => {
    try {
      if (projectId) await api.revealProjectFile(projectId, path);
      else if (workspaceSessionId) await api.revealSessionFile(workspaceSessionId, path);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const deleteEntry = async (entry: FileEntry) => {
    const isDir = entry.type === 'dir';
    const ok = await confirm({
      title: isDir ? 'Excluir pasta' : 'Excluir arquivo',
      message: isDir
        ? `Excluir a pasta "${entry.path}" e todo o conteúdo dela?`
        : `Excluir o arquivo "${entry.path}"?`,
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!ok) return;
    try {
      if (projectId) await api.deleteProjectFile(projectId, entry.path);
      else if (workspaceSessionId) await api.deleteSessionFile(workspaceSessionId, entry.path);
      previewApplyDelete(entry.path);
      if (viewing && (viewing.path === entry.path || viewing.path.startsWith(entry.path + '/'))) {
        setEditing(false);
        setViewing(undefined);
      }
      if (canPin && session?.contextFiles?.length) {
        const next = session.contextFiles.filter(
          (p) => p !== entry.path && !p.startsWith(entry.path + '/'),
        );
        if (next.length !== session.contextFiles.length) {
          await patchCurrent({ contextFiles: next });
        }
      }
      await reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const startRename = (entry: FileEntry) => {
    setRenaming(entry);
    setRenameDraft(entry.name);
  };

  const submitRename = async () => {
    if (!renaming) return;
    const name = renameDraft.trim();
    if (!name || name === renaming.name) {
      setRenaming(undefined);
      return;
    }
    if (/[/\\]/.test(name)) {
      toast('O nome não pode conter barras.', 'error');
      return;
    }
    const slash = renaming.path.lastIndexOf('/');
    const newPath = slash === -1 ? name : `${renaming.path.slice(0, slash)}/${name}`;
    const remap = (p: string) =>
      p === renaming.path
        ? newPath
        : p.startsWith(renaming.path + '/')
          ? newPath + p.slice(renaming.path.length)
          : p;
    try {
      if (projectId) await api.renameProjectFile(projectId, renaming.path, newPath);
      else if (workspaceSessionId) {
        await api.renameSessionFile(workspaceSessionId, renaming.path, newPath);
      }
      previewApplyRename(renaming.path, newPath);
      if (viewing && remap(viewing.path) !== viewing.path) {
        setViewing({ ...viewing, path: remap(viewing.path) });
      }
      if (canPin && session?.contextFiles?.length) {
        const next = session.contextFiles.map(remap);
        if (next.some((p, i) => p !== session.contextFiles![i])) {
          await patchCurrent({ contextFiles: next });
        }
      }
      setRenaming(undefined);
      await reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const uploadItems = async (items: UploadItem[]) => {
    const valid = items.filter((it) => !isIgnoredPath(it.relPath));
    let okCount = 0;
    let tooBig = 0;
    let failed = 0;
    setUploading({ done: 0, total: valid.length });
    try {
      for (const item of valid) {
        if (item.file.size > MAX_UPLOAD_BYTES) {
          tooBig++;
          continue;
        }
        try {
          // Excel/Word/PDF viram .md na pasta de trabalho — assim o arquivo pode
          // ser fixado no contexto e lido pelas ferramentas (que só leem texto)
          let relPath = item.relPath;
          let content: string;
          if (isConvertibleDocument(item.file.name)) {
            content = await extractDocumentText(item.file);
            relPath = relPath.replace(/\.[^.]+$/, '.md');
          } else {
            content = await item.file.text();
          }
          if (projectId) await api.writeProjectFile(projectId, relPath, content);
          else if (workspaceSessionId) {
            await api.writeSessionFile(workspaceSessionId, relPath, content);
          }
          okCount++;
        } catch {
          failed++;
        }
        setUploading((prev) => prev && { ...prev, done: prev.done + 1 });
      }
    } finally {
      setUploading(undefined);
    }
    if (okCount) {
      toast(`${okCount} arquivo${okCount === 1 ? '' : 's'} adicionado${okCount === 1 ? '' : 's'}.`, 'ok');
      await reload();
    }
    if (tooBig) {
      toast(
        tooBig === 1
          ? '1 arquivo passa de 2 MB e não foi enviado.'
          : `${tooBig} arquivos passam de 2 MB e não foram enviados.`,
        'error',
      );
    }
    if (failed) {
      toast(
        failed === 1 ? '1 arquivo falhou no envio.' : `${failed} arquivos falharam no envio.`,
        'error',
      );
    }
  };

  const uploadFiles = (files: FileList | File[]) =>
    uploadItems(
      Array.from(files).map((file) => ({
        file,
        relPath:
          (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      })),
    );

  const menuItems = (entry: FileEntry): ContextMenuItem[] => {
    if (entry.type === 'dir') {
      return [
        {
          label: collapsed.has(entry.path) ? 'Expandir' : 'Recolher',
          icon: '📁',
          onClick: () => toggleDir(entry.path),
        },
        'separator',
        { label: 'Renomear', icon: '✏️', onClick: () => startRename(entry) },
        { label: 'Mostrar na pasta local', icon: '📂', onClick: () => void revealFile(entry.path) },
        'separator',
        { label: 'Excluir pasta', icon: '🗑', danger: true, onClick: () => void deleteEntry(entry) },
      ];
    }
    const pinned = contextFiles.includes(entry.path);
    return [
      {
        label: previewEnabled ? 'Abrir no preview' : 'Abrir',
        icon: '📄',
        onClick: () => void openFile(entry),
      },
      ...(canPin
        ? [
            {
              label: pinned ? 'Desfixar do contexto' : 'Fixar no contexto',
              icon: '📌',
              onClick: () => void togglePin(entry),
            } as ContextMenuItem,
          ]
        : []),
      'separator',
      { label: 'Renomear', icon: '✏️', onClick: () => startRename(entry) },
      { label: 'Baixar', icon: '⬇', onClick: () => void downloadFile(entry.path) },
      { label: 'Mostrar na pasta local', icon: '📂', onClick: () => void revealFile(entry.path) },
      'separator',
      { label: 'Excluir', icon: '🗑', danger: true, onClick: () => void deleteEntry(entry) },
    ];
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
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragOver(false);
        // captura as entries de forma síncrona: o DataTransfer expira após o evento
        void collectDropped(e.dataTransfer).then((items) => {
          if (items.length) void uploadItems(items);
        });
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
        <input
          ref={folderRef}
          type="file"
          hidden
          // atributo não padronizado (Chrome/Edge/Firefox): seleciona uma pasta inteira
          {...({ webkitdirectory: '' } as Record<string, string>)}
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
        <button
          className="btn btn--sm"
          onClick={() => folderRef.current?.click()}
          title="Adicionar uma pasta inteira (com subpastas) — ou arraste a pasta para o painel"
        >
          📁 Pasta
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
      {uploading && (
        <div className="files-panel__hint">
          ⬆ Enviando {uploading.done}/{uploading.total}…
        </div>
      )}
      {canPin && (
        <div className="files-panel__hint">
          📌 fixa o arquivo no contexto da conversa atual
          {contextFiles.length > 0 && ` · ${contextFiles.length} fixado${contextFiles.length === 1 ? '' : 's'}`}
        </div>
      )}
      <div className="files-panel__body">
        {viewing ? (
          <div className="file-viewer">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <button className="btn btn--ghost btn--sm" onClick={() => void closeViewer()}>
                ← voltar
              </button>
              <span style={{ flex: 1 }} />
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
                <>
                  {hasPreview(viewing.path) && !viewing.truncated && (
                    <button
                      className="btn btn--sm"
                      title={showSource ? 'Ver o preview' : 'Ver o código-fonte'}
                      aria-label={showSource ? 'Ver o preview' : 'Ver o código-fonte'}
                      onClick={() => setShowSource((v) => !v)}
                    >
                      {showSource ? '👁' : '</>'}
                    </button>
                  )}
                  <button
                    className="btn btn--sm"
                    title={
                      viewing.truncated
                        ? 'Arquivo grande demais para editar aqui'
                        : 'Editar o conteúdo do arquivo'
                    }
                    aria-label="Editar"
                    disabled={viewing.truncated}
                    onClick={startEdit}
                  >
                    ✏️
                  </button>
                </>
              )}
              <button
                className="btn btn--sm"
                title="Ampliar (visão maior)"
                aria-label="Ampliar"
                onClick={() => setReader(true)}
              >
                ⤢
              </button>
              <button
                className="btn btn--sm"
                title="Baixar arquivo"
                aria-label="Baixar"
                onClick={() => void downloadFile(viewing.path)}
              >
                ⬇
              </button>
              <button
                className="btn btn--sm"
                title="Mostrar na pasta local (Finder/Explorador de Arquivos)"
                aria-label="Mostrar na pasta local"
                onClick={() => void revealFile(viewing.path)}
              >
                📂
              </button>
            </div>
            <div
              title={viewing.path}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'var(--text-dim)',
                wordBreak: 'break-all',
                lineHeight: 1.4,
                marginBottom: 8,
              }}
            >
              {viewing.path}
            </div>
            {editing ? (
              <textarea
                className="page-card__editor"
                style={{ flex: 1, width: '100%', minHeight: 280 }}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            ) : hasPreview(viewing.path) && !showSource && !viewing.truncated ? (
              <FilePreview path={viewing.path} content={viewing.content} />
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
              onMenu={(entry, x, y) => setMenu({ entry, x, y })}
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
                <>
                  {hasPreview(viewing.path) && !viewing.truncated && (
                    <button
                      className="btn btn--sm"
                      onClick={() => setShowSource((v) => !v)}
                    >
                      {showSource ? '👁 Preview' : '</> Código'}
                    </button>
                  )}
                  <button
                    className="btn btn--sm"
                    title={
                      viewing.truncated
                        ? 'Arquivo grande demais para editar aqui'
                        : 'Editar o conteúdo bruto do arquivo'
                    }
                    disabled={viewing.truncated}
                    onClick={startEdit}
                  >
                    ✏️ Editar
                  </button>
                </>
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
            ) : hasPreview(viewing.path) && !showSource && !viewing.truncated ? (
              <FilePreview path={viewing.path} content={viewing.content} />
            ) : (
              <pre>{viewing.content}</pre>
            )}
            {viewing.truncated && (
              <div className="empty-state">Arquivo grande — exibindo só o início. Use ⬇ Baixar para o conteúdo completo.</div>
            )}
          </div>
        </Modal>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.entry)}
          onClose={() => setMenu(undefined)}
        />
      )}
      {renaming && (
        <Modal
          title={renaming.type === 'dir' ? 'Renomear pasta' : 'Renomear arquivo'}
          onClose={() => setRenaming(undefined)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setRenaming(undefined)}>
                Cancelar
              </button>
              <button
                className="btn btn--primary"
                disabled={!renameDraft.trim()}
                onClick={() => void submitRename()}
              >
                Renomear
              </button>
            </>
          }
        >
          <div className="field">
            <label>Novo nome</label>
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submitRename()}
            />
          </div>
        </Modal>
      )}
    </aside>
  );
}

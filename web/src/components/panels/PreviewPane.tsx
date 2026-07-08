import { useCallback, useEffect, useRef, useState } from 'react';
import { Code, Download, Eye, FileText, Pencil, Save, X } from 'lucide-react';
import { api } from '../../api/client';
import { useSessions } from '../../stores/sessionsStore';
import { usePreview } from '../../stores/previewStore';
import { useUi } from '../../stores/uiStore';
import { Markdown } from '../common/Markdown';
import { FilePreview, hasPreview, isBinaryFile, isMarkdown } from '../common/fileView';

const PANE_WIDTH_KEY = 'aiportal.previewPaneWidth';
const PANE_MIN_WIDTH = 320;

function savedPaneWidth(): number | undefined {
  const value = Number(localStorage.getItem(PANE_WIDTH_KEY));
  return Number.isFinite(value) && value >= PANE_MIN_WIDTH ? value : undefined;
}

function clampPaneWidth(width: number): number {
  return Math.min(Math.round(window.innerWidth * 0.7), Math.max(PANE_MIN_WIDTH, width));
}

interface Loaded {
  content: string;
  truncated: boolean;
}

/**
 * Painel do modo preview: abas de arquivos abertos ao lado do chat (estilo
 * VS Code). Os arquivos chegam aqui pelo painel Arquivos (clique com o modo
 * preview ligado) e recarregam sozinhos quando o assistente mexe neles.
 */
export function PreviewPane() {
  const session = useSessions((s) => s.current);
  const viewProjectId = useSessions((s) => s.viewProjectId);
  const projectId = session?.projectId ?? viewProjectId;
  const workspaceSessionId = !projectId && session ? session.id : undefined;
  const scopeKey = projectId ? `project:${projectId}` : workspaceSessionId ? `session:${workspaceSessionId}` : '';

  const tabs = usePreview((s) => s.tabs);
  const activePath = usePreview((s) => s.activePath);
  const setActive = usePreview((s) => s.setActive);
  const closeTab = usePreview((s) => s.closeTab);
  const ensureScope = usePreview((s) => s.ensureScope);
  const togglePreview = usePreview((s) => s.toggle);
  const toast = useUi((s) => s.toast);
  const confirm = useUi((s) => s.confirm);
  const filesVersion = useUi((s) => s.filesVersion);
  const bumpFilesVersion = useUi((s) => s.bumpFilesVersion);

  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [showSource, setShowSource] = useState(false);
  const [width, setWidth] = useState<number | undefined>(savedPaneWidth);
  const [resizing, setResizing] = useState(false);
  const paneRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (scopeKey) ensureScope(scopeKey);
  }, [scopeKey, ensureScope]);

  const fetchContent = useCallback(
    async (path: string): Promise<Loaded> => {
      try {
        return projectId
          ? await api.projectFileContent(projectId, path)
          : await api.sessionFileContent(workspaceSessionId!, path);
      } catch {
        return { content: '(não foi possível ler este arquivo)', truncated: false };
      }
    },
    [projectId, workspaceSessionId],
  );

  // conteúdo da aba ativa: carrega ao ativar e recarrega quando o assistente
  // mexe nos arquivos (filesVersion) — exceto durante uma edição local
  useEffect(() => {
    if (!activePath || (!projectId && !workspaceSessionId)) return;
    if (editing) return;
    // binário (planilha, PDF original, imagem…): nada de conteúdo em texto
    if (isBinaryFile(activePath)) {
      setLoaded((prev) => ({ ...prev, [activePath]: { content: '', truncated: false } }));
      return;
    }
    let stale = false;
    void fetchContent(activePath).then((data) => {
      if (!stale) setLoaded((prev) => ({ ...prev, [activePath]: data }));
    });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, filesVersion, fetchContent, editing]);

  // troca de aba sai do modo edição/código-fonte
  useEffect(() => {
    setEditing(false);
    setShowSource(false);
  }, [activePath]);

  if (!projectId && !workspaceSessionId) return null;

  const active = activePath ? tabs.find((t) => t.path === activePath) : undefined;
  const view = active ? loaded[active.path] : undefined;

  const startEdit = () => {
    if (!view) return;
    setDraft(view.content);
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!active) return;
    try {
      if (projectId) await api.writeProjectFile(projectId, active.path, draft);
      else if (workspaceSessionId) await api.writeSessionFile(workspaceSessionId, active.path, draft);
      setLoaded((prev) => ({ ...prev, [active.path]: { content: draft, truncated: false } }));
      setEditing(false);
      toast('Arquivo salvo.', 'ok');
      bumpFilesVersion();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const requestCloseTab = async (path: string) => {
    if (editing && active?.path === path && view && draft !== view.content) {
      const ok = await confirm({
        title: 'Descartar alterações',
        message: 'O arquivo tem alterações não salvas. Descartar?',
        confirmLabel: 'Descartar',
        danger: true,
      });
      if (!ok) return;
      setEditing(false);
    }
    closeTab(path);
  };

  const downloadFile = async (path: string) => {
    try {
      if (projectId) await api.downloadProjectFile(projectId, path);
      else if (workspaceSessionId) await api.downloadSessionFile(workspaceSessionId, path);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <aside
      ref={paneRef}
      className={`preview-pane${resizing ? ' preview-pane--resizing' : ''}`}
      style={width ? { width: clampPaneWidth(width) } : undefined}
    >
      <div
        className="preview-pane__resizer"
        title="Arraste para redimensionar"
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          setResizing(true);
        }}
        onPointerMove={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
          const right = paneRef.current?.getBoundingClientRect().right ?? window.innerWidth;
          setWidth(clampPaneWidth(Math.round(right - e.clientX)));
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          setResizing(false);
          if (width) localStorage.setItem(PANE_WIDTH_KEY, String(clampPaneWidth(width)));
        }}
      />
      <div className="preview-tabs">
        <div className="preview-tabs__list">
          {tabs.map((tab) => (
            <div
              key={tab.path}
              className={`preview-tab${tab.path === activePath ? ' preview-tab--active' : ''}`}
              title={tab.path}
              role="tab"
              aria-selected={tab.path === activePath}
              onClick={() => setActive(tab.path)}
              onAuxClick={(e) => {
                if (e.button === 1) void requestCloseTab(tab.path);
              }}
            >
              <span className="preview-tab__name">{tab.name}</span>
              <button
                className="preview-tab__close"
                title="Fechar aba"
                aria-label={`Fechar ${tab.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void requestCloseTab(tab.path);
                }}
              >
                <X className="icon icon--sm" aria-hidden />
              </button>
            </div>
          ))}
        </div>
        <button
          className="preview-tabs__off"
          title="Desligar o modo preview"
          aria-label="Desligar o modo preview"
          onClick={togglePreview}
        >
          <X className="icon icon--sm" aria-hidden />
        </button>
      </div>
      {active && view ? (
        <>
          <div className="preview-pane__toolbar">
            <span className="preview-pane__path" title={active.path}>
              {active.path}
            </span>
            {editing ? (
              <>
                <button className="btn btn--primary btn--sm" onClick={() => void saveEdit()}>
                  <Save className="icon" aria-hidden /> Salvar
                </button>
                <button className="btn btn--ghost btn--sm" onClick={() => setEditing(false)}>
                  Cancelar
                </button>
              </>
            ) : (
              <>
                {(hasPreview(active.path) || isMarkdown(active.path)) && !view.truncated && (
                  <button
                    className="btn btn--sm"
                    title={showSource ? 'Ver renderizado' : 'Ver o código-fonte'}
                    onClick={() => setShowSource((v) => !v)}
                  >
                    {showSource ? (
                      <Eye className="icon" aria-hidden />
                    ) : (
                      <Code className="icon" aria-hidden />
                    )}
                  </button>
                )}
                <button
                  className="btn btn--sm"
                  title={
                    view.truncated || isBinaryFile(active.path)
                      ? 'Este arquivo não pode ser editado aqui'
                      : 'Editar o conteúdo do arquivo'
                  }
                  aria-label="Editar"
                  disabled={view.truncated || isBinaryFile(active.path)}
                  onClick={startEdit}
                >
                  <Pencil className="icon" aria-hidden />
                </button>
                <button
                  className="btn btn--sm"
                  title="Baixar arquivo"
                  aria-label="Baixar"
                  onClick={() => void downloadFile(active.path)}
                >
                  <Download className="icon" aria-hidden />
                </button>
              </>
            )}
          </div>
          <div className="preview-pane__body">
            {editing ? (
              <textarea
                className="page-card__editor preview-pane__editor"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            ) : isBinaryFile(active.path) ? (
              <div className="empty-state">
                Arquivo binário — sem visualização em texto. Use Baixar ou abra na pasta local.
              </div>
            ) : isMarkdown(active.path) && !showSource ? (
              <Markdown text={view.content} />
            ) : hasPreview(active.path) && !showSource && !view.truncated ? (
              <FilePreview path={active.path} content={view.content} />
            ) : (
              <pre>{view.content}</pre>
            )}
            {view.truncated && (
              <div className="empty-state">
                Arquivo grande — exibindo só o início. Use Baixar para o conteúdo completo.
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="preview-pane__empty">
          <div className="empty-state">
            Modo preview ligado.
            <br />
            Clique num arquivo no painel <FileText className="icon icon--sm" aria-hidden /> Arquivos
            para abrir aqui.
          </div>
        </div>
      )}
    </aside>
  );
}

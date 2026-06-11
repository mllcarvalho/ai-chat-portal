import { useCallback, useEffect, useState } from 'react';
import type { FileEntry } from '@aiportal/shared';
import { api } from '../../api/client';
import { useSessions } from '../../stores/sessionsStore';
import { Drawer } from '../common/Modal';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function TreeLevel(props: {
  entries: FileEntry[];
  depth: number;
  onOpen: (entry: FileEntry) => void;
}) {
  return (
    <>
      {props.entries.map((entry) => (
        <div key={entry.path} style={{ paddingLeft: props.depth * 14 }}>
          <button
            className="file-tree__item"
            onClick={() => entry.type === 'file' && props.onOpen(entry)}
          >
            <span>{entry.type === 'dir' ? '📁' : '📄'}</span>
            <span>{entry.name}</span>
            {entry.type === 'file' && (
              <span className="file-tree__size">{formatSize(entry.size)}</span>
            )}
          </button>
          {entry.children && (
            <TreeLevel entries={entry.children} depth={props.depth + 1} onOpen={props.onOpen} />
          )}
        </div>
      ))}
    </>
  );
}

export function ProjectFilesDrawer() {
  const session = useSessions((s) => s.current);
  const viewProjectId = useSessions((s) => s.viewProjectId);
  const projects = useSessions((s) => s.projects);
  const projectId = session?.projectId ?? viewProjectId;
  const project = projects.find((p) => p.id === projectId);
  const [tree, setTree] = useState<FileEntry[]>([]);
  const [viewing, setViewing] = useState<{ path: string; content: string; truncated: boolean }>();

  const reload = useCallback(async () => {
    if (!projectId) return;
    try {
      setTree(await api.projectFiles(projectId));
    } catch {
      setTree([]);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openFile = async (entry: FileEntry) => {
    if (!projectId) return;
    try {
      const data = await api.projectFileContent(projectId, entry.path);
      setViewing({ path: entry.path, ...data });
    } catch {
      setViewing({ path: entry.path, content: '(não foi possível ler este arquivo)', truncated: false });
    }
  };

  if (!project) return null;

  return (
    <Drawer title={`Arquivos · ${project.name}`}>
      <div style={{ marginBottom: 10 }}>
        <button className="btn btn--ghost" onClick={() => void reload()}>
          ↻ Atualizar
        </button>
      </div>
      {viewing ? (
        <div className="file-viewer">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <button className="btn btn--ghost" onClick={() => setViewing(undefined)}>
              ← voltar
            </button>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{viewing.path}</span>
          </div>
          <pre>{viewing.content}</pre>
          {viewing.truncated && (
            <div className="empty-state">Arquivo grande — exibindo só o início.</div>
          )}
        </div>
      ) : (
        <div className="file-tree">
          {tree.length === 0 && (
            <div className="empty-state">
              Pasta vazia. Peça ao assistente para gerar arquivos (modo Agent) e eles aparecerão aqui.
            </div>
          )}
          <TreeLevel entries={tree} depth={0} onOpen={(e) => void openFile(e)} />
        </div>
      )}
    </Drawer>
  );
}

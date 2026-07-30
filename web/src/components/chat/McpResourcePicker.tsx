import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useUi } from '../../stores/uiStore';
import { Modal } from '../common/Modal';

interface ResourceItem {
  server: string;
  uri: string;
  name: string;
  description?: string;
}

/**
 * Seletor de resources dos servidores MCP ligados (paridade com o Copilot):
 * o recurso escolhido é lido no servidor e vira um anexo da mensagem.
 */
export function McpResourcePicker(props: {
  onClose: () => void;
  onPick: (name: string, content: string) => void;
}) {
  const toast = useUi((s) => s.toast);
  const [resources, setResources] = useState<ResourceItem[]>();
  const [filter, setFilter] = useState('');
  const [readingUri, setReadingUri] = useState<string>();

  useEffect(() => {
    let alive = true;
    api
      .listMcpResources()
      .then(({ resources: list }) => {
        if (alive) setResources(list);
      })
      .catch((err: Error) => {
        toast(err.message, 'error');
        if (alive) setResources([]);
      });
    return () => {
      alive = false;
    };
  }, [toast]);

  const q = filter.trim().toLowerCase();
  const shown = (resources ?? []).filter(
    (r) =>
      !q ||
      r.name.toLowerCase().includes(q) ||
      r.uri.toLowerCase().includes(q) ||
      r.server.toLowerCase().includes(q),
  );

  const pick = (resource: ResourceItem) => {
    if (readingUri) return;
    setReadingUri(resource.uri);
    api.readMcpResource(resource.server, resource.uri).then(
      ({ content }) => props.onPick(resource.name, content),
      (err: Error) => {
        toast(err.message, 'error');
        setReadingUri(undefined);
      },
    );
  };

  return (
    <Modal title="Anexar recurso MCP" onClose={props.onClose}>
      <input
        autoFocus
        placeholder="Filtrar por nome, URI ou servidor…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ width: '100%', marginBottom: 10 }}
      />
      {resources === undefined ? (
        <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>Consultando os servidores…</p>
      ) : shown.length === 0 ? (
        <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          Nenhum recurso disponível — os servidores MCP ligados não anunciam resources
          {q ? ' com esse filtro' : ''}.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
          {shown.map((resource) => (
            <button
              key={`${resource.server}:${resource.uri}`}
              className="slash-menu__item"
              disabled={!!readingUri}
              onClick={() => pick(resource)}
              title={resource.uri}
            >
              <span className="slash-menu__cmd">
                {readingUri === resource.uri ? 'lendo…' : resource.name}
              </span>
              <span className="slash-menu__desc">
                [{resource.server}] {resource.description || resource.uri}
              </span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

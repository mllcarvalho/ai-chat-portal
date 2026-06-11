import { useEffect, useMemo, useState } from 'react';
import type { McpServerConfig, ToolInfo } from '@aiportal/shared';
import { api } from '../../api/client';
import { useCatalog } from '../../stores/catalogStore';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';
import { Drawer } from '../common/Modal';

function McpServerForm({ onCreated }: { onCreated: () => void }) {
  const toast = useUi((s) => s.toast);
  const [type, setType] = useState<'stdio' | 'http'>('stdio');
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const [cmd, ...args] = command.trim().split(/\s+/);
      await api.createMcpServer(
        type === 'stdio'
          ? { label, type, command: cmd, args }
          : { label, type, url },
      );
      toast('Servidor MCP adicionado. O VS Code pode pedir confirmação para iniciá-lo.', 'ok');
      setLabel('');
      setCommand('');
      setUrl('');
      onCreated();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 6 }}>
      <div className="field">
        <label>Nome do servidor</label>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ex: Jira interno" />
      </div>
      <div className="field">
        <label>Tipo</label>
        <select value={type} onChange={(e) => setType(e.target.value as 'stdio' | 'http')}>
          <option value="stdio">stdio (comando local)</option>
          <option value="http">http (URL remota)</option>
        </select>
      </div>
      {type === 'stdio' ? (
        <div className="field">
          <label>Comando</label>
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="ex: npx -y @modelcontextprotocol/server-filesystem /tmp"
          />
        </div>
      ) : (
        <div className="field">
          <label>URL</label>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </div>
      )}
      <button
        className="btn btn--primary"
        disabled={busy || !label.trim() || (type === 'stdio' ? !command.trim() : !url.trim())}
        onClick={() => void submit()}
      >
        Adicionar servidor
      </button>
    </div>
  );
}

export function ToolsPanel() {
  const session = useSessions((s) => s.current);
  const patchCurrent = useSessions((s) => s.patchCurrent);
  const tools = useCatalog((s) => s.tools);
  const loadTools = useCatalog((s) => s.loadTools);
  const toast = useUi((s) => s.toast);
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const reload = async () => {
    await Promise.all([
      loadTools(session?.id),
      api.listMcpServers().then(setServers).catch(() => setServers([])),
    ]);
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  const groups = useMemo(() => {
    const map = new Map<string, ToolInfo[]>();
    for (const tool of tools) {
      const key = tool.source === 'builtin' ? 'Projeto (arquivos)' : `MCP · ${tool.serverLabel ?? 'outros'}`;
      map.set(key, [...(map.get(key) ?? []), tool]);
    }
    return [...map.entries()];
  }, [tools]);

  const toggleTool = (tool: ToolInfo) => {
    if (!session) return;
    const allNames = tools.map((t) => t.name);
    const enabledNow = new Set(
      session.enabledTools === null ? allNames : session.enabledTools,
    );
    if (enabledNow.has(tool.name)) enabledNow.delete(tool.name);
    else enabledNow.add(tool.name);
    const next = allNames.every((n) => enabledNow.has(n)) ? null : [...enabledNow];
    void patchCurrent({ enabledTools: next }).then(() => loadTools(session.id));
  };

  const setAll = (enabled: boolean) => {
    if (!session) return;
    void patchCurrent({ enabledTools: enabled ? null : [] }).then(() => loadTools(session.id));
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await api.refreshTools();
      await reload();
      toast('Ferramentas atualizadas.', 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Drawer title="Ferramentas & MCPs">
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? 'Atualizando…' : '↻ Atualizar'}
        </button>
        {session && (
          <>
            <button className="btn btn--ghost" onClick={() => setAll(true)}>
              Habilitar todas
            </button>
            <button className="btn btn--ghost" onClick={() => setAll(false)}>
              Desabilitar todas
            </button>
          </>
        )}
      </div>
      {!session && (
        <div className="empty-state">
          Abra uma conversa para habilitar/desabilitar ferramentas por sessão.
        </div>
      )}
      {groups.length === 0 && (
        <div className="empty-state">
          Nenhuma ferramenta encontrada. Configure MCPs no VS Code ou adicione um servidor abaixo.
        </div>
      )}
      {groups.map(([group, list]) => (
        <div key={group}>
          <div className="sidebar__section-title" style={{ padding: '14px 0 4px' }}>
            {group}
          </div>
          {list.map((tool) => (
            <div className="tool-row" key={tool.name}>
              <div className="tool-row__info">
                <div className="tool-row__name">{tool.name}</div>
                <div className="tool-row__desc">{tool.description}</div>
              </div>
              {session && (
                <button
                  className={`switch${tool.enabled ? ' switch--on' : ''}`}
                  onClick={() => toggleTool(tool)}
                  title={tool.enabled ? 'Desabilitar' : 'Habilitar'}
                  aria-label={`Alternar ${tool.name}`}
                />
              )}
            </div>
          ))}
        </div>
      ))}

      <div className="sidebar__section-title" style={{ padding: '20px 0 4px' }}>
        Servidores MCP do portal
      </div>
      {servers.map((server) => (
        <div className="tool-row" key={server.id}>
          <div className="tool-row__info">
            <div className="tool-row__name">{server.label}</div>
            <div className="tool-row__desc">
              {server.type === 'stdio' ? `$ ${server.command} ${(server.args ?? []).join(' ')}` : server.url}
            </div>
          </div>
          <button
            className="btn btn--ghost"
            style={{ padding: '2px 8px' }}
            title="Remover servidor"
            onClick={() => {
              if (window.confirm(`Remover o servidor "${server.label}"?`)) {
                void api.deleteMcpServer(server.id).then(reload);
              }
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <McpServerForm onCreated={() => void reload()} />
    </Drawer>
  );
}

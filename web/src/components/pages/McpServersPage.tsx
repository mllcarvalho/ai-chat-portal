import { useEffect, useState } from 'react';
import type { McpServerInfo } from '@aiportal/shared';
import { api } from '../../api/client';
import { useUi } from '../../stores/uiStore';
import { PageShell } from './PageShell';

type CreateKind = 'stdio' | 'http' | 'proxy';

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const toast = useUi((s) => s.toast);
  const [kind, setKind] = useState<CreateKind>('stdio');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const canSubmit =
    !!name.trim() &&
    (kind === 'proxy' || (kind === 'stdio' ? !!command.trim() : !!url.trim()));

  const submit = async () => {
    setBusy(true);
    try {
      if (kind === 'proxy') {
        await api.createMcpServer({ name: name.trim(), createProxy: true });
        toast(`Proxy criado em mcps/. Edite o arquivo .ts para adicionar suas ferramentas.`, 'ok');
      } else if (kind === 'stdio') {
        const [cmd, ...args] = command.trim().split(/\s+/);
        await api.createMcpServer({ name: name.trim(), type: 'stdio', command: cmd, args });
        toast('Servidor adicionado ao .vscode/mcp.json e ligado.', 'ok');
      } else {
        await api.createMcpServer({ name: name.trim(), type: 'http', url: url.trim() });
        toast('Servidor adicionado ao .vscode/mcp.json e ligado.', 'ok');
      }
      setName('');
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
    <div className="page-card">
      <h3 className="page-card__title">Novo servidor MCP</h3>
      <div className="row">
        <div className="field">
          <label>Nome</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex: jira" />
        </div>
        <div className="field">
          <label>Tipo</label>
          <select value={kind} onChange={(e) => setKind(e.target.value as CreateKind)}>
            <option value="stdio">stdio — comando local</option>
            <option value="http">http — URL remota</option>
            <option value="proxy">proxy TypeScript — gera mcps/&lt;nome&gt;.ts</option>
          </select>
        </div>
      </div>
      {kind === 'stdio' && (
        <div className="field">
          <label>Comando</label>
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="ex: npx -y @modelcontextprotocol/server-filesystem /tmp"
          />
        </div>
      )}
      {kind === 'http' && (
        <div className="field">
          <label>URL</label>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </div>
      )}
      {kind === 'proxy' && (
        <p className="page-hint">
          Cria um servidor MCP em TypeScript dentro do repo (<code>mcps/&lt;nome&gt;.ts</code>),
          executado via <code>npx tsx</code>. Edite o arquivo para implementar suas ferramentas —
          chamadas de API, consultas, scripts… o que precisar.
        </p>
      )}
      <button className="btn btn--primary" disabled={busy || !canSubmit} onClick={() => void submit()}>
        {busy ? 'Criando…' : 'Criar servidor'}
      </button>
    </div>
  );
}

function statusLabel(server: McpServerInfo): { text: string; cls: string } {
  switch (server.status) {
    case 'running':
      return { text: `ligado · ${server.toolCount} ferramenta${server.toolCount === 1 ? '' : 's'}`, cls: 'ok' };
    case 'starting':
      return { text: 'iniciando…', cls: 'warn' };
    case 'error':
      return { text: 'erro', cls: 'err' };
    default:
      return { text: 'desligado', cls: 'off' };
  }
}

export function McpServersPage() {
  const toast = useUi((s) => s.toast);
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [pending, setPending] = useState<string | undefined>();

  const reload = () => api.listMcpServers().then(setServers).catch(() => setServers([]));

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 5000);
    return () => clearInterval(timer);
  }, []);

  const toggle = async (server: McpServerInfo) => {
    setPending(server.name);
    try {
      const updated = await api.toggleMcpServer(server.name, !server.enabled);
      setServers((list) => list.map((s) => (s.name === updated.name ? updated : s)));
      if (updated.status === 'error') toast(updated.error ?? 'Falha ao iniciar', 'error');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setPending(undefined);
    }
  };

  const remove = async (server: McpServerInfo) => {
    if (!window.confirm(`Remover "${server.name}" do .vscode/mcp.json?`)) return;
    try {
      await api.deleteMcpServer(server.name);
      await reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <PageShell
      title="Servidores MCP"
      subtitle="Definidos em .vscode/mcp.json do projeto. Ligue e desligue por aqui — as ferramentas dos servidores ligados ficam disponíveis no modo Agent."
    >
      <div className="page-cols">
        <div>
          {servers.length === 0 && (
            <div className="empty-state">
              Nenhum servidor MCP no .vscode/mcp.json ainda. Crie um ao lado.
            </div>
          )}
          {servers.map((server) => {
            const status = statusLabel(server);
            return (
              <div className="mcp-row" key={server.name}>
                <button
                  className={`switch${server.enabled ? ' switch--on' : ''}`}
                  disabled={pending === server.name}
                  onClick={() => void toggle(server)}
                  title={server.enabled ? 'Desligar' : 'Ligar'}
                  aria-label={`Alternar ${server.name}`}
                />
                <div className="mcp-row__info">
                  <div className="mcp-row__name">
                    {server.name}
                    <span className={`mcp-status mcp-status--${status.cls}`}>{status.text}</span>
                  </div>
                  <div className="mcp-row__desc">
                    {server.type === 'stdio'
                      ? `$ ${server.command ?? ''} ${(server.args ?? []).join(' ')}`
                      : server.url}
                  </div>
                  {server.status === 'error' && server.error && (
                    <div className="mcp-row__error">{server.error}</div>
                  )}
                  {server.status === 'running' && server.toolNames.length > 0 && (
                    <div className="mcp-row__tools" title={server.toolNames.join(', ')}>
                      {server.toolNames.slice(0, 6).join(' · ')}
                      {server.toolNames.length > 6 ? ` · +${server.toolNames.length - 6}` : ''}
                    </div>
                  )}
                </div>
                <div className="mcp-row__actions">
                  {server.enabled && (
                    <button
                      className="btn btn--ghost"
                      title="Reiniciar servidor"
                      onClick={() => void api.restartMcpServer(server.name).then(reload)}
                    >
                      ↻
                    </button>
                  )}
                  <button className="btn btn--ghost" title="Remover" onClick={() => void remove(server)}>
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <CreateForm onCreated={() => void reload()} />
      </div>
    </PageShell>
  );
}

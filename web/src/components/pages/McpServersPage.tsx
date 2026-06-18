import { useEffect, useState } from 'react';
import type { McpServerInfo } from '@aiportal/shared';
import { api, type McpProxyInput } from '../../api/client';
import { useUi } from '../../stores/uiStore';
import { Select } from '../common/Select';
import { EmptyState, PageShell, Panel } from './PageShell';

type DraftKind = 'stdio' | 'http' | 'gateway' | 'proxy-ts';

interface McpDraft {
  /** Nome do proxy em edição (só para gateway já salvo). */
  editing?: string;
  kind: DraftKind;
  name: string;
  command: string;
  url: string;
  tokenUrl: string;
  gatewayUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  /** Editando um proxy existente: o secret já está guardado no SecretStorage. */
  secretKept: boolean;
}

const EMPTY_DRAFT: McpDraft = {
  kind: 'stdio',
  name: '',
  command: '',
  url: '',
  tokenUrl: '',
  gatewayUrl: '',
  clientId: '',
  clientSecret: '',
  scope: '',
  secretKept: false,
};

type TestState = { tools: string[] } | { error: string } | undefined;

function ServerForm({ draft, onChange, onClose, onSaved }: {
  draft: McpDraft;
  onChange: (d: McpDraft) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useUi((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestState>();

  const proxyInput = (): McpProxyInput => ({
    name: draft.name.trim(),
    tokenUrl: draft.tokenUrl.trim(),
    gatewayUrl: draft.gatewayUrl.trim(),
    clientId: draft.clientId.trim(),
    scope: draft.scope.trim() || undefined,
    // vazio = mantém o secret guardado (em edição); novo precisa de um secret
    clientSecret: draft.clientSecret ? draft.clientSecret : undefined,
  });

  const gatewayReady =
    !!draft.name.trim() &&
    !!draft.tokenUrl.trim() &&
    !!draft.gatewayUrl.trim() &&
    !!draft.clientId.trim() &&
    (draft.secretKept || !!draft.clientSecret);

  const canSubmit =
    draft.kind === 'gateway'
      ? gatewayReady
      : draft.kind === 'proxy-ts'
        ? !!draft.name.trim()
        : !!draft.name.trim() && (draft.kind === 'stdio' ? !!draft.command.trim() : !!draft.url.trim());

  const runTest = async () => {
    setTesting(true);
    setTest(undefined);
    try {
      const result = await api.testMcpProxy(proxyInput());
      setTest({ tools: result.tools });
    } catch (err) {
      setTest({ error: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      if (draft.kind === 'gateway') {
        await api.saveMcpProxy(proxyInput());
        toast(draft.editing ? 'Proxy atualizado e ligado.' : 'Proxy criado e ligado.', 'ok');
      } else if (draft.kind === 'proxy-ts') {
        await api.createMcpServer({ name: draft.name.trim(), createProxy: true });
        toast('Proxy TypeScript criado em mcps/. Edite o .ts para adicionar suas ferramentas.', 'ok');
      } else if (draft.kind === 'stdio') {
        const [cmd, ...args] = draft.command.trim().split(/\s+/);
        await api.createMcpServer({ name: draft.name.trim(), type: 'stdio', command: cmd, args });
        toast('Servidor adicionado ao .vscode/mcp.json e ligado.', 'ok');
      } else {
        await api.createMcpServer({ name: draft.name.trim(), type: 'http', url: draft.url.trim() });
        toast('Servidor adicionado ao .vscode/mcp.json e ligado.', 'ok');
      }
      onSaved();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={draft.editing ? `Editar proxy "${draft.editing}"` : 'Novo servidor'} className="panel--form">
      <div className="row">
        <div className="field">
          <label>Nome</label>
          <input
            value={draft.name}
            disabled={!!draft.editing}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            placeholder="ex: jira"
          />
        </div>
        <div className="field">
          <label>Tipo</label>
          <Select
            value={draft.kind}
            onChange={(value) => {
              setTest(undefined);
              onChange({ ...draft, kind: value as DraftKind });
            }}
            options={[
              { value: 'stdio', label: 'stdio', hint: 'Comando local' },
              { value: 'http', label: 'http', hint: 'URL remota (sem auth)' },
              { value: 'gateway', label: 'Gateway OAuth2', hint: 'Proxy pronto: token + gateway remoto' },
              { value: 'proxy-ts', label: 'proxy TypeScript', hint: 'Gera mcps/<nome>.ts no repo' },
            ]}
          />
        </div>
      </div>

      {draft.kind === 'stdio' && (
        <div className="field">
          <label>Comando</label>
          <input
            value={draft.command}
            onChange={(e) => onChange({ ...draft, command: e.target.value })}
            placeholder="ex: npx -y @modelcontextprotocol/server-filesystem /tmp"
          />
        </div>
      )}

      {draft.kind === 'http' && (
        <div className="field">
          <label>URL</label>
          <input
            value={draft.url}
            onChange={(e) => onChange({ ...draft, url: e.target.value })}
            placeholder="https://…"
          />
        </div>
      )}

      {draft.kind === 'proxy-ts' && (
        <p className="page-hint">
          Cria um servidor MCP em TypeScript dentro do repo (<code>mcps/&lt;nome&gt;.ts</code>),
          executado via <code>npx tsx</code>. Edite o arquivo para implementar suas ferramentas.
        </p>
      )}

      {draft.kind === 'gateway' && (
        <>
          <p className="page-hint">
            Proxy pronto: o portal obtém um token OAuth2 (client_credentials) no Token URL e conecta
            no gateway MCP remoto com <code>Bearer</code>, expondo as ferramentas de lá. O Client
            Secret fica guardado de forma segura e não volta para o navegador.
          </p>
          <div className="field">
            <label>Token URL</label>
            <input
              value={draft.tokenUrl}
              onChange={(e) => onChange({ ...draft, tokenUrl: e.target.value })}
              placeholder="https://sts.example.com/api/oauth/token"
            />
          </div>
          <div className="field">
            <label>MCP Gateway URL</label>
            <input
              value={draft.gatewayUrl}
              onChange={(e) => onChange({ ...draft, gatewayUrl: e.target.value })}
              placeholder="https://gateway.example.com/v1/meu-servico/mcp"
            />
          </div>
          <div className="row">
            <div className="field">
              <label>Client ID</label>
              <input
                value={draft.clientId}
                onChange={(e) => onChange({ ...draft, clientId: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Scope</label>
              <input
                value={draft.scope}
                onChange={(e) => onChange({ ...draft, scope: e.target.value })}
                placeholder="ex: meu-servico.write"
              />
            </div>
          </div>
          <div className="field">
            <label>Client Secret</label>
            <input
              type="password"
              value={draft.clientSecret}
              onChange={(e) => onChange({ ...draft, clientSecret: e.target.value })}
              placeholder={draft.secretKept ? '•••••• (mantido — preencha para trocar)' : ''}
              autoComplete="off"
            />
          </div>
          {test && 'tools' in test && (
            <div className="mcp-test mcp-test--ok">
              <div className="mcp-test__title">
                ✓ Conectou · {test.tools.length} ferramenta{test.tools.length === 1 ? '' : 's'}
              </div>
              {test.tools.length > 0 && (
                <div className="chips">
                  {test.tools.map((t) => (
                    <span className="chip" key={t}>
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {test && 'error' in test && (
            <div className="mcp-test mcp-test--err">
              <div className="mcp-test__title">✗ Falhou</div>
              {test.error}
            </div>
          )}
        </>
      )}

      <div className="form-actions">
        <button className="btn" onClick={onClose}>
          Cancelar
        </button>
        {draft.kind === 'gateway' && (
          <button className="btn" disabled={testing || !gatewayReady} onClick={() => void runTest()}>
            {testing ? 'Testando…' : '🔌 Testar conexão'}
          </button>
        )}
        <button className="btn btn--primary" disabled={busy || !canSubmit} onClick={() => void submit()}>
          {busy ? 'Salvando…' : draft.kind === 'gateway' && draft.editing ? 'Salvar' : 'Criar servidor'}
        </button>
      </div>
    </Panel>
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
  const confirm = useUi((s) => s.confirm);
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [pending, setPending] = useState<string | undefined>();
  const [draft, setDraft] = useState<McpDraft | undefined>();

  const reload = () => api.listMcpServers().then(setServers).catch(() => setServers([]));

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 5000);
    return () => clearInterval(timer);
  }, []);

  const editProxy = (server: McpServerInfo) => {
    if (server.kind !== 'proxy' || !server.proxy) return;
    setDraft({
      ...EMPTY_DRAFT,
      editing: server.name,
      kind: 'gateway',
      name: server.proxy.name,
      tokenUrl: server.proxy.tokenUrl,
      gatewayUrl: server.proxy.gatewayUrl,
      clientId: server.proxy.clientId,
      scope: server.proxy.scope ?? '',
      secretKept: true,
    });
  };

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
    const ok = await confirm({
      title: 'Remover servidor MCP',
      message:
        server.kind === 'proxy'
          ? `Remover o proxy "${server.name}"? O Client Secret guardado também será apagado.`
          : `Remover "${server.name}" do .vscode/mcp.json?`,
      confirmLabel: 'Remover',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteMcpServer(server.name);
      if (draft?.editing === server.name) setDraft(undefined);
      await reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <PageShell
      icon="🔧"
      title="Servidores MCP"
      subtitle="Ligue e desligue por aqui — as ferramentas dos servidores ligados ficam disponíveis no modo Agent."
      actions={
        <button className="btn btn--primary" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
          ＋ Novo servidor
        </button>
      }
    >
      <div className="page-cols">
        <Panel title="Servidores" count={servers.length}>
          {servers.length === 0 && (
            <EmptyState
              icon="🔧"
              title="Nenhum servidor MCP ainda"
              hint="Crie um servidor pelo botão “Novo servidor” no topo."
              action={
                <button className="btn btn--primary" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
                  ＋ Novo servidor
                </button>
              }
            />
          )}
          {servers.map((server) => {
            const status = statusLabel(server);
            const isProxy = server.kind === 'proxy';
            return (
              <div className={`mcp-row${draft?.editing === server.name ? ' mcp-row--active' : ''}`} key={server.name}>
                <button
                  className={`switch${server.enabled ? ' switch--on' : ''}`}
                  disabled={pending === server.name}
                  onClick={() => void toggle(server)}
                  title={server.enabled ? 'Desligar' : 'Ligar'}
                  aria-label={`Alternar ${server.name}`}
                />
                <div
                  className="mcp-row__info"
                  style={isProxy ? { cursor: 'pointer' } : undefined}
                  onClick={isProxy ? () => editProxy(server) : undefined}
                  title={isProxy ? 'Editar proxy' : undefined}
                >
                  <div className="mcp-row__name">
                    {server.name}
                    {isProxy && <span className="chip" style={{ marginLeft: 2 }}>OAuth2</span>}
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
                      className="icon-btn"
                      title="Reiniciar servidor"
                      onClick={() => void api.restartMcpServer(server.name).then(reload)}
                    >
                      ↻
                    </button>
                  )}
                  <button className="icon-btn icon-btn--danger" title="Remover" onClick={() => void remove(server)}>
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </Panel>
        {draft ? (
          <ServerForm
            draft={draft}
            onChange={setDraft}
            onClose={() => setDraft(undefined)}
            onSaved={() => {
              setDraft(undefined);
              void reload();
            }}
          />
        ) : (
          <Panel className="panel--placeholder">
            <EmptyState
              icon="🔧"
              title="Nenhum servidor selecionado"
              hint="Crie um servidor novo no topo, ou clique num proxy OAuth2 da lista para editar."
            />
          </Panel>
        )}
      </div>
    </PageShell>
  );
}

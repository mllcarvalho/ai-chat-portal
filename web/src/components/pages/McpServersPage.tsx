import { useEffect, useRef, useState } from 'react';
import type { ConsumerLabStatus, McpServerInfo } from '@aiportal/shared';
import { api, type McpProxyInput } from '../../api/client';
import { useUi } from '../../stores/uiStore';
import { Select } from '../common/Select';
import { EmptyState, PageShell, Panel } from './PageShell';

type DraftKind = 'stdio' | 'http' | 'gateway' | 'proxy-ts' | 'consumerlab';

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

/**
 * Setup guiado do ConsumerLab: dispara o fluxo no backend (pré-requisitos →
 * clone → uv sync → SSO AWS → conta/role → servidor ligado) e acompanha por
 * polling. Só as escolhas de conta e role dependem do usuário.
 */
function ConsumerLabSetup({ onDone }: { onDone: () => void }) {
  const toast = useUi((s) => s.toast);
  const [status, setStatus] = useState<ConsumerLabStatus>();
  const [busy, setBusy] = useState(false);
  /** Só fecha o painel quando o done acontecer NESTA visita (não em setup antigo). */
  const sawInProgress = useRef(false);
  const doneNotified = useRef(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      api
        .getConsumerLab()
        .then((s) => alive && setStatus(s))
        .catch(() => undefined);
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [status?.log]);

  useEffect(() => {
    if (!status) return;
    if (status.phase !== 'done') {
      if (status.phase !== 'idle') sawInProgress.current = true;
      return;
    }
    if (sawInProgress.current && !doneNotified.current) {
      doneNotified.current = true;
      toast('ConsumerLab configurado e ligado.', 'ok');
      onDone();
    }
  }, [status, toast, onDone]);

  const call = async (fn: () => Promise<ConsumerLabStatus>) => {
    setBusy(true);
    try {
      setStatus(await fn());
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const idle = !status || status.phase === 'idle';
  const failed = status?.phase === 'error';
  // "done" de uma visita anterior: oferece refazer (útil quando o SSO expira)
  const doneBefore = status?.phase === 'done' && !sawInProgress.current;

  return (
    <>
      <p className="page-hint">
        Servidor MCP do <strong>Consumer Lab</strong> (Itaú). O portal faz o setup completo:
        verifica git/python/uv/AWS CLI, baixa o repositório, instala as dependências e abre o
        browser para o login SSO — você só escolhe a conta AWS quando ela aparecer aqui.
        Quando as credenciais AWS expirarem, refaça o setup por aqui.
      </p>

      {(idle || failed || doneBefore) && (
        <>
          {failed && (
            <div className="mcp-test mcp-test--err">
              <div className="mcp-test__title">✗ {status?.phaseLabel}</div>
              {status?.error}
            </div>
          )}
          <div className="form-actions">
            <button className="btn btn--primary" disabled={busy} onClick={() => void call(api.startConsumerLab)}>
              {failed ? 'Tentar de novo' : doneBefore ? '🔁 Refazer setup' : '🚀 Iniciar setup'}
            </button>
          </div>
        </>
      )}

      {status && status.phase !== 'idle' && !failed && (
        <>
          <div className={`mcp-test ${status.phase === 'done' ? 'mcp-test--ok' : ''}`}>
            <div className="mcp-test__title">
              {status.phase === 'done' ? '✓' : '⏳'} {status.phaseLabel}
            </div>
            {status.profile && status.phase === 'done' && <>Profile AWS: {status.profile}</>}
          </div>

          {status.phase === 'awaiting-account' && (
            <div className="field">
              <label>Conta AWS{status.ssoPortal ? ` — ${status.ssoPortal}` : ''}</label>
              <div className="chips">
                {(status.accounts ?? []).map((account) => (
                  <button
                    key={account.id}
                    className="chip chip--action"
                    disabled={busy}
                    onClick={() => void call(() => api.chooseConsumerLab({ accountId: account.id }))}
                  >
                    {account.name} · {account.id}
                  </button>
                ))}
              </div>
              {status.altSsoPortal && (
                <button
                  className="btn"
                  style={{ marginTop: 10 }}
                  disabled={busy}
                  onClick={() => void call(api.switchConsumerLabSso)}
                >
                  Minha conta não está aqui — entrar no SSO {status.altSsoPortal}
                </button>
              )}
            </div>
          )}

          {status.phase === 'awaiting-role' && (
            <div className="field">
              <label>Role</label>
              <div className="chips">
                {(status.roles ?? []).map((role) => (
                  <button
                    key={role}
                    className="chip chip--action"
                    disabled={busy}
                    onClick={() => void call(() => api.chooseConsumerLab({ roleName: role }))}
                  >
                    {role}
                  </button>
                ))}
              </div>
            </div>
          )}

          {status.log && (
            <pre className="mcp-setup-log" ref={logRef}>
              {status.log}
            </pre>
          )}

          {status.running && (
            <div className="form-actions">
              <button className="btn" disabled={busy} onClick={() => void call(api.cancelConsumerLab)}>
                Cancelar setup
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

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
    <Panel
      title={
        draft.editing
          ? draft.kind === 'consumerlab'
            ? 'ConsumerLab — reconfigurar'
            : `Editar proxy "${draft.editing}"`
          : 'Novo servidor'
      }
      className="panel--form"
    >
      <div className="row">
        <div className="field">
          <label>Nome</label>
          <input
            value={draft.kind === 'consumerlab' ? 'consumerlab' : draft.name}
            disabled={!!draft.editing || draft.kind === 'consumerlab'}
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
              { value: 'consumerlab', label: 'ConsumerLab (Itaú)', hint: 'Setup automático: repo + AWS SSO' },
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

      {draft.kind === 'consumerlab' && <ConsumerLabSetup onDone={onSaved} />}

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
        {draft.kind !== 'consumerlab' && (
          <button className="btn btn--primary" disabled={busy || !canSubmit} onClick={() => void submit()}>
            {busy ? 'Salvando…' : draft.kind === 'gateway' && draft.editing ? 'Salvar' : 'Criar servidor'}
          </button>
        )}
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
  /** Servidor com a lista de ferramentas expandida + cache por servidor. */
  const [toolsOpen, setToolsOpen] = useState<string | undefined>();
  const [toolsCache, setToolsCache] = useState<Record<string, Array<{ name: string; description: string }>>>({});

  const toggleTools = async (server: McpServerInfo) => {
    if (toolsOpen === server.name) {
      setToolsOpen(undefined);
      return;
    }
    setToolsOpen(server.name);
    try {
      const tools = await api.listMcpServerTools(server.name);
      setToolsCache((cache) => ({ ...cache, [server.name]: tools }));
    } catch (err) {
      toast((err as Error).message, 'error');
      setToolsOpen(undefined);
    }
  };

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
            // servidor do setup guiado: clicar reabre o painel (trocar conta, refazer SSO)
            const isConsumerLab = server.kind === 'mcpjson' && server.name === 'consumerlab';
            const open = isProxy
              ? () => editProxy(server)
              : isConsumerLab
                ? () =>
                    setDraft({
                      ...EMPTY_DRAFT,
                      kind: 'consumerlab',
                      name: server.name,
                      editing: server.name,
                    })
                : undefined;
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
                  style={open ? { cursor: 'pointer' } : undefined}
                  onClick={open}
                  title={isProxy ? 'Editar proxy' : isConsumerLab ? 'Reconfigurar (conta, SSO)' : undefined}
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
                  {server.status === 'running' && server.toolNames.length > 0 && toolsOpen !== server.name && (
                    <div className="mcp-row__tools" title={server.toolNames.join(', ')}>
                      {server.toolNames.slice(0, 6).join(' · ')}
                      {server.toolNames.length > 6 ? ` · +${server.toolNames.length - 6}` : ''}
                    </div>
                  )}
                  {toolsOpen === server.name && (
                    <div className="mcp-tool-list" onClick={(e) => e.stopPropagation()}>
                      {(toolsCache[server.name] ?? []).map((tool) => (
                        <div className="mcp-tool" key={tool.name}>
                          <div className="mcp-tool__name">{tool.name}</div>
                          {tool.description && <div className="mcp-tool__desc">{tool.description}</div>}
                        </div>
                      ))}
                      {!toolsCache[server.name] && <div className="mcp-tool__desc">Carregando…</div>}
                    </div>
                  )}
                </div>
                <div className="mcp-row__actions">
                  {server.status === 'running' && server.toolCount > 0 && (
                    <button
                      className={`icon-btn${toolsOpen === server.name ? ' icon-btn--active' : ''}`}
                      title={toolsOpen === server.name ? 'Esconder ferramentas' : 'Ver ferramentas'}
                      onClick={(e) => {
                        e.stopPropagation();
                        void toggleTools(server);
                      }}
                    >
                      🧰
                    </button>
                  )}
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

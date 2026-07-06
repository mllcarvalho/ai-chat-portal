import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConsumerLabStatus, IuclickStatus, McpServerInfo } from '@aiportal/shared';
import { api, type McpProxyInput } from '../../api/client';
import { useUi } from '../../stores/uiStore';
import { Modal } from '../common/Modal';
import { Select } from '../common/Select';
import { EmptyState, PageShell, Panel } from './PageShell';

type McpTool = { name: string; description: string };

/**
 * Modal com todas as ferramentas de um servidor MCP (nome + descrição) e busca
 * — a lista inline ficava impraticável em servidores com muitas tools.
 */
function McpToolsModal({
  server,
  tools,
  onClose,
}: {
  server: McpServerInfo;
  tools: McpTool[] | undefined;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const shown = useMemo(
    () =>
      !q
        ? (tools ?? [])
        : (tools ?? []).filter(
            (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
          ),
    [tools, q],
  );

  return (
    <Modal
      title={`Ferramentas · ${server.name}`}
      wide
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          Fechar
        </button>
      }
    >
      {tools === undefined ? (
        <div className="mcp-tool__desc">Carregando…</div>
      ) : tools.length === 0 ? (
        <EmptyState icon="🧰" title="Sem ferramentas" hint="Este servidor não expôs ferramentas." />
      ) : (
        <>
          <input
            className="mcp-tools-search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Buscar entre ${tools.length} ferramenta${tools.length === 1 ? '' : 's'}…`}
            autoFocus
          />
          <div className="mcp-tools-modal-list">
            {shown.map((tool) => (
              <div className="mcp-tools-modal-item" key={tool.name}>
                <div className="mcp-tool__name">{tool.name}</div>
                {tool.description && <div className="mcp-tool__desc">{tool.description}</div>}
              </div>
            ))}
            {shown.length === 0 && (
              <div className="mcp-tool__desc">Nenhuma ferramenta corresponde a “{filter}”.</div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

type DraftKind = 'gateway' | 'consumerlab' | 'iuclick' | 'github';

/** Tipos de setup guiado — o nome do servidor é fixo e não há campos livres. */
const FIXED_NAMES: Partial<Record<DraftKind, string>> = {
  consumerlab: 'consumerlab',
  iuclick: 'iuclick',
  github: 'github',
};

interface McpDraft {
  /** Nome do proxy em edição (só para gateway já salvo). */
  editing?: string;
  kind: DraftKind;
  name: string;
  tokenUrl: string;
  gatewayUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  /** Editando um proxy existente: o secret já está guardado no SecretStorage. */
  secretKept: boolean;
}

const EMPTY_DRAFT: McpDraft = {
  kind: 'gateway',
  name: '',
  tokenUrl: '',
  gatewayUrl: '',
  clientId: '',
  clientSecret: '',
  scope: '',
  secretKept: false,
};

type TestState = { tools: string[] } | { error: string } | undefined;

/**
 * Extrai Cookie e X-UserToken de um blob colado do DevTools — aceita "Copy as
 * cURL" (bash e cmd), "Copy request headers" e "Copy as fetch". O JSESSIONID é
 * HttpOnly (JS da página não lê), então o caminho garantido é copiar a
 * requisição inteira do DevTools e deixar o portal separar as duas partes.
 */
function parseDevtoolsCreds(raw: string): { cookies: string; token: string } {
  // junta continuações de linha do cmd (`^` + newline); o `\` do bash pode
  // ficar, o valor para no fecha-aspas mesmo com tudo numa linha só
  const text = raw.replace(/\^\r?\n/g, ' ');
  let cookies = '';
  let token = '';
  const take = (name: string, rawValue: string) => {
    let v = rawValue.trim();
    // valor citado inteiro (caso do -b '...'): fica só o conteúdo da string
    if (/^['"]/.test(v)) v = v.replace(/^(['"])([\s\S]*?)\1[\s\S]*$/, '$2');
    v = v.replace(/['",;]+$/, '').trim();
    if (!v) return;
    if (name === 'cookie' && !cookies) cookies = v;
    if (name === 'x-usertoken' && !token) token = v;
  };
  // -b/--cookie do cURL (valor citado ou solto)
  const b = /(?:^|\s)(?:-b|--cookie)[\s=]+("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/.exec(text);
  if (b) take('cookie', b[1]);
  // pares nome: valor — cobre -H 'nome: valor', "nome: valor", linhas soltas e
  // JSON "nome": "valor"; para no fecha-aspas/fim de linha (não atravessa headers)
  const pair = /['"]?(cookie|x-usertoken)['"]?\s*:\s*['"]?([^'"\r\n]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = pair.exec(text))) take(m[1].toLowerCase(), m[2]);
  return { cookies, token };
}

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
        <div className="mcp-setup">
          {failed && (
            <div className="mcp-test mcp-test--err">
              <div className="mcp-test__title">✗ {status?.phaseLabel}</div>
              {status?.error}
            </div>
          )}
          <section className="mcp-block">
            <div className="mcp-block__head">
              <span className="mcp-block__title">☁️ Setup do Consumer Lab</span>
            </div>
            <p className="mcp-block__hint">
              Verifica git/python/uv/AWS CLI, baixa o repositório, instala as dependências e abre o
              browser para o login SSO. Você só escolhe a conta AWS quando ela aparecer aqui.
              {(doneBefore || failed) && ' Refaça quando as credenciais AWS expirarem.'}
            </p>
            <div className="mcp-block__actions">
              <button className="btn btn--primary" disabled={busy} onClick={() => void call(api.startConsumerLab)}>
                {failed ? '🔁 Tentar de novo' : doneBefore ? '🔁 Refazer setup' : '🚀 Iniciar setup'}
              </button>
            </div>
          </section>
        </div>
      )}

      {status && status.phase !== 'idle' && !failed && (
        <div className="mcp-setup">
          <div className={`mcp-test ${status.phase === 'done' ? 'mcp-test--ok' : ''}`}>
            <div className="mcp-test__title">
              {status.phase === 'done' ? '✓' : '⏳'} {status.phaseLabel}
            </div>
            {status.profile && status.phase === 'done' && <>Profile AWS: {status.profile}</>}
          </div>

          {status.phase === 'awaiting-account' && (
            <section className="mcp-block">
              <div className="mcp-block__head">
                <span className="mcp-block__title">Escolha a conta AWS</span>
                {status.ssoPortal && <span className="mcp-block__pill">{status.ssoPortal}</span>}
              </div>
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
                <div className="mcp-block__actions">
                  <button className="btn" disabled={busy} onClick={() => void call(api.switchConsumerLabSso)}>
                    Minha conta não está aqui — entrar no SSO {status.altSsoPortal}
                  </button>
                </div>
              )}
            </section>
          )}

          {status.phase === 'awaiting-role' && (
            <section className="mcp-block">
              <div className="mcp-block__head">
                <span className="mcp-block__title">Escolha a role</span>
              </div>
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
            </section>
          )}

          {status.log && (
            <pre className="mcp-setup-log" ref={logRef}>
              {status.log}
            </pre>
          )}

          {status.running && (
            <div className="mcp-block__actions mcp-block__actions--end">
              <button className="btn" disabled={busy} onClick={() => void call(api.cancelConsumerLab)}>
                Cancelar setup
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Setup guiado do IUClick (ServiceNow Itaú): dispara o fluxo no backend
 * (Node/npx → registry privado no ~/.npmrc → download do pacote → servidor
 * ligado) e acompanha por polling. Cookie e X-UserToken são opcionais — sem
 * eles a autenticação é feita pela tool `login` durante a sessão de chat.
 */
function IuclickSetup({ onDone }: { onDone: () => void }) {
  const toast = useUi((s) => s.toast);
  const confirm = useUi((s) => s.confirm);
  const [status, setStatus] = useState<IuclickStatus>();
  const [cookies, setCookies] = useState('');
  const [token, setToken] = useState('');
  const [curlBlob, setCurlBlob] = useState('');
  const [busy, setBusy] = useState(false);
  /** Só fecha o painel quando o done acontecer NESTA visita (não em setup antigo). */
  const sawInProgress = useRef(false);
  const doneNotified = useRef(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      api
        .getIuclick()
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
      toast('IUClick configurado e ligado.', 'ok');
      onDone();
    }
  }, [status, toast, onDone]);

  const call = async (fn: () => Promise<IuclickStatus>) => {
    setBusy(true);
    try {
      setStatus(await fn());
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const reauth = async () => {
    setBusy(true);
    try {
      const result = await api.reauthIuclick({ cookies: cookies.trim(), token: token.trim() });
      toast(result.message, 'ok');
      setCookies('');
      setToken('');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  /** Faxina: remove o IUClick de todos os locais (para o "removi e ainda dá 403"). */
  const purge = async () => {
    const ok = await confirm({
      title: 'Remover e limpar o IUClick',
      message:
        'Remove o servidor IUClick de todos os locais (mcp.json ativo e global, estado e credenciais guardadas). ' +
        'Use se o IUClick continuar dando erro (ex.: 403) mesmo depois de removido.',
      confirmLabel: 'Limpar tudo',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await api.purgeIuclick();
      toast(result.message, 'ok');
      onDone();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  /** Detecção automática: portal lê os cookies do navegador e busca o X-UserToken. */
  const autodetect = async () => {
    setBusy(true);
    try {
      const result = await api.autodetectIuclick();
      toast(result.message, 'ok');
    } catch (err) {
      toast(`${(err as Error).message} — se persistir, use "Colar do DevTools" abaixo.`, 'error');
    } finally {
      setBusy(false);
    }
  };

  /** Plano B: extrai Cookie e X-UserToken de um "Copy as cURL" colado do DevTools. */
  const parseCurl = () => {
    const parsed = parseDevtoolsCreds(curlBlob);
    if (!parsed.cookies && !parsed.token) {
      toast('Não achei Cookie nem X-UserToken no texto colado. Use "Copy as cURL" da requisição.', 'error');
      return;
    }
    setCookies(parsed.cookies);
    setToken(parsed.token);
    const got = [parsed.cookies ? 'Cookie' : '', parsed.token ? 'X-UserToken' : ''].filter(Boolean).join(' e ');
    const miss = !parsed.cookies ? ' (faltou o Cookie)' : !parsed.token ? ' (faltou o X-UserToken)' : '';
    toast(`Extraído: ${got}${miss}. Confira e clique em salvar/atualizar.`, miss ? 'error' : 'ok');
  };

  const idle = !status || status.phase === 'idle';
  const failed = status?.phase === 'error';
  // "done" de uma visita anterior: oferece refazer (útil quando a sessão expira)
  const doneBefore = status?.phase === 'done' && !sawInProgress.current;
  const halfCreds = !!cookies.trim() !== !!token.trim();
  const bothCreds = !!cookies.trim() && !!token.trim();

  return (
    <>
      <p className="page-hint">
        Servidor MCP do <strong>IUClick</strong> (ServiceNow Itaú). O portal faz o setup completo:
        configura o registry privado do Itaú no <code>~/.npmrc</code>, baixa o pacote{' '}
        <code>@ai-stack-fn7/mcp-servers</code> e liga o servidor. As credenciais são opcionais:
        sem elas, use a tool <code>login</code> no chat. A sessão do ServiceNow expira — quando o
        MCP der erro de autenticação, capture Cookie e X-UserToken de novo e refaça por aqui.
      </p>

      {(idle || failed || doneBefore) && (
        <div className="mcp-setup">
          {failed && (
            <div className="mcp-test mcp-test--err">
              <div className="mcp-test__title">✗ {status?.phaseLabel}</div>
              {status?.error}
            </div>
          )}

          {/* Bloco 1 — caminho recomendado: detecta credenciais e, na 1ª vez,
              instala e liga o servidor de uma vez */}
          <section className="mcp-block">
            <div className="mcp-block__head">
              <span className="mcp-block__title">
                {status?.installed ? '🔐 Credenciais do ServiceNow' : '🪄 Configurar automaticamente'}
              </span>
              {status?.hasCredentials && <span className="mcp-block__pill">guardadas</span>}
            </div>
            <p className="mcp-block__hint">
              O portal lê as credenciais direto do navegador onde você está logado no{' '}
              <code>itau.service-now.com</code> (Chrome, Edge ou Firefox) — sem mexer no DevTools.{' '}
              {status?.installed
                ? 'Detectar de novo renova quando a sessão expira.'
                : 'Na primeira vez, isto também instala e liga o servidor. Recomendado.'}
            </p>
            <div className="mcp-block__actions">
              <button className="btn btn--primary" disabled={busy} onClick={() => void autodetect()}>
                {busy
                  ? 'Detectando…'
                  : status?.installed
                    ? '🪄 Detectar credenciais'
                    : '🪄 Detectar e configurar'}
              </button>
              {status?.installed && (
                <button className="btn btn--danger" disabled={busy} onClick={() => void purge()}>
                  🧹 Remover e limpar tudo
                </button>
              )}
            </div>

            <details className="mcp-fallback">
              <summary>Não funcionou? Colar do DevTools</summary>
              <div className="mcp-fallback__body">
                <p className="mcp-block__hint">
                  Na aba do <code>itau.service-now.com</code> logada, abra o DevTools (F12) → aba{' '}
                  <strong>Network</strong>, clique numa requisição para{' '}
                  <code>itau.service-now.com</code>, botão direito →{' '}
                  <strong>Copy → Copy as cURL</strong> e cole aqui — o portal extrai o Cookie e o
                  X-UserToken sozinho.
                </p>
                <div className="field">
                  <textarea
                    className="page-card__editor"
                    style={{ minHeight: 84, fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}
                    value={curlBlob}
                    onChange={(e) => setCurlBlob(e.target.value)}
                    placeholder="curl 'https://itau.service-now.com/…' -H 'cookie: JSESSIONID=…' -H 'x-usertoken: …' …"
                  />
                </div>
                <div className="mcp-block__actions mcp-block__actions--end">
                  <button className="btn" disabled={busy || !curlBlob.trim()} onClick={parseCurl}>
                    Extrair credenciais
                  </button>
                </div>

                <div className="mcp-fallback__divider">
                  Ou cole cada valor à mão (Cookie e X-UserToken dos Request Headers)
                  {status?.hasCredentials ? ' — deixe vazio para manter as guardadas.' : ':'}
                </div>
                <div className="field">
                  <label>Cookie</label>
                  <input
                    type="password"
                    value={cookies}
                    onChange={(e) => setCookies(e.target.value)}
                    placeholder="JSESSIONID=…; glide_session_store=…"
                    autoComplete="off"
                  />
                </div>
                <div className="field">
                  <label>X-UserToken</label>
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="string hexadecimal longa"
                    autoComplete="off"
                  />
                </div>
                <div className="mcp-block__actions mcp-block__actions--end">
                  <button
                    className="btn"
                    disabled={busy || !bothCreds}
                    title={bothCreds ? undefined : 'Preencha Cookie e X-UserToken'}
                    onClick={() =>
                      void (doneBefore || status?.hasCredentials
                        ? reauth()
                        : call(() => api.startIuclick({ cookies: cookies.trim(), token: token.trim() })))
                    }
                  >
                    {doneBefore || status?.hasCredentials
                      ? '🔑 Salvar e religar'
                      : '💾 Salvar credenciais'}
                  </button>
                </div>
              </div>
            </details>
          </section>

          {/* Bloco 2 — instalar sem credenciais (alternativa quando a detecção
              não rola, ex: não está logado no navegador) */}
          <section className="mcp-block">
            <div className="mcp-block__head">
              <span className="mcp-block__title">📦 Servidor MCP</span>
              {status?.installed && <span className="mcp-block__pill">instalado</span>}
            </div>
            <p className="mcp-block__hint">
              {status?.installed
                ? 'O servidor já está registrado. Refaça só se precisar reinstalar o pacote do zero.'
                : 'Alternativa: instala o servidor sem credenciais agora (registry do Itaú + pacote @ai-stack-fn7/mcp-servers) e você autentica depois pela tool login no chat.'}
            </p>
            <div className="mcp-block__actions">
              <button
                className="btn"
                disabled={busy || halfCreds}
                title={halfCreds ? 'Informe Cookie e X-UserToken juntos (ou deixe ambos vazios)' : undefined}
                onClick={() =>
                  void call(() => api.startIuclick({ cookies: cookies.trim(), token: token.trim() }))
                }
              >
                {failed ? '🔁 Tentar setup de novo' : status?.installed ? '🔁 Refazer setup do zero' : '🚀 Instalar sem credenciais'}
              </button>
            </div>
          </section>
        </div>
      )}

      {status && status.phase !== 'idle' && !failed && (
        <div className="mcp-setup">
          <div className={`mcp-test ${status.phase === 'done' ? 'mcp-test--ok' : ''}`}>
            <div className="mcp-test__title">
              {status.phase === 'done' ? '✓' : '⏳'} {status.phaseLabel}
            </div>
            {status.phase === 'done' &&
              (status.hasCredentials
                ? 'Credenciais guardadas no SecretStorage — entram como env na subida do servidor.'
                : 'Sem credenciais salvas — use a tool login no chat para autenticar.')}
          </div>

          {status.log && (
            <pre className="mcp-setup-log" ref={logRef}>
              {status.log}
            </pre>
          )}

          {status.running && (
            <div className="mcp-block__actions mcp-block__actions--end">
              <button className="btn" disabled={busy} onClick={() => void call(api.cancelIuclick)}>
                Cancelar setup
              </button>
            </div>
          )}
        </div>
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

  const canSubmit = draft.kind === 'gateway' ? gatewayReady : draft.kind === 'github';

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
      } else if (draft.kind === 'github') {
        const info = await api.setupGitHubMcp();
        if (info.status === 'error') {
          toast(info.error ?? 'Falha ao conectar no MCP do GitHub', 'error');
        } else {
          toast('MCP do GitHub conectado.', 'ok');
        }
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
            : draft.kind === 'iuclick'
              ? 'IUClick — reconfigurar'
              : `Editar proxy "${draft.editing}"`
          : 'Novo servidor'
      }
      className="panel--form"
    >
      <div className="row">
        <div className="field">
          <label>Nome</label>
          <input
            value={FIXED_NAMES[draft.kind] ?? draft.name}
            disabled={!!draft.editing || !!FIXED_NAMES[draft.kind]}
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
              { value: 'gateway', label: 'Gateway OAuth2', hint: 'Proxy pronto: token + gateway remoto' },
              { value: 'consumerlab', label: 'ConsumerLab (Itaú)', hint: 'Setup automático: repo + AWS SSO' },
              { value: 'iuclick', label: 'IUClick (Itaú)', hint: 'Setup automático: ServiceNow via npx' },
              { value: 'github', label: 'GitHub', hint: 'MCP oficial, com a conta GitHub do VS Code' },
            ]}
          />
        </div>
      </div>

      {draft.kind === 'github' && (
        <p className="page-hint">
          Conecta no servidor MCP oficial do <strong>GitHub</strong> (o mesmo que o Copilot usa no
          VS Code): repositórios, issues, pull requests e mais. A autenticação usa a conta GitHub
          já conectada no VS Code — na primeira vez, autorize pela notificação que aparece lá.
          Nenhum token fica salvo em arquivo.
        </p>
      )}

      {draft.kind === 'consumerlab' && <ConsumerLabSetup onDone={onSaved} />}

      {draft.kind === 'iuclick' && <IuclickSetup onDone={onSaved} />}

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
        {draft.kind !== 'consumerlab' && draft.kind !== 'iuclick' && (
          <button className="btn btn--primary" disabled={busy || !canSubmit} onClick={() => void submit()}>
            {busy
              ? draft.kind === 'github'
                ? 'Conectando…'
                : 'Salvando…'
              : draft.kind === 'github'
                ? '🔗 Conectar'
                : draft.kind === 'gateway' && draft.editing
                  ? 'Salvar'
                  : 'Criar servidor'}
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
  /** Servidor com o modal de ferramentas aberto + cache por servidor. */
  const [toolsModal, setToolsModal] = useState<McpServerInfo | undefined>();
  const [toolsCache, setToolsCache] = useState<Record<string, McpTool[]>>({});

  const openTools = async (server: McpServerInfo) => {
    setToolsModal(server);
    if (toolsCache[server.name]) return;
    try {
      const tools = await api.listMcpServerTools(server.name);
      setToolsCache((cache) => ({ ...cache, [server.name]: tools }));
    } catch (err) {
      toast((err as Error).message, 'error');
      setToolsModal(undefined);
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
            // servidor do setup guiado: clicar reabre o painel (trocar conta, refazer SSO/credenciais)
            const isConsumerLab = server.kind === 'mcpjson' && server.name === 'consumerlab';
            const isIuclick = server.kind === 'mcpjson' && server.name === 'iuclick';
            const open = isProxy
              ? () => editProxy(server)
              : isConsumerLab || isIuclick
                ? () =>
                    setDraft({
                      ...EMPTY_DRAFT,
                      kind: isConsumerLab ? 'consumerlab' : 'iuclick',
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
                  title={
                    isProxy
                      ? 'Editar proxy'
                      : isConsumerLab
                        ? 'Reconfigurar (conta, SSO)'
                        : isIuclick
                          ? 'Reconfigurar (credenciais do ServiceNow)'
                          : undefined
                  }
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
                  {server.status === 'running' && server.toolCount > 0 && (
                    <button
                      className="icon-btn"
                      title={`Ver ${server.toolCount} ferramenta${server.toolCount === 1 ? '' : 's'}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void openTools(server);
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
      {toolsModal && (
        <McpToolsModal
          server={toolsModal}
          tools={toolsCache[toolsModal.name]}
          onClose={() => setToolsModal(undefined)}
        />
      )}
    </PageShell>
  );
}

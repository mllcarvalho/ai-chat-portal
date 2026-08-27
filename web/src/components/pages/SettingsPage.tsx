import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Bot,
  Check,
  Copy,
  Eye,
  EyeOff,
  Folder,
  Globe,
  Info,
  MessagesSquare,
  Settings,
  Users,
  Laptop,
} from 'lucide-react';
import { isBmadAsset, type Config } from '@aiportal/shared';
import { api } from '../../api/client';
import { copyText } from '../../lib/compat';
import { getLocalPortal, pingLocalPortal, setLocalPortal } from '../../api/federation';
import { useCatalog } from '../../stores/catalogStore';
import { useCollab } from '../../stores/collabStore';
import { useUi } from '../../stores/uiStore';
import { AgentIcon } from '../common/AgentIcon';
import { PageShell } from './PageShell';
import { MULTIPLAYER_UI } from '../../lib/features';

/**
 * Configurações como página (não mais modal): navegação lateral por seção e
 * cada tema num cartão com explicação curta. Convidado (modo colaboração) só
 * vê o que é dele — o resto configura a MÁQUINA DO HOST.
 */

const ADDRESS_KEY = 'aiportal.collabAddress';

type SectionId = 'collab' | 'chat' | 'agents' | 'projects' | 'network' | 'about';

const SECTIONS: Array<{ id: SectionId; label: string; icon: ReactNode; hostOnly?: boolean }> = [
  { id: 'collab', label: 'Colaboração', icon: <Users className="icon" aria-hidden />, hostOnly: true },
  { id: 'chat', label: 'Chat', icon: <MessagesSquare className="icon" aria-hidden /> },
  { id: 'agents', label: 'Agentes BMAD', icon: <Bot className="icon" aria-hidden />, hostOnly: true },
  { id: 'projects', label: 'Projetos e bibliotecas', icon: <Folder className="icon" aria-hidden />, hostOnly: true },
  { id: 'network', label: 'Rede corporativa', icon: <Globe className="icon" aria-hidden />, hostOnly: true },
  { id: 'about', label: 'Conta e status', icon: <Info className="icon" aria-hidden /> },
];

/** Troca a senha de URLs tipo http://usuario:senha@proxy:8080 por •••• na exibição. */
const maskProxyPassword = (url: string) =>
  url.replace(/^((?:[a-z][\w+.-]*:\/\/)?[^:@/\s]+:)[^@\s]+@/i, '$1••••••@');

/**
 * Input de proxy que não expõe a senha embutida na URL: mostra mascarado (e
 * somente leitura) até o usuário clicar no olhinho para ver e editar.
 */
function ProxyInput(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  style?: CSSProperties;
}) {
  const [show, setShow] = useState(false);
  const masked = maskProxyPassword(props.value);
  const hasSecret = masked !== props.value;
  const hidden = hasSecret && !show;
  return (
    <div className="secret-input" style={props.style}>
      <input
        value={hidden ? masked : props.value}
        readOnly={hidden}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        title={hidden ? 'A senha está oculta — clique no olho para ver e editar' : undefined}
      />
      {hasSecret && (
        <button
          type="button"
          className="secret-input__eye"
          onClick={() => setShow(!show)}
          title={show ? 'Ocultar a senha' : 'Mostrar a senha'}
        >
          {show ? <EyeOff className="icon icon--sm" aria-hidden /> : <Eye className="icon icon--sm" aria-hidden />}
        </button>
      )}
    </div>
  );
}

/** Cartão de uma seção: ícone, título, explicação e o conteúdo. */
function Section(props: {
  id: SectionId;
  icon: ReactNode;
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={`settings-${props.id}`} className="settings-section" data-section={props.id}>
      <header className="settings-section__head">
        <span className="settings-section__icon">{props.icon}</span>
        <div>
          <h2 className="settings-section__title">{props.title}</h2>
          <p className="settings-section__desc">{props.description}</p>
        </div>
      </header>
      <div className="settings-section__body">{props.children}</div>
    </section>
  );
}

/** Linha "rótulo + explicação à esquerda, controle à direita". */
function SettingRow(props: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-row__text">
        <span className="setting-row__label">{props.label}</span>
        {props.hint && <span className="setting-row__hint">{props.hint}</span>}
      </div>
      <div className="setting-row__control">{props.children}</div>
    </div>
  );
}

function Switch(props: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className={`switch${props.checked ? ' switch--on' : ''}${props.disabled ? ' switch--disabled' : ''}`}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
        aria-label={props.label}
      />
      <span className="switch__track">
        <span className="switch__thumb" />
      </span>
    </label>
  );
}

function LocalPortalRow() {
  const toast = useUi((s) => s.toast);
  const advertiseCapability = useCollab((s) => s.advertiseCapability);
  const canExecute = useCollab((s) => s.canExecute);
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; detail: string }>();
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    const local = getLocalPortal();
    if (local) {
      setUrl(`${local.base}/?token=${local.token}`);
      // já configurado: confirma e anuncia
      void pingLocalPortal().then((r) => {
        setStatus(r);
        advertiseCapability(r.ok);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async () => {
    if (!setLocalPortal(url)) {
      toast('URL inválida — cole a URL completa do comando "Copiar URL do Portal" (com ?token=).', 'error');
      return;
    }
    if (!url.trim()) {
      setStatus(undefined);
      advertiseCapability(false);
      toast('Portal local desconectado.', 'ok');
      return;
    }
    setTesting(true);
    const r = await pingLocalPortal();
    setStatus(r);
    advertiseCapability(r.ok);
    setTesting(false);
    toast(
      r.ok
        ? 'Portal local conectado — você já pode executar conversas na sua licença.'
        : `Não deu para conectar: ${r.detail}`,
      r.ok ? 'ok' : 'error',
    );
  };

  return (
    <SettingRow
      label={
        <>
          <Laptop className="icon icon--sm" aria-hidden /> Executar na minha licença (federação)
        </>
      }
      hint={
        <>
          Rode as conversas do squad no SEU Copilot em vez do host. No VS Code, comando{' '}
          <strong>"Copiar URL do Portal"</strong> → cole aqui. Precisa do BMAD Studio rodando na sua máquina.
          {status && (
            <>
              {' '}
              <span style={{ color: status.ok ? 'var(--ok)' : 'var(--danger)' }}>
                {status.ok ? '✓ ' : '✕ '}
                {status.detail}
              </span>
            </>
          )}
        </>
      }
    >
      <div className="setting-row__stack">
        <input
          className="setting-row__input setting-row__input--wide"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://127.0.0.1:4717/?token=…"
          aria-label="URL do meu portal local"
        />
        <button className="btn" disabled={testing} onClick={() => void connect()}>
          {testing ? 'Testando…' : url.trim() ? (canExecute ? 'Reconectar' : 'Conectar') : 'Desconectar'}
        </button>
      </div>
    </SettingRow>
  );
}

function CollabSection() {
  const toast = useUi((s) => s.toast);
  const confirm = useUi((s) => s.confirm);
  const status = useCollab((s) => s.status);
  const loadStatus = useCollab((s) => s.loadStatus);
  const [guestName, setGuestName] = useState('');
  const [hostName, setHostName] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string>();
  // endereço pelo qual o squad alcança esta máquina: o IP detectado serve na
  // maioria dos casos, mas VPN/hotspot/DNS interno podem pedir outro — a
  // pessoa digita e o link de convite acompanha (fica salvo neste navegador)
  const [address, setAddress] = useState(() => {
    try {
      return localStorage.getItem(ADDRESS_KEY) ?? '';
    } catch {
      return '';
    }
  });

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const setAddressPersist = (value: string) => {
    setAddress(value);
    try {
      localStorage.setItem(ADDRESS_KEY, value);
    } catch {
      // sem storage: vale só nesta sessão
    }
  };

  const toggle = async (enabling: boolean) => {
    if (!status) return;
    if (enabling) {
      const ok = await confirm({
        title: 'Ligar o modo colaboração?',
        message:
          'O portal passa a aceitar conexões da sua rede local (quem tiver um link de convite entra direto no navegador, sem instalar nada). O servidor religa agora — uma resposta em geração é interrompida.',
        confirmLabel: 'Ligar',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await api.patchCollab({ enabled: enabling });
      toast(
        enabling
          ? 'Modo colaboração ligado — o servidor está religando…'
          : 'Modo colaboração desligado — o servidor está religando…',
        'ok',
      );
      // o servidor cai e volta em ~1s; recarrega o status quando voltar
      setTimeout(() => void loadStatus(), 2500);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveHostName = async () => {
    if (!status || hostName === undefined || hostName.trim() === status.hostName) return;
    try {
      await api.patchCollab({ hostName: hostName.trim() });
      await loadStatus();
      toast('Seu nome nas sessões compartilhadas foi salvo.', 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const invite = async () => {
    const name = guestName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await api.addCollabGuest(name);
      setGuestName('');
      await loadStatus();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const copyLink = (id: string, url: string) => {
    void copyText(url).then(
      () => {
        setCopiedId(id);
        setTimeout(() => setCopiedId(undefined), 2000);
      },
      () => toast('Não foi possível copiar o link.', 'error'),
    );
  };

  const revoke = async (id: string, name: string, purge: boolean) => {
    const ok = await confirm({
      title: purge ? 'Excluir convite' : 'Revogar convite',
      message: purge
        ? `Excluir de vez o convite de ${name}?`
        : `Revogar o acesso de ${name}? O link deixa de funcionar na hora.`,
      confirmLabel: purge ? 'Excluir' : 'Revogar',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.revokeCollabGuest(id, purge);
      await loadStatus();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const activeGuests = status?.guests.filter((g) => !g.revoked) ?? [];
  const revokedGuests = status?.guests.filter((g) => g.revoked) ?? [];
  const suggestions = [...(status?.lanUrls ?? []), ...(status?.mdnsUrl ? [status.mdnsUrl] : [])];
  const baseUrl = (address.trim() || suggestions[0] || '').replace(/\/+$/, '');
  const joinUrl = (token: string) => (baseUrl ? `${baseUrl}/?token=${token}` : '');

  return (
    <Section
      id="collab"
      icon={<Users className="icon" aria-hidden />}
      title="Colaboração (multiplayer)"
      description="Trabalhe com o squad na mesma sessão: quem tiver um link de convite abre este portal no navegador pela rede local — chat, aprovações e quadro em tempo real. A IA continua rodando só aqui, na sua licença."
    >
      {!status ? (
        <p className="settings-muted">Carregando…</p>
      ) : (
        <>
          <SettingRow
            label="Aceitar convidados pela rede local"
            hint={
              status.enabled
                ? status.lanUrls.length
                  ? `Portal na rede: ${status.lanUrls.join(' · ')}`
                  : 'Ligado, mas nenhum endereço de rede local foi detectado (sem Wi-Fi/cabo?).'
                : 'Desligado: o portal só responde nesta máquina (127.0.0.1).'
            }
          >
            <Switch checked={status.enabled} disabled={busy} onChange={(v) => void toggle(v)} label="Modo colaboração" />
          </SettingRow>

          {status.enabled && (
            <>
              <SettingRow label="Seu nome para o squad" hint="Aparece nas mensagens, na presença e no quadro.">
                <input
                  className="setting-row__input"
                  value={hostName ?? status.hostName}
                  onChange={(e) => setHostName(e.target.value)}
                  onBlur={() => void saveHostName()}
                  placeholder="Seu nome"
                  aria-label="Seu nome nas sessões compartilhadas"
                />
              </SettingRow>

              <SettingRow
                label="Endereço que os convidados usam"
                hint={
                  suggestions.length
                    ? 'Detectado automaticamente; se o squad chega por VPN ou outro nome, digite o endereço aqui — os links abaixo acompanham.'
                    : 'Nenhum endereço de rede detectado (Wi-Fi desligado? só VPN?). Digite o IP ou nome pelo qual as pessoas alcançam esta máquina, com a porta.'
                }
              >
                <div className="setting-row__stack">
                  <input
                    className="setting-row__input setting-row__input--wide"
                    value={address}
                    onChange={(e) => setAddressPersist(e.target.value)}
                    placeholder={suggestions[0] ?? `http://IP-da-maquina:${status.port}`}
                    aria-label="Endereço do portal para os convidados"
                  />
                  {suggestions.length > 0 && (
                    <div className="chip-list">
                      {suggestions.map((url) => (
                        <button
                          key={url}
                          className={`btn btn--sm${baseUrl === url ? ' btn--primary' : ' btn--ghost'}`}
                          title="Usar este endereço nos links de convite"
                          onClick={() => setAddressPersist(url)}
                        >
                          {url}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </SettingRow>

              <div className="settings-subhead">
                Convites
                <span className="settings-subhead__hint">
                  Cada pessoa recebe um link individual, já autenticado — copie e mande por onde preferir. Revogar corta o acesso na hora.
                </span>
              </div>
              <div className="collab-invite">
                <input
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void invite();
                  }}
                  placeholder="Nome de quem você quer convidar"
                  aria-label="Nome do convidado"
                />
                <button className="btn btn--primary" disabled={busy || !guestName.trim()} onClick={() => void invite()}>
                  Convidar
                </button>
              </div>
              {activeGuests.length === 0 && (
                <p className="settings-muted">Nenhum convite ainda — convide alguém acima e mande o link.</p>
              )}
              {activeGuests.map((guest) => (
                <div key={guest.id} className="collab-guest">
                  <span className={`collab-dot${guest.online ? ' collab-dot--online' : ''}`} style={{ background: guest.color }} />
                  <span className="collab-guest__name">
                    {guest.name}
                    <span className="collab-guest__state">{guest.online ? 'online agora' : 'offline'}</span>
                  </span>
                  {joinUrl(guest.token) ? (
                    <>
                      <code className="collab-guest__link" title={joinUrl(guest.token)}>
                        {joinUrl(guest.token)}
                      </code>
                      <button
                        className="btn btn--sm btn--primary"
                        onClick={() => copyLink(guest.id, joinUrl(guest.token))}
                        title="Copiar o link de convite"
                      >
                        {copiedId === guest.id ? (
                          <>
                            <Check className="icon icon--sm" aria-hidden /> copiado
                          </>
                        ) : (
                          <>
                            <Copy className="icon icon--sm" aria-hidden /> copiar link
                          </>
                        )}
                      </button>
                    </>
                  ) : (
                    <span className="collab-guest__state">informe o endereço acima para gerar o link</span>
                  )}
                  <button className="btn btn--sm btn--ghost" onClick={() => void revoke(guest.id, guest.name, false)}>
                    Revogar
                  </button>
                </div>
              ))}
              {revokedGuests.map((guest) => (
                <div key={guest.id} className="collab-guest collab-guest--revoked">
                  <span className="collab-dot" style={{ background: guest.color }} />
                  <span className="collab-guest__name">
                    {guest.name}
                    <span className="collab-guest__state">revogado</span>
                  </span>
                  <button className="btn btn--sm btn--ghost" onClick={() => void revoke(guest.id, guest.name, true)}>
                    Excluir
                  </button>
                </div>
              ))}

              {status.online.length > 0 && (
                <p className="settings-muted">
                  Conectados agora:{' '}
                  {status.online.map((p) => `${p.name}${p.role === 'host' ? ' (host)' : ''}`).join(', ')}
                </p>
              )}
            </>
          )}
        </>
      )}
    </Section>
  );
}

export function SettingsPage() {
  const health = useCatalog((s) => s.health);
  const me = useCatalog((s) => s.me);
  const agents = useCatalog((s) => s.agents);
  const loadAgents = useCatalog((s) => s.loadAgents);
  const libraries = useCatalog((s) => s.libraries);
  const loadLibraries = useCatalog((s) => s.loadLibraries);
  const toast = useUi((s) => s.toast);
  const hideToolCards = useUi((s) => s.hideToolCards);
  const setHideToolCards = useUi((s) => s.setHideToolCards);
  const identity = useCollab((s) => s.identity);
  const isGuest = identity?.role === 'guest';

  const [config, setConfig] = useState<Omit<Config, 'token'>>();
  const [projectsRoot, setProjectsRoot] = useState('');
  const [httpsProxy, setHttpsProxy] = useState('');
  const [httpProxy, setHttpProxy] = useState('');
  const [noProxy, setNoProxy] = useState('');
  const [extraCaCerts, setExtraCaCerts] = useState('');
  const [savingNet, setSavingNet] = useState(false);
  const [savingLibs, setSavingLibs] = useState(false);
  const [active, setActive] = useState<SectionId>(isGuest || !MULTIPLAYER_UI ? 'chat' : 'collab');
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isGuest) return;
    void api
      .getConfig()
      .then((c) => {
        setConfig(c);
        setProjectsRoot(c.projectsRoot);
        setHttpsProxy(c.network?.httpsProxy ?? '');
        setHttpProxy(c.network?.httpProxy ?? '');
        setNoProxy(c.network?.noProxy ?? '');
        setExtraCaCerts(c.network?.extraCaCerts ?? '');
      })
      .catch(() => undefined);
  }, [isGuest]);

  // a seção mais visível vira a ativa na navegação lateral
  useEffect(() => {
    const root = contentRef.current?.closest('.page__body');
    const sections = contentRef.current?.querySelectorAll<HTMLElement>('[data-section]');
    if (!root || !sections?.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const best = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        const id = best?.target.getAttribute('data-section') as SectionId | undefined;
        if (id) setActive(id);
      },
      { root, threshold: [0.2, 0.5, 0.8] },
    );
    sections.forEach((s) => observer.observe(s));
    return () => observer.disconnect();
  }, [isGuest]);

  const jumpTo = (id: SectionId) => {
    setActive(id);
    document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const saveProjectsRoot = async () => {
    if (!projectsRoot.trim() || projectsRoot === config?.projectsRoot) return;
    try {
      const updated = await api.patchConfig({ projectsRoot: projectsRoot.trim() });
      setConfig(updated);
      toast('Pasta de projetos atualizada.', 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const bmadAgents = agents.filter((a) => isBmadAsset(a.id));
  const toggleBmadAgent = async (id: string, enabled: boolean) => {
    try {
      await api.patchAgent(id, { enabled });
      await loadAgents();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  /**
   * Bibliotecas compartilhadas: a lista inteira vai num PUT só. Sem "salvar"
   * separado — adicionar/remover já grava, que é o que a pessoa espera de uma
   * lista de pastas.
   */
  const persistLibraries = async (next: Array<{ id?: string; name: string; path: string }>) => {
    setSavingLibs(true);
    try {
      await api.saveSharedLibraries(next);
      await loadLibraries();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSavingLibs(false);
    }
  };

  const addLibrary = async () => {
    try {
      const picked = await api.pickSharedLibraryFolder();
      if (!picked.ok || !picked.path) return;
      if (libraries.some((lib) => lib.path === picked.path)) {
        toast('Esta pasta já está na lista.', 'info');
        return;
      }
      await persistLibraries([
        ...libraries.map((lib) => ({ id: lib.id, name: lib.name, path: lib.path })),
        { name: '', path: picked.path },
      ]);
      toast('Biblioteca compartilhada adicionada.', 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const removeLibrary = async (id: string) => {
    await persistLibraries(
      libraries.filter((lib) => lib.id !== id).map((lib) => ({ id: lib.id, name: lib.name, path: lib.path })),
    );
    toast('Biblioteca removida da lista (a pasta e o conteúdo dela ficam intactos).', 'ok');
  };

  const renameLibrary = async (id: string, name: string) => {
    await persistLibraries(
      libraries.map((lib) => ({ id: lib.id, name: lib.id === id ? name : lib.name, path: lib.path })),
    );
  };

  const saveNetwork = async () => {
    setSavingNet(true);
    try {
      const updated = await api.patchConfig({
        network: {
          httpsProxy: httpsProxy.trim() || undefined,
          httpProxy: httpProxy.trim() || undefined,
          noProxy: noProxy.trim() || undefined,
          extraCaCerts: extraCaCerts.trim() || undefined,
        },
      });
      setConfig(updated);
      // o servidor pode preencher o HTTP_PROXY a partir do HTTPS_PROXY
      setHttpsProxy(updated.network?.httpsProxy ?? '');
      setHttpProxy(updated.network?.httpProxy ?? '');
      toast('Rede salva e reaplicada nos arquivos da máquina (VS Code, .bashrc/.zshrc, ~/.npmrc).', 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSavingNet(false);
    }
  };

  const removeAllowlisted = (bin: string) =>
    void api
      .patchConfig({ commandAllowlist: (config?.commandAllowlist ?? []).filter((b) => b !== bin) })
      .then((updated) => {
        setConfig(updated);
        toast(`"${bin}" voltará a pedir aprovação.`, 'ok');
      })
      .catch((err) => toast((err as Error).message, 'error'));

  const sections = SECTIONS.filter((s) => !isGuest || !s.hostOnly).filter(
    (s) => MULTIPLAYER_UI || s.id !== 'collab',
  );
  const subtitle = isGuest
    ? `Convidado como ${identity?.name} · Portal v${health?.version ?? '?'}`
    : `Portal v${health?.version ?? '?'} · ${me ? `${me.login} (GitHub via VS Code)` : 'conta não conectada'}`;

  return (
    <PageShell icon={<Settings className="icon icon--lg" aria-hidden />} title="Configurações" subtitle={subtitle}>
      <div className="settings">
        <nav className="settings__nav" aria-label="Seções">
          {sections.map((s) => (
            <button
              key={s.id}
              className={`settings__nav-item${active === s.id ? ' settings__nav-item--active' : ''}`}
              onClick={() => jumpTo(s.id)}
            >
              {s.icon} {s.label}
            </button>
          ))}
        </nav>

        <div className="settings__content" ref={contentRef}>
          {!isGuest && MULTIPLAYER_UI && <CollabSection />}

          <Section
            id="chat"
            icon={<MessagesSquare className="icon" aria-hidden />}
            title="Chat"
            description="Como as respostas aparecem para você nesta máquina/navegador."
          >
            <SettingRow
              label="Ocultar detalhes técnicos das respostas"
              hint="Os cards tipo portal_write_file somem do chat. Pedidos de aprovação de comandos continuam aparecendo sempre."
            >
              <Switch checked={hideToolCards} onChange={setHideToolCards} label="Ocultar cards técnicos" />
            </SettingRow>
            {MULTIPLAYER_UI && <LocalPortalRow />}
            {!isGuest && (
              <SettingRow
                label="Comandos sempre permitidos"
                hint={
                  config?.commandAllowlist?.length
                    ? 'Executáveis liberados pelo "Sempre permitir" — rodam sem pedir aprovação. Clique para voltar a pedir.'
                    : 'Nenhum executável liberado. Use "Sempre permitir" num pedido de aprovação do chat para liberar um.'
                }
              >
                <div className="chip-list">
                  {config?.commandAllowlist?.map((bin) => (
                    <button
                      key={bin}
                      className="btn btn--sm btn--ghost"
                      title={`Voltar a pedir aprovação para "${bin}"`}
                      onClick={() => removeAllowlisted(bin)}
                    >
                      {bin} ✕
                    </button>
                  ))}
                </div>
              </SettingRow>
            )}
          </Section>

          {!isGuest && (
            <Section
              id="agents"
              icon={<Bot className="icon" aria-hidden />}
              title="Agentes BMAD"
              description="Personas do método BMAD registradas como agentes. Os desmarcados somem dos seletores do chat, mas continuam aqui para religar quando precisar."
            >
              {bmadAgents.length === 0 ? (
                <p className="settings-muted">
                  O BMAD ainda não está instalado — instale pela tela de um projeto para as personas aparecerem aqui.
                </p>
              ) : (
                <div className="settings-grid">
                  {bmadAgents.map((agent) => (
                    <label key={agent.id} className="settings-toggle-card">
                      <input
                        type="checkbox"
                        checked={agent.enabled !== false}
                        onChange={(e) => void toggleBmadAgent(agent.id, e.target.checked)}
                      />
                      <AgentIcon icon={agent.icon} />
                      <span className="settings-toggle-card__text">
                        <span className="settings-toggle-card__name">{agent.name}</span>
                        {agent.description && (
                          <span className="settings-toggle-card__desc">{agent.description}</span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </Section>
          )}

          {!isGuest && (
            <Section
              id="projects"
              icon={<Folder className="icon" aria-hidden />}
              title="Projetos e bibliotecas"
              description="Onde os projetos vivem no disco e as pastas de rede de onde a equipe compartilha skills, agentes e bases."
            >
              <SettingRow
                label="Pasta raiz dos projetos"
                hint="Cada projeto ganha uma subpasta aqui; o assistente grava arquivos direto nela."
              >
                <div className="setting-row__inline">
                  <input
                    className="setting-row__input setting-row__input--wide"
                    value={projectsRoot}
                    onChange={(e) => setProjectsRoot(e.target.value)}
                    aria-label="Pasta raiz dos projetos"
                  />
                  <button className="btn" disabled={projectsRoot === config?.projectsRoot} onClick={() => void saveProjectsRoot()}>
                    Salvar
                  </button>
                </div>
              </SettingRow>

              <div className="settings-subhead">
                Bibliotecas compartilhadas
                <span className="settings-subhead__hint">
                  O que está numa pasta compartilhada aparece para todo mundo que aponta para ela — e quem edita, edita para todos.
                </span>
              </div>
              {libraries.length === 0 && (
                <p className="settings-muted">Nenhuma pasta compartilhada configurada.</p>
              )}
              {libraries.map((lib) => (
                <div key={lib.id} className="shared-lib">
                  <div className="shared-lib__row">
                    <input
                      value={lib.name}
                      onChange={(e) => void renameLibrary(lib.id, e.target.value)}
                      placeholder="Nome da biblioteca"
                      aria-label="Nome da biblioteca"
                    />
                    <button
                      className="btn btn--sm btn--ghost"
                      disabled={savingLibs}
                      title="Remover da lista (a pasta continua no lugar)"
                      onClick={() => void removeLibrary(lib.id)}
                    >
                      Remover
                    </button>
                  </div>
                  <span className="shared-lib__path" title={lib.path}>
                    {lib.path}
                  </span>
                  <span className={`shared-lib__status${lib.available ? '' : ' shared-lib__status--off'}`}>
                    {lib.available
                      ? `${lib.counts?.skills ?? 0} skill(s) · ${lib.counts?.agents ?? 0} agente(s) · ` +
                        `${lib.counts?.knowledgeBases ?? 0} base(s)` +
                        (lib.writable ? '' : ' · somente leitura')
                      : `indisponível agora — ${lib.error ?? 'a pasta não respondeu'}`}
                  </span>
                </div>
              ))}
              <button className="btn" style={{ alignSelf: 'flex-start' }} disabled={savingLibs} onClick={() => void addLibrary()}>
                Adicionar pasta compartilhada…
              </button>
            </Section>
          )}

          {!isGuest && (
            <Section
              id="network"
              icon={<Globe className="icon" aria-hidden />}
              title="Rede corporativa (proxy)"
              description="Os proxies são preenchidos pelo login (RACF + senha). Alterar aqui regrava os mesmos arquivos do login — settings.json do VS Code, .bashrc/.zshrc e o cafile do ~/.npmrc — e vale também para as conexões dos servidores MCP."
            >
              <div className="settings-form">
                <label className="settings-form__label">HTTPS_PROXY</label>
                <ProxyInput value={httpsProxy} onChange={setHttpsProxy} placeholder="ex: http://usuario:senha@proxy.empresa:8080" />
                <label className="settings-form__label">HTTP_PROXY</label>
                <ProxyInput value={httpProxy} onChange={setHttpProxy} placeholder="vazio usa o mesmo valor do HTTPS_PROXY" />
                <label className="settings-form__label">NO_PROXY</label>
                <input value={noProxy} onChange={(e) => setNoProxy(e.target.value)} placeholder="hosts sem proxy, separados por vírgula (opcional)" />
                <label className="settings-form__label">CA interna</label>
                <input value={extraCaCerts} onChange={(e) => setExtraCaCerts(e.target.value)} placeholder="caminho do PEM (vira o cafile do ~/.npmrc)" />
                <div>
                  <button className="btn btn--primary" disabled={savingNet} onClick={() => void saveNetwork()}>
                    {savingNet ? 'Salvando…' : 'Salvar rede'}
                  </button>
                </div>
              </div>
            </Section>
          )}

          <Section
            id="about"
            icon={<Info className="icon" aria-hidden />}
            title="Conta e status"
            description="Quem você é para o portal e a saúde da instalação."
          >
            <SettingRow label={isGuest ? 'Você' : 'Conta'}>
              <span className="settings-value">
                {isGuest ? (
                  <>
                    <span className="collab-dot" style={{ background: identity?.color }} /> {identity?.name} · convidado
                  </>
                ) : me ? (
                  `${me.login} (GitHub via VS Code)`
                ) : (
                  'não conectada'
                )}
              </span>
            </SettingRow>
            <SettingRow label="Portal" hint="A interface conversa com uma extensão do VS Code que faz proxy dos modelos e MCPs do Copilot. Fechar o VS Code derruba o portal.">
              <span className="settings-value">
                v{health?.version ?? '?'} · {health?.modelCount ?? 0} modelos do Copilot
                {health?.needsConsent ? ' · aguardando autorização no VS Code' : ''}
              </span>
            </SettingRow>
            {health?.needsConsent && (
              <SettingRow label="Autorização do Copilot" hint="Na primeira mensagem o VS Code pede autorização para a extensão usar o Copilot.">
                <button
                  className="btn btn--primary"
                  onClick={() =>
                    void api.warmup().then(() => toast('Confirme a autorização na janela do VS Code.', 'info'))
                  }
                >
                  Autorizar no VS Code
                </button>
              </SettingRow>
            )}
            <p className="settings-muted">Desenvolvido por Matheus Llobregat.</p>
          </Section>
        </div>
      </div>
    </PageShell>
  );
}

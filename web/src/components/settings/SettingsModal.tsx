import { useEffect, useState, type CSSProperties } from 'react';
import { Check, Copy, Eye, EyeOff, Users } from 'lucide-react';
import { isBmadAsset, type Config } from '@aiportal/shared';
import { api } from '../../api/client';
import { useCatalog } from '../../stores/catalogStore';
import { useCollab } from '../../stores/collabStore';
import { useUi } from '../../stores/uiStore';
import { AgentIcon } from '../common/AgentIcon';
import { Modal } from '../common/Modal';
import { copyText } from '../../lib/compat';

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
          {show ? (
            <EyeOff className="icon icon--sm" aria-hidden />
          ) : (
            <Eye className="icon icon--sm" aria-hidden />
          )}
        </button>
      )}
    </div>
  );
}

/**
 * Modo colaboração (multiplayer): liga o servidor na rede local e gerencia os
 * convites. Só o host vê esta seção — cada convidado entra com um link+token
 * individual e revogável.
 */
function CollabSection() {
  const toast = useUi((s) => s.toast);
  const confirm = useUi((s) => s.confirm);
  const status = useCollab((s) => s.status);
  const loadStatus = useCollab((s) => s.loadStatus);
  const [guestName, setGuestName] = useState('');
  const [hostName, setHostName] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string>();

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  if (!status) return null;

  const toggle = async () => {
    const enabling = !status.enabled;
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
    if (hostName === undefined || hostName.trim() === status.hostName) return;
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

  return (
    <div className="field">
      <label>
        <Users className="icon icon--sm" aria-hidden /> Colaboração (multiplayer)
      </label>
      <span className="field__note">
        Trabalhe com o squad na mesma sessão: com o modo ligado, quem tiver um link de convite
        abre este portal no navegador pela rede local — chat, aprovações e quadro em tempo real.
        A IA continua rodando só aqui, na sua licença.
      </span>
      <label className="check-row">
        <input type="checkbox" checked={status.enabled} disabled={busy} onChange={() => void toggle()} />
        Aceitar convidados pela rede local
      </label>

      {status.enabled && (
        <>
          {status.lanUrls.length > 0 ? (
            <span className="field__hint">
              Portal na rede: {status.lanUrls.join(' · ')} — mande o link de convite (abaixo), que
              já entra autenticado.
            </span>
          ) : (
            <span className="field__hint">
              Nenhum endereço de rede local detectado (sem Wi-Fi/cabo?).
            </span>
          )}

          <input
            style={{ marginTop: 6 }}
            value={hostName ?? status.hostName}
            onChange={(e) => setHostName(e.target.value)}
            onBlur={() => void saveHostName()}
            placeholder="Seu nome nas sessões compartilhadas"
            aria-label="Seu nome nas sessões compartilhadas"
          />

          {status.guests.map((guest) => (
            <div key={guest.id} className="collab-guest">
              <span className="collab-dot" style={{ background: guest.color }} />
              <span className="collab-guest__name">
                {guest.name}
                {guest.revoked ? ' · revogado' : guest.online ? ' · online' : ''}
              </span>
              {!guest.revoked && guest.joinUrls[0] && (
                <button
                  className="btn btn--sm"
                  onClick={() => copyLink(guest.id, guest.joinUrls[0])}
                  title={guest.joinUrls[0]}
                >
                  {copiedId === guest.id ? (
                    <>
                      <Check className="icon icon--sm" aria-hidden /> copiado
                    </>
                  ) : (
                    <>
                      <Copy className="icon icon--sm" aria-hidden /> link de convite
                    </>
                  )}
                </button>
              )}
              <button
                className="btn btn--sm btn--ghost"
                onClick={() => void revoke(guest.id, guest.name, !!guest.revoked)}
              >
                {guest.revoked ? 'Excluir' : 'Revogar'}
              </button>
            </div>
          ))}

          <div className="collab-invite">
            <input
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void invite();
              }}
              placeholder="Nome de quem você quer convidar"
            />
            <button className="btn" disabled={busy || !guestName.trim()} onClick={() => void invite()}>
              Convidar
            </button>
          </div>

          {status.online.length > 0 && (
            <span className="field__hint">
              Online agora:{' '}
              {status.online
                .map((p) => `${p.name}${p.role === 'host' ? ' (host)' : ''}`)
                .join(', ')}
            </span>
          )}
        </>
      )}
    </div>
  );
}

export function SettingsModal() {
  const health = useCatalog((s) => s.health);
  const me = useCatalog((s) => s.me);
  const agents = useCatalog((s) => s.agents);
  const loadAgents = useCatalog((s) => s.loadAgents);
  const toast = useUi((s) => s.toast);
  const hideToolCards = useUi((s) => s.hideToolCards);
  const setHideToolCards = useUi((s) => s.setHideToolCards);
  const [config, setConfig] = useState<Omit<Config, 'token'>>();
  const [projectsRoot, setProjectsRoot] = useState('');
  const [httpsProxy, setHttpsProxy] = useState('');
  const [httpProxy, setHttpProxy] = useState('');
  const [noProxy, setNoProxy] = useState('');
  const [extraCaCerts, setExtraCaCerts] = useState('');
  const [savingNet, setSavingNet] = useState(false);
  const libraries = useCatalog((s) => s.libraries);
  const loadLibraries = useCatalog((s) => s.loadLibraries);
  const [savingLibs, setSavingLibs] = useState(false);
  // convidado (modo colaboração): a config é da MÁQUINA DO HOST — nem busca
  const isGuest = useCollab((s) => s.identity?.role === 'guest');

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

  const save = async () => {
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
      libraries
        .filter((lib) => lib.id !== id)
        .map((lib) => ({ id: lib.id, name: lib.name, path: lib.path })),
    );
    toast('Biblioteca removida da lista (a pasta e o conteúdo dela ficam intactos).', 'ok');
  };

  const renameLibrary = async (id: string, name: string) => {
    await persistLibraries(
      libraries.map((lib) => ({
        id: lib.id,
        name: lib.id === id ? name : lib.name,
        path: lib.path,
      })),
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
      toast(
        'Rede salva e reaplicada nos arquivos da máquina (VS Code, .bashrc/.zshrc, ~/.npmrc).',
        'ok',
      );
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSavingNet(false);
    }
  };

  return (
    <Modal title="Configurações">
      {!isGuest && (
        <div className="field">
          <label>Pasta raiz dos projetos</label>
          <input value={projectsRoot} onChange={(e) => setProjectsRoot(e.target.value)} />
          <button className="btn" style={{ alignSelf: 'flex-start', marginTop: 6 }} onClick={() => void save()}>
            Salvar
          </button>
        </div>
      )}

      {!isGuest && <CollabSection />}

      <div className="field">
        <label>Chat</label>
        <label
          className="check-row"
        >
          <input
            type="checkbox"
            checked={hideToolCards}
            onChange={(e) => setHideToolCards(e.target.checked)}
          />
          Ocultar detalhes técnicos das respostas (chamadas de ferramentas)
        </label>
        <span className="field__hint">
          Os cards tipo portal_write_file somem do chat. Pedidos de aprovação de comandos continuam
          aparecendo sempre.
        </span>
      </div>

      {!isGuest && bmadAgents.length > 0 && (
        <div className="field">
          <label>Agentes BMAD</label>
          <span className="field__note">
            Os agentes desmarcados somem dos seletores do chat. Habilite aqui quando precisar
            deles.
          </span>
          {bmadAgents.map((agent) => (
            <label
              key={agent.id}
              className="check-row"
            >
              <input
                type="checkbox"
                checked={agent.enabled !== false}
                onChange={(e) => void toggleBmadAgent(agent.id, e.target.checked)}
              />
              <AgentIcon icon={agent.icon} /> {agent.name}
            </label>
          ))}
        </div>
      )}

      {!isGuest && (
      <div className="field">
        <label>Bibliotecas compartilhadas</label>
        <span className="field__note">
          Pastas de rede (ou sincronizadas) com skills, agentes e bases da equipe. O que está lá
          aparece para todo mundo que aponta para a mesma pasta — e quem edita, edita para todos.
        </span>
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
        <button
          className="btn"
          style={{ alignSelf: 'flex-start', marginTop: 6 }}
          disabled={savingLibs}
          onClick={() => void addLibrary()}
        >
          Adicionar pasta compartilhada…
        </button>
      </div>
      )}

      {!isGuest && (config?.commandAllowlist?.length ?? 0) > 0 && (
        <div className="field">
          <label>Comandos sempre permitidos</label>
          <span className="field__note">
            Executáveis liberados pelo "Sempre permitir" — rodam sem pedir aprovação no chat.
            Clique para remover.
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {config?.commandAllowlist?.map((bin) => (
              <button
                key={bin}
                className="btn btn--sm btn--ghost"
                title={`Voltar a pedir aprovação para "${bin}"`}
                onClick={() =>
                  void api
                    .patchConfig({
                      commandAllowlist: (config?.commandAllowlist ?? []).filter((b) => b !== bin),
                    })
                    .then((updated) => {
                      setConfig(updated);
                      toast(`"${bin}" voltará a pedir aprovação.`, 'ok');
                    })
                    .catch((err) => toast((err as Error).message, 'error'))
                }
              >
                {bin} ✕
              </button>
            ))}
          </div>
        </div>
      )}

      {!isGuest && (
      <div className="field">
        <label>Rede corporativa (proxy)</label>
        <span className="field__note">
          Os proxies são preenchidos pelo login (RACF + senha). Alterar aqui regrava os mesmos
          arquivos do login: settings.json do VS Code, .bashrc/.zshrc e o cafile do ~/.npmrc.
          Também vale para as conexões dos servidores MCP.
        </span>
        <ProxyInput
          value={httpsProxy}
          onChange={setHttpsProxy}
          placeholder="HTTPS_PROXY — ex: http://usuario:senha@proxy.empresa:8080"
        />
        <ProxyInput
          style={{ marginTop: 6 }}
          value={httpProxy}
          onChange={setHttpProxy}
          placeholder="HTTP_PROXY — vazio usa o mesmo valor do HTTPS_PROXY"
        />
        <input
          style={{ marginTop: 6 }}
          value={noProxy}
          onChange={(e) => setNoProxy(e.target.value)}
          placeholder="NO_PROXY — hosts sem proxy, separados por vírgula (opcional)"
        />
        <input
          style={{ marginTop: 6 }}
          value={extraCaCerts}
          onChange={(e) => setExtraCaCerts(e.target.value)}
          placeholder="CA interna — caminho do PEM (vira o cafile do ~/.npmrc)"
        />
        <button
          className="btn"
          style={{ alignSelf: 'flex-start', marginTop: 8 }}
          disabled={savingNet}
          onClick={() => void saveNetwork()}
        >
          {savingNet ? 'Salvando…' : 'Salvar rede'}
        </button>
      </div>
      )}

      {!isGuest && (
        <div className="field">
          <label>Conta</label>
          <span>{me ? `${me.login} (GitHub via VS Code)` : 'não conectada'}</span>
        </div>
      )}

      <div className="field">
        <label>Status</label>
        <span className="field__note" style={{ marginBottom: 0 }}>
          Portal v{health?.version ?? '?'} · {health?.modelCount ?? 0} modelos do Copilot
          {health?.needsConsent ? ' · aguardando autorização no VS Code' : ''}
          {' · desenvolvido por Matheus Llobregat'}
        </span>
        {health?.needsConsent && (
          <button
            className="btn btn--primary"
            style={{ alignSelf: 'flex-start', marginTop: 6 }}
            onClick={() =>
              void api
                .warmup()
                .then(() => toast('Confirme a autorização na janela do VS Code.', 'info'))
            }
          >
            Autorizar Copilot no VS Code
          </button>
        )}
      </div>

      <p className="modal__footnote">
        O portal roda 100% local: a interface conversa com uma extensão do VS Code que faz proxy
        dos modelos e MCPs do Copilot. Fechar o VS Code derruba o portal.
      </p>
    </Modal>
  );
}

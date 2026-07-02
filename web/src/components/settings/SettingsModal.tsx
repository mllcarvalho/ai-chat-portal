import { useEffect, useState } from 'react';
import { isBmadAsset, type Config } from '@aiportal/shared';
import { api } from '../../api/client';
import { useCatalog } from '../../stores/catalogStore';
import { useUi } from '../../stores/uiStore';
import { Modal } from '../common/Modal';

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
  const [noProxy, setNoProxy] = useState('');
  const [extraCaCerts, setExtraCaCerts] = useState('');
  const [savingNet, setSavingNet] = useState(false);

  useEffect(() => {
    void api.getConfig().then((c) => {
      setConfig(c);
      setProjectsRoot(c.projectsRoot);
      setHttpsProxy(c.network?.httpsProxy ?? '');
      setNoProxy(c.network?.noProxy ?? '');
      setExtraCaCerts(c.network?.extraCaCerts ?? '');
    });
  }, []);

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

  const saveNetwork = async () => {
    setSavingNet(true);
    try {
      const updated = await api.patchConfig({
        network: {
          httpsProxy: httpsProxy.trim() || undefined,
          noProxy: noProxy.trim() || undefined,
          extraCaCerts: extraCaCerts.trim() || undefined,
        },
      });
      setConfig(updated);
      toast('Rede salva. Religue o servidor MCP (desligar/ligar) para aplicar.', 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSavingNet(false);
    }
  };

  return (
    <Modal title="Configurações">
      <div className="field">
        <label>Pasta raiz dos projetos</label>
        <input value={projectsRoot} onChange={(e) => setProjectsRoot(e.target.value)} />
        <button className="btn" style={{ alignSelf: 'flex-start', marginTop: 6 }} onClick={() => void save()}>
          Salvar
        </button>
      </div>

      <div className="field">
        <label>Chat</label>
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 'normal' }}
        >
          <input
            type="checkbox"
            checked={hideToolCards}
            onChange={(e) => setHideToolCards(e.target.checked)}
          />
          Ocultar detalhes técnicos das respostas (chamadas de ferramentas)
        </label>
        <span style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
          Os cards tipo portal_write_file somem do chat. Pedidos de aprovação de comandos continuam
          aparecendo sempre.
        </span>
      </div>

      {bmadAgents.length > 0 && (
        <div className="field">
          <label>Agentes BMAD</label>
          <span style={{ fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 6 }}>
            Os agentes desmarcados somem dos seletores do chat. Habilite aqui quando precisar
            deles.
          </span>
          {bmadAgents.map((agent) => (
            <label
              key={agent.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                fontWeight: 'normal',
              }}
            >
              <input
                type="checkbox"
                checked={agent.enabled !== false}
                onChange={(e) => void toggleBmadAgent(agent.id, e.target.checked)}
              />
              {agent.icon} {agent.name}
            </label>
          ))}
        </div>
      )}

      <div className="field">
        <label>Rede corporativa (proxies MCP)</label>
        <span style={{ fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 6 }}>
          Use só se a conexão dos servidores MCP "Gateway OAuth2" falhar por timeout em hosts
          internos. Vale para as chamadas de token e gateway dos proxies.
        </span>
        <input
          value={httpsProxy}
          onChange={(e) => setHttpsProxy(e.target.value)}
          placeholder="HTTPS_PROXY — ex: http://proxy.empresa:8080"
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
          placeholder="Caminho do PEM com a CA interna (opcional)"
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

      <div className="field">
        <label>Conta</label>
        <span>{me ? `${me.login} (GitHub via VS Code)` : 'não conectada'}</span>
      </div>

      <div className="field">
        <label>Status</label>
        <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
          Portal v{health?.version ?? '?'} · {health?.modelCount ?? 0} modelos do Copilot
          {health?.needsConsent ? ' · aguardando autorização no VS Code' : ''}
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

      <p style={{ color: 'var(--text-faint)', fontSize: 12.5 }}>
        O portal roda 100% local: a interface conversa com uma extensão do VS Code que faz proxy
        dos modelos e MCPs do Copilot. Fechar o VS Code derruba o portal.
      </p>
    </Modal>
  );
}

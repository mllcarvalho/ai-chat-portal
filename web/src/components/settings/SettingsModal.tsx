import { useEffect, useState } from 'react';
import type { Config } from '@aiportal/shared';
import { api } from '../../api/client';
import { useCatalog } from '../../stores/catalogStore';
import { useUi } from '../../stores/uiStore';
import { Modal } from '../common/Modal';

export function SettingsModal() {
  const health = useCatalog((s) => s.health);
  const me = useCatalog((s) => s.me);
  const toast = useUi((s) => s.toast);
  const hideToolCards = useUi((s) => s.hideToolCards);
  const setHideToolCards = useUi((s) => s.setHideToolCards);
  const [config, setConfig] = useState<Omit<Config, 'token'>>();
  const [projectsRoot, setProjectsRoot] = useState('');

  useEffect(() => {
    void api.getConfig().then((c) => {
      setConfig(c);
      setProjectsRoot(c.projectsRoot);
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

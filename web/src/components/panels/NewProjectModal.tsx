import { useState } from 'react';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';
import { Modal } from '../common/Modal';

export function NewProjectModal() {
  const createProject = useSessions((s) => s.createProject);
  const openProject = useSessions((s) => s.openProject);
  const closePanel = useUi((s) => s.closePanel);
  const toast = useUi((s) => s.toast);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const project = await createProject(name.trim());
      closePanel();
      openProject(project.id);
      toast(`Projeto "${project.name}" criado.`, 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Novo projeto"
      footer={
        <>
          <button className="btn btn--ghost" onClick={closePanel}>
            Cancelar
          </button>
          <button className="btn btn--primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
            Criar projeto
          </button>
        </>
      }
    >
      <div className="field">
        <label>Nome do projeto</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
          placeholder="ex: Análise churn Q3"
        />
      </div>
      <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
        Uma pasta será criada para o projeto — os arquivos gerados pelo assistente ficam nela. As
        conversas e skills do projeto também ficam organizadas ali.
      </p>
    </Modal>
  );
}

import { Folder, Plus } from 'lucide-react';
import { useCatalog } from '../../stores/catalogStore';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';

export function Welcome() {
  const me = useCatalog((s) => s.me);
  const newSession = useSessions((s) => s.newSession);
  const openPanel = useUi((s) => s.openPanel);

  return (
    <div className="welcome">
      <h1>
        Olá{me ? `, ${me.login}` : ''} <em>—</em> vamos trabalhar?
      </h1>
      <p>
        Converse com os modelos do Copilot, use ferramentas MCP e gere arquivos direto nas pastas
        dos seus projetos.
      </p>
      <div className="welcome__actions">
        <button className="btn btn--primary" onClick={() => void newSession(null)}>
          <Plus className="icon" aria-hidden /> Nova conversa
        </button>
        <button className="btn" onClick={() => openPanel({ kind: 'newProject' })}>
          <Folder className="icon" aria-hidden /> Novo projeto
        </button>
      </div>
    </div>
  );
}

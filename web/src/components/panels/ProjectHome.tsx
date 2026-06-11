import { useEffect, useState } from 'react';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';
import { api } from '../../api/client';

export function ProjectHome() {
  const viewProjectId = useSessions((s) => s.viewProjectId);
  const projects = useSessions((s) => s.projects);
  const byProject = useSessions((s) => s.byProject);
  const loadProjects = useSessions((s) => s.loadProjects);
  const newSession = useSessions((s) => s.newSession);
  const selectSession = useSessions((s) => s.selectSession);
  const openProject = useSessions((s) => s.openProject);
  const openPanel = useUi((s) => s.openPanel);
  const setView = useUi((s) => s.setView);
  const toast = useUi((s) => s.toast);

  const project = projects.find((p) => p.id === viewProjectId);
  const sessions = (viewProjectId && byProject[viewProjectId]) || [];
  const [instructions, setInstructions] = useState(project?.instructions ?? '');

  useEffect(() => {
    setInstructions(project?.instructions ?? '');
  }, [project?.id, project?.instructions]);

  if (!project) return null;

  const saveInstructions = async () => {
    if (instructions === (project.instructions ?? '')) return;
    await api.patchProject(project.id, { instructions });
    await loadProjects();
    toast('Instruções do projeto salvas.', 'ok');
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '36px 40px' }}>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.02em', marginTop: 0 }}>
          📁 {project.name}
        </h1>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 24 }}>
          <button className="btn btn--primary" onClick={() => void newSession(project.id)}>
            ＋ Nova conversa no projeto
          </button>
          <button className="btn" onClick={() => openPanel({ kind: 'files' })}>
            📄 Arquivos
          </button>
          <button className="btn" onClick={() => setView('skills')}>
            ⚡ Skills do projeto
          </button>
          <button className="btn" onClick={() => setView('knowledge')}>
            📚 Conhecimento
          </button>
          <button
            className="btn btn--danger"
            onClick={() => {
              if (
                window.confirm(
                  `Remover o projeto "${project.name}" do portal? A pasta e os arquivos permanecem no disco.`,
                )
              ) {
                void api.deleteProject(project.id).then(async () => {
                  openProject(undefined);
                  await loadProjects();
                });
              }
            }}
          >
            Remover projeto
          </button>
        </div>

        <div className="field">
          <label>Instruções do projeto (entram no contexto de todas as conversas dele)</label>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            onBlur={() => void saveInstructions()}
            placeholder="Contexto do projeto, glossário, padrões de entrega…"
          />
        </div>

        <div className="sidebar__section-title" style={{ padding: '12px 0 8px' }}>
          Conversas
        </div>
        {sessions.length === 0 && <div className="empty-state">Nenhuma conversa neste projeto.</div>}
        {sessions.map((session) => (
          <button
            key={session.id}
            className="session-item"
            style={{ padding: '10px 12px' }}
            onClick={() => void selectSession(session.id)}
          >
            <span className="session-item__title">{session.title}</span>
            <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
              {session.messageCount} msgs
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

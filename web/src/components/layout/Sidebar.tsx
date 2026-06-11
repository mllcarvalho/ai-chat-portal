import { useState } from 'react';
import type { SessionSummary } from '@aiportal/shared';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';
import { UserBadge } from './UserBadge';

function SessionItem({ session }: { session: SessionSummary }) {
  const current = useSessions((s) => s.current);
  const selectSession = useSessions((s) => s.selectSession);
  const renameSession = useSessions((s) => s.renameSession);
  const removeSession = useSessions((s) => s.removeSession);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (draft.trim() && draft !== session.title) void renameSession(session.id, draft.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(session.title);
            setEditing(false);
          }
        }}
        style={{ margin: '2px 0', width: '100%' }}
      />
    );
  }

  return (
    <button
      className={`session-item${current?.id === session.id ? ' session-item--active' : ''}`}
      onClick={() => void selectSession(session.id)}
      onDoubleClick={() => {
        setDraft(session.title);
        setEditing(true);
      }}
      title={session.title}
    >
      <span className="session-item__title">{session.title}</span>
      <span
        className="session-item__menu"
        title="Excluir conversa"
        onClick={(e) => {
          e.stopPropagation();
          if (window.confirm(`Excluir a conversa "${session.title}"?`)) {
            void removeSession(session.id);
          }
        }}
      >
        ✕
      </span>
    </button>
  );
}

export function Sidebar() {
  const projects = useSessions((s) => s.projects);
  const standalone = useSessions((s) => s.standalone);
  const byProject = useSessions((s) => s.byProject);
  const expanded = useSessions((s) => s.expandedProjects);
  const toggleProject = useSessions((s) => s.toggleProject);
  const openProject = useSessions((s) => s.openProject);
  const newSession = useSessions((s) => s.newSession);
  const openPanel = useUi((s) => s.openPanel);

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__logo">
          ai<em>·</em>chat<em>·</em>portal
        </span>
      </div>

      <button className="sidebar__new-chat" onClick={() => void newSession(null)}>
        <span>＋</span> Nova conversa
      </button>

      <div className="sidebar__scroll">
        <div className="sidebar__section-title">
          Projetos
          <button
            title="Novo projeto"
            onClick={() => openPanel({ kind: 'newProject' })}
            aria-label="Novo projeto"
          >
            ＋
          </button>
        </div>
        {projects.length === 0 && (
          <div className="empty-state">Nenhum projeto ainda. Crie um para organizar sessões e arquivos.</div>
        )}
        {projects.map((project) => (
          <div key={project.id}>
            <div className="project-item">
              <button
                className={`project-item__chevron${expanded[project.id] ? ' project-item__chevron--open' : ''}`}
                onClick={() => toggleProject(project.id)}
                aria-label="Expandir projeto"
              >
                ▶
              </button>
              <button
                className="project-item__name"
                onClick={() => openProject(project.id)}
                title={project.name}
                style={{ textAlign: 'left' }}
              >
                📁 {project.name}
              </button>
              <button
                className="session-item__menu"
                title="Nova conversa no projeto"
                style={{ opacity: 1 }}
                onClick={() => void newSession(project.id)}
              >
                ＋
              </button>
            </div>
            {expanded[project.id] && (
              <div className="project-children">
                {(byProject[project.id] ?? []).map((session) => (
                  <SessionItem key={session.id} session={session} />
                ))}
                {(byProject[project.id] ?? []).length === 0 && (
                  <div className="empty-state" style={{ padding: '8px' }}>
                    Sem conversas
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        <div className="sidebar__section-title">Conversas</div>
        {standalone.map((session) => (
          <SessionItem key={session.id} session={session} />
        ))}
        {standalone.length === 0 && <div className="empty-state">Nenhuma conversa avulsa.</div>}
      </div>

      <div className="sidebar__footer">
        <button className="sidebar__footer-btn" onClick={() => openPanel({ kind: 'agents' })}>
          🤖 Agentes
        </button>
        <button className="sidebar__footer-btn" onClick={() => openPanel({ kind: 'skills' })}>
          ⚡ Skills
        </button>
        <button className="sidebar__footer-btn" onClick={() => openPanel({ kind: 'tools' })}>
          🔧 Ferramentas &amp; MCPs
        </button>
        <button className="sidebar__footer-btn" onClick={() => openPanel({ kind: 'settings' })}>
          ⚙️ Configurações
        </button>
        <UserBadge />
      </div>
    </aside>
  );
}

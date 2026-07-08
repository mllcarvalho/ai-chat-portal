import { useState } from 'react';
import { Folder, MessagesSquare, Plus } from 'lucide-react';
import { useCatalog } from '../../stores/catalogStore';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';

/**
 * Tela inicial: dois caminhos de entrada. MESA é o espaço aberto (conversa
 * avulsa, sem projeto); PROJETO agrupa conversas e arquivos por projeto.
 */
export function HomeScreen() {
  const me = useCatalog((s) => s.me);
  const projects = useSessions((s) => s.projects);
  const newSession = useSessions((s) => s.newSession);
  const openProject = useSessions((s) => s.openProject);
  const setView = useUi((s) => s.setView);
  const openPanel = useUi((s) => s.openPanel);
  const [choosingProject, setChoosingProject] = useState(false);

  const enterMesa = () => {
    setView('chat');
    void newSession(null);
  };

  const enterProject = (id: string) => {
    setView('chat');
    openProject(id);
  };

  return (
    <div className="welcome home">
      <h1>
        Olá{me ? `, ${me.login}` : ''} <em>—</em> por onde vamos?
      </h1>
      <div className="home__choices">
        <button className="home-card" onClick={enterMesa}>
          <span className="home-card__icon">
            <MessagesSquare className="icon icon--lg" aria-hidden />
          </span>
          <span className="home-card__title">MESA</span>
          <span className="home-card__desc">
            Espaço aberto: pergunte qualquer coisa no chat, sem vínculo com projeto.
          </span>
        </button>
        <button
          className={`home-card${choosingProject ? ' home-card--active' : ''}`}
          onClick={() => {
            if (projects.length === 0) openPanel({ kind: 'newProject' });
            else setChoosingProject((v) => !v);
          }}
        >
          <span className="home-card__icon">
            <Folder className="icon icon--lg" aria-hidden />
          </span>
          <span className="home-card__title">PROJETO</span>
          <span className="home-card__desc">
            Trabalhe dentro de um projeto, com arquivos, instruções e conversas organizadas.
          </span>
        </button>
      </div>
      {choosingProject && (
        <div className="home__projects">
          {projects.map((project) => (
            <button key={project.id} className="home__project-item" onClick={() => enterProject(project.id)}>
              <Folder className="icon" aria-hidden /> {project.name}
            </button>
          ))}
          <button
            className="home__project-item home__project-item--new"
            onClick={() => openPanel({ kind: 'newProject' })}
          >
            <Plus className="icon" aria-hidden /> Novo projeto
          </button>
        </div>
      )}
    </div>
  );
}

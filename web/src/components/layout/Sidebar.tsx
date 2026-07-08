import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BookOpen,
  BookOpenText,
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Folder,
  FolderOpen,
  Plus,
  Settings,
  Stethoscope,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import type { SessionSummary } from '@aiportal/shared';
import { useChat } from '../../stores/chatStore';
import { useSessions } from '../../stores/sessionsStore';
import { useUi, type MainView } from '../../stores/uiStore';
import { UserBadge } from './UserBadge';
import itauLogo from '../../assets/itau-logo.png';

function SessionItem({ session }: { session: SessionSummary }) {
  const current = useSessions((s) => s.current);
  // conversa gerando resposta (inclusive em background) ganha um spinner
  const streaming = useChat((s) => !!s.streams[session.id]);
  const selectSession = useSessions((s) => s.selectSession);
  const setView = useUi((s) => s.setView);
  const renameSession = useSessions((s) => s.renameSession);
  const removeSession = useSessions((s) => s.removeSession);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  // 1º clique no ✕ arma a confirmação inline; o 2º exclui (desarma sozinho)
  const [confirming, setConfirming] = useState(false);
  const confirmTimer = useRef<number>();

  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);

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
      onClick={() => {
        setView('chat');
        void selectSession(session.id);
      }}
      onDoubleClick={() => {
        setDraft(session.title);
        setEditing(true);
      }}
      title={session.title}
    >
      {streaming && <span className="spinner session-item__spinner" title="Gerando resposta…" />}
      <span className="session-item__title">{session.title}</span>
      <span
        className={`session-item__menu${confirming ? ' session-item__menu--confirm' : ''}`}
        title={confirming ? 'Clique de novo para excluir' : 'Excluir conversa'}
        onClick={(e) => {
          e.stopPropagation();
          if (!confirming) {
            setConfirming(true);
            window.clearTimeout(confirmTimer.current);
            confirmTimer.current = window.setTimeout(() => setConfirming(false), 3000);
            return;
          }
          window.clearTimeout(confirmTimer.current);
          void removeSession(session.id);
        }}
      >
        {confirming ? 'Excluir?' : <X className="icon icon--sm" aria-hidden />}
      </span>
    </button>
  );
}

/** Páginas do menu — mesma lista na sidebar expandida e no trilho recolhido. */
const NAV_ITEMS: Array<{ icon: ReactNode; label: string; view: MainView }> = [
  { icon: <Bot className="icon" aria-hidden />, label: 'Agentes', view: 'agents' },
  { icon: <Zap className="icon" aria-hidden />, label: 'Skills', view: 'skills' },
  { icon: <BookOpen className="icon" aria-hidden />, label: 'Conhecimento', view: 'knowledge' },
  { icon: <Wrench className="icon" aria-hidden />, label: 'Servidores MCP', view: 'mcps' },
  { icon: <BookOpenText className="icon" aria-hidden />, label: 'Doc BMAD', view: 'bmadDoc' },
  { icon: <Stethoscope className="icon" aria-hidden />, label: 'Diagnóstico', view: 'diagnostics' },
];

export function Sidebar() {
  const projects = useSessions((s) => s.projects);
  const standalone = useSessions((s) => s.standalone);
  const byProject = useSessions((s) => s.byProject);
  const expanded = useSessions((s) => s.expandedProjects);
  const toggleProject = useSessions((s) => s.toggleProject);
  const openProject = useSessions((s) => s.openProject);
  const newSession = useSessions((s) => s.newSession);
  const openPanel = useUi((s) => s.openPanel);
  const setView = useUi((s) => s.setView);
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const menuCollapsed = useUi((s) => s.menuCollapsed);
  const toggleMenu = useUi((s) => s.toggleMenu);

  if (collapsed) {
    return (
      <aside className="sidebar sidebar--collapsed">
        <img className="sidebar__brand-mark" src={itauLogo} alt="Itaú" title="BMAD Product Studio" />
        <button className="sidebar__rail-btn" title="Expandir menu" onClick={toggleSidebar}>
          <ChevronsRight className="icon" aria-hidden />
        </button>
        <button
          className="sidebar__rail-btn sidebar__rail-btn--accent"
          title="Nova conversa"
          onClick={() => {
            setView('chat');
            void newSession(null);
          }}
        >
          <Plus className="icon" aria-hidden />
        </button>
        <div className="sidebar__rail-spacer" />
        {NAV_ITEMS.map((item) => (
          <button
            key={item.view}
            className="sidebar__rail-btn"
            title={item.label}
            onClick={() => setView(item.view)}
          >
            {item.icon}
          </button>
        ))}
        <button
          className="sidebar__rail-btn"
          title="Configurações"
          onClick={() => openPanel({ kind: 'settings' })}
        >
          <Settings className="icon" aria-hidden />
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <img className="sidebar__brand-mark" src={itauLogo} alt="Itaú" />
        <div className="sidebar__brand-text">
          <span className="sidebar__logo">
            bmad<em>·</em>product<em>·</em>studio
          </span>
          <span className="sidebar__byline">by Matheus Llobregat</span>
        </div>
        <button className="sidebar__collapse" title="Recolher menu" onClick={toggleSidebar}>
          <ChevronsLeft className="icon" aria-hidden />
        </button>
      </div>

      <button
        className="sidebar__new-chat"
        onClick={() => {
          setView('chat');
          void newSession(null);
        }}
      >
        <Plus className="icon" aria-hidden /> Nova conversa
      </button>

      <div className="sidebar__scroll">
        <div className="sidebar__section-title">
          Projetos
          {projects.length > 0 && <span className="sidebar__section-count">{projects.length}</span>}
          <button
            title="Novo projeto"
            onClick={() => openPanel({ kind: 'newProject' })}
            aria-label="Novo projeto"
          >
            <Plus className="icon icon--sm" aria-hidden />
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
                aria-label={expanded[project.id] ? 'Recolher projeto' : 'Expandir projeto'}
              >
                <ChevronRight className="icon icon--sm" aria-hidden />
              </button>
              {/* clicar no nome abre a tela do projeto E alterna a expansão das conversas */}
              <button
                className="project-item__name"
                onClick={() => {
                  setView('chat');
                  toggleProject(project.id);
                  openProject(project.id);
                }}
                title={project.name}
                style={{ textAlign: 'left' }}
              >
                {expanded[project.id] ? (
                  <FolderOpen className="icon" aria-hidden />
                ) : (
                  <Folder className="icon" aria-hidden />
                )}{' '}
                {project.name}
              </button>
              <button
                className="session-item__menu"
                title="Nova conversa no projeto"
                style={{ opacity: 1 }}
                onClick={() => {
                  setView('chat');
                  void newSession(project.id);
                }}
              >
                <Plus className="icon icon--sm" aria-hidden />
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

        <div className="sidebar__section-title">
          Conversas avulsas
          {standalone.length > 0 && (
            <span className="sidebar__section-count">{standalone.length}</span>
          )}
        </div>
        {standalone.map((session) => (
          <SessionItem key={session.id} session={session} />
        ))}
        {standalone.length === 0 && <div className="empty-state">Nenhuma conversa avulsa.</div>}
      </div>

      <div className="sidebar__footer">
        <button
          className="sidebar__footer-toggle"
          onClick={toggleMenu}
          title={menuCollapsed ? 'Mostrar menu' : 'Minimizar menu'}
        >
          Menu
          <span className="sidebar__footer-toggle-chevron">
            {menuCollapsed ? (
              <ChevronRight className="icon icon--sm" aria-hidden />
            ) : (
              <ChevronDown className="icon icon--sm" aria-hidden />
            )}
          </span>
        </button>
        {!menuCollapsed && (
          <>
            {NAV_ITEMS.map((item) => (
              <button
                key={item.view}
                className="sidebar__footer-btn"
                onClick={() => setView(item.view)}
              >
                {item.icon} {item.label}
              </button>
            ))}
            <button className="sidebar__footer-btn" onClick={() => openPanel({ kind: 'settings' })}>
              <Settings className="icon" aria-hidden /> Configurações
            </button>
          </>
        )}
        <UserBadge />
      </div>
    </aside>
  );
}

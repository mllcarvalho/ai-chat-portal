import { useState, type ReactNode } from 'react';
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
  Search,
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
  const confirm = useUi((s) => s.confirm);
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
        className="session-item__menu"
        title="Excluir conversa"
        onClick={(e) => {
          e.stopPropagation();
          void confirm({
            title: 'Excluir conversa',
            message: `Excluir a conversa "${session.title}"? As mensagens dela serão perdidas.`,
            confirmLabel: 'Excluir',
            danger: true,
          }).then((ok) => {
            if (ok) void removeSession(session.id);
          });
        }}
      >
        <X className="icon icon--sm" aria-hidden />
      </span>
    </button>
  );
}

/** Páginas do menu — mesma lista na sidebar expandida e no trilho recolhido.
    As cores dos ícones seguem a paleta dos emojis (AgentIcon/ações BMAD). */
const NAV_ITEMS: Array<{ icon: ReactNode; label: string; view: MainView }> = [
  { icon: <Bot className="icon" aria-hidden style={{ color: '#1d4fa0' }} />, label: 'Agentes', view: 'agents' },
  { icon: <Zap className="icon" aria-hidden style={{ color: '#dd9a00' }} />, label: 'Skills', view: 'skills' },
  { icon: <BookOpen className="icon" aria-hidden style={{ color: '#b45309' }} />, label: 'Conhecimento', view: 'knowledge' },
  { icon: <Wrench className="icon" aria-hidden style={{ color: '#0f766e' }} />, label: 'Servidores MCP', view: 'mcps' },
  { icon: <BookOpenText className="icon" aria-hidden style={{ color: '#c93a2c' }} />, label: 'Doc BMAD', view: 'bmadDoc' },
  { icon: <Stethoscope className="icon" aria-hidden style={{ color: '#178246' }} />, label: 'Diagnóstico', view: 'diagnostics' },
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
  const [query, setQuery] = useState('');

  const totalSessions =
    standalone.length + projects.reduce((acc, p) => acc + (byProject[p.id]?.length ?? 0), 0);
  const needle = query.trim().toLowerCase();
  const matches = (s: SessionSummary) => s.title.toLowerCase().includes(needle);
  // com filtro ativo: só conversas cujo título casa; projetos aparecem se têm
  // conversa que casa (ou se o próprio nome casa) e ficam expandidos à força
  const filteredStandalone = needle ? standalone.filter(matches) : standalone;
  const visibleProjects = needle
    ? projects.filter(
        (p) =>
          p.name.toLowerCase().includes(needle) || (byProject[p.id] ?? []).some(matches),
      )
    : projects;
  const projectSessions = (projectId: string) => {
    const sessions = byProject[projectId] ?? [];
    return needle ? sessions.filter(matches) : sessions;
  };

  if (collapsed) {
    return (
      <aside className="sidebar sidebar--collapsed">
        <img className="sidebar__brand-mark" src={itauLogo} alt="Itaú" title="BMAD Studio" />
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
          <Settings className="icon" aria-hidden style={{ color: '#64748b' }} />
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
            bmad<em>·</em>studio
          </span>
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

      {totalSessions > 8 && (
        <div className="sidebar__search">
          <Search className="icon icon--sm" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filtrar conversas…"
            aria-label="Filtrar conversas por título"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
            }}
          />
          {query && (
            <button title="Limpar filtro" aria-label="Limpar filtro" onClick={() => setQuery('')}>
              <X className="icon icon--sm" aria-hidden />
            </button>
          )}
        </div>
      )}

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
        {needle && projects.length > 0 && visibleProjects.length === 0 && (
          <div className="empty-state">Nenhum projeto com esse nome.</div>
        )}
        {visibleProjects.map((project) => (
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
            {/* filtro ativo força a expansão para mostrar as conversas encontradas */}
            {(expanded[project.id] || !!needle) && (
              <div className="project-children">
                {projectSessions(project.id).map((session) => (
                  <SessionItem key={session.id} session={session} />
                ))}
                {projectSessions(project.id).length === 0 && (
                  <div className="empty-state" style={{ padding: '8px' }}>
                    {needle ? 'Nada encontrado' : 'Sem conversas'}
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
        {filteredStandalone.map((session) => (
          <SessionItem key={session.id} session={session} />
        ))}
        {standalone.length === 0 && <div className="empty-state">Nenhuma conversa avulsa.</div>}
        {needle && standalone.length > 0 && filteredStandalone.length === 0 && (
          <div className="empty-state">Nada encontrado.</div>
        )}
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
              <Settings className="icon" aria-hidden style={{ color: '#64748b' }} /> Configurações
            </button>
          </>
        )}
        <UserBadge />
      </div>
    </aside>
  );
}

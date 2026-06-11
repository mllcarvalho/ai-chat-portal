import { useEffect, useState } from 'react';
import { useCatalog } from './stores/catalogStore';
import { useSessions } from './stores/sessionsStore';
import { useUi } from './stores/uiStore';
import { Sidebar } from './components/layout/Sidebar';
import { ChatView } from './components/chat/ChatView';
import { ProjectHome } from './components/panels/ProjectHome';
import { Welcome } from './components/layout/Welcome';
import { OnboardingScreen } from './components/onboarding/OnboardingScreen';
import { ToolsPanel } from './components/panels/ToolsPanel';
import { SkillsManager } from './components/panels/SkillsManager';
import { AgentsManager } from './components/panels/AgentsManager';
import { ProjectFilesDrawer } from './components/panels/ProjectFilesDrawer';
import { NewProjectModal } from './components/panels/NewProjectModal';
import { SettingsModal } from './components/settings/SettingsModal';
import { Toasts } from './components/common/Toasts';

export function App() {
  const health = useCatalog((s) => s.health);
  const loadHealth = useCatalog((s) => s.loadHealth);
  const loadAll = useCatalog((s) => s.loadAll);
  const loadProjects = useSessions((s) => s.loadProjects);
  const loadSessions = useSessions((s) => s.loadSessions);
  const panel = useUi((s) => s.panel);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    void (async () => {
      const h = await loadHealth();
      if (h?.ok) {
        await Promise.all([loadAll(), loadProjects(), loadSessions(null)]);
      }
      setBooted(true);
    })();
  }, [loadHealth, loadAll, loadProjects, loadSessions]);

  if (!booted) return null;
  if (!health?.ok) return <OnboardingScreen />;

  return (
    <div className="app-shell">
      <Sidebar />
      <MainArea />
      {panel.kind === 'tools' && <ToolsPanel />}
      {panel.kind === 'skills' && <SkillsManager />}
      {panel.kind === 'agents' && <AgentsManager />}
      {panel.kind === 'files' && <ProjectFilesDrawer />}
      {panel.kind === 'newProject' && <NewProjectModal />}
      {panel.kind === 'settings' && <SettingsModal />}
      <Toasts />
    </div>
  );
}

function MainArea() {
  const current = useSessions((s) => s.current);
  const viewProjectId = useSessions((s) => s.viewProjectId);

  return (
    <main className="main-area">
      {current ? <ChatView /> : viewProjectId ? <ProjectHome /> : <Welcome />}
    </main>
  );
}

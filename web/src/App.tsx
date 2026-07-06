import { useEffect, useState } from 'react';
import { useCatalog } from './stores/catalogStore';
import { useSessions } from './stores/sessionsStore';
import { useUi } from './stores/uiStore';
import { Sidebar } from './components/layout/Sidebar';
import { ChatView } from './components/chat/ChatView';
import { ProjectHome } from './components/panels/ProjectHome';
import { Welcome } from './components/layout/Welcome';
import { HomeScreen } from './components/layout/HomeScreen';
import { LoginScreen } from './components/auth/LoginScreen';
import { OnboardingScreen } from './components/onboarding/OnboardingScreen';
import { SkillsPage } from './components/pages/SkillsPage';
import { AgentsPage } from './components/pages/AgentsPage';
import { McpServersPage } from './components/pages/McpServersPage';
import { KnowledgePage } from './components/pages/KnowledgePage';
import { ProjectFilesDrawer } from './components/panels/ProjectFilesDrawer';
import { NewProjectModal } from './components/panels/NewProjectModal';
import { SettingsModal } from './components/settings/SettingsModal';
import { Toasts } from './components/common/Toasts';
import { ConfirmDialog } from './components/common/ConfirmDialog';
import { EnvBanner } from './components/layout/EnvBanner';
import { DiagnosticsBanner } from './components/layout/DiagnosticsBanner';
import { DiagnosticsPage } from './components/pages/DiagnosticsPage';
import { useDiagnostics } from './stores/diagnosticsStore';

export function App() {
  const health = useCatalog((s) => s.health);
  const loadHealth = useCatalog((s) => s.loadHealth);
  const loadAll = useCatalog((s) => s.loadAll);
  const loadProjects = useSessions((s) => s.loadProjects);
  const loadSessions = useSessions((s) => s.loadSessions);
  const panel = useUi((s) => s.panel);
  const loggedIn = useUi((s) => s.loggedIn);
  const startDiagnostics = useDiagnostics((s) => s.start);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    void (async () => {
      const h = await loadHealth();
      if (h?.ok) {
        await Promise.all([loadAll(), loadProjects(), loadSessions(null)]);
        // diagnóstico do ambiente em background — só interrompe se algo falhar
        void startDiagnostics();
      }
      setBooted(true);
    })();
  }, [loadHealth, loadAll, loadProjects, loadSessions, startDiagnostics]);

  if (!booted) return null;
  if (!health?.ok) return <OnboardingScreen />;
  if (!loggedIn) return <LoginScreen />;

  return (
    <div className="app-root">
      <EnvBanner />
      <DiagnosticsBanner />
      <div className="app-shell">
        <Sidebar />
        <MainArea />
        {panel.kind === 'files' && <ProjectFilesDrawer />}
        {panel.kind === 'newProject' && <NewProjectModal />}
        {panel.kind === 'settings' && <SettingsModal />}
        <ConfirmDialog />
        <Toasts />
      </div>
    </div>
  );
}

function MainArea() {
  const view = useUi((s) => s.view);
  const current = useSessions((s) => s.current);
  const viewProjectId = useSessions((s) => s.viewProjectId);

  return (
    <main className="main-area">
      {view === 'home' && <HomeScreen />}
      {view === 'skills' && <SkillsPage />}
      {view === 'agents' && <AgentsPage />}
      {view === 'mcps' && <McpServersPage />}
      {view === 'knowledge' && <KnowledgePage />}
      {view === 'diagnostics' && <DiagnosticsPage />}
      {view === 'chat' &&
        (current ? <ChatView /> : viewProjectId ? <ProjectHome /> : <Welcome />)}
    </main>
  );
}

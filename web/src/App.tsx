import { useEffect, useState } from 'react';
import { api } from './api/client';
import { useCatalog } from './stores/catalogStore';
import { useChat } from './stores/chatStore';
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
import { BmadDocPage } from './components/pages/BmadDocPage';
import { NewProjectModal } from './components/panels/NewProjectModal';
import { SettingsModal } from './components/settings/SettingsModal';
import { Toasts } from './components/common/Toasts';
import { ConfirmDialog } from './components/common/ConfirmDialog';
import { EnvBanner } from './components/layout/EnvBanner';
import { DiagnosticsBanner } from './components/layout/DiagnosticsBanner';
import { UpdateBanner } from './components/layout/UpdateBanner';
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
        // retoma gerações que seguiam rodando no servidor (inclusive de
        // conversas em background) antes do reload da página
        void useChat.getState().resumeAll();
      }
      setBooted(true);
    })();
  }, [loadHealth, loadAll, loadProjects, loadSessions, startDiagnostics]);

  // aba antiga com JS cacheado falando com extensão atualizada: ao voltar o
  // foco, compara versão/build com o health do boot e recarrega se mudou
  useEffect(() => {
    let lastCheck = 0;
    const onFocus = () => {
      const baseline = useCatalog.getState().health;
      if (!baseline?.ok || Date.now() - lastCheck < 60_000) return;
      lastCheck = Date.now();
      void api
        .health()
        .then((h) => {
          if (h.version !== baseline.version || (h.buildId ?? 0) !== (baseline.buildId ?? 0)) {
            location.reload();
          }
        })
        .catch(() => undefined);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  if (!booted) return null;
  if (!health?.ok) return <OnboardingScreen />;
  if (!loggedIn) return <LoginScreen />;

  return (
    <div className="app-root">
      <EnvBanner />
      <DiagnosticsBanner />
      <UpdateBanner />
      <div className="app-shell">
        <Sidebar />
        <MainArea />
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
      {view === 'bmadDoc' && <BmadDocPage />}
      {view === 'diagnostics' && <DiagnosticsPage />}
      {view === 'chat' &&
        (current ? <ChatView /> : viewProjectId ? <ProjectHome /> : <Welcome />)}
    </main>
  );
}

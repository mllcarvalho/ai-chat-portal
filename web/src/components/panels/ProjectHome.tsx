import { useCallback, useEffect, useState } from 'react';
import {
  Folder,
  Hourglass,
  MessagesSquare,
  Package,
  Plus,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import type { BmadStatus } from '@aiportal/shared';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';
import { api } from '../../api/client';
import { useCatalog } from '../../stores/catalogStore';
import { EmptyState, Panel } from '../pages/PageShell';

/**
 * Painel da integração BMAD: a instalação é GLOBAL (vale para todos os
 * projetos); só os documentos gerados ficam na pasta deste projeto.
 */

/** Teto do acompanhamento da instalação: depois disso, oferece tentar de novo. */
const INSTALL_POLL_TIMEOUT_MS = 3 * 60 * 1000;
/** Lembrança do "Agora não" do cartão de consentimento (a instalação é global). */
const INSTALL_DECLINED_KEY = 'aiportal.bmadInstallDeclined';

function BmadPanel() {
  const loadAgents = useCatalog((s) => s.loadAgents);
  const loadSkills = useCatalog((s) => s.loadSkills);
  const toast = useUi((s) => s.toast);
  const [status, setStatus] = useState<BmadStatus | undefined>();
  const [apiError, setApiError] = useState<string | undefined>();
  const [declined, setDeclined] = useState(
    () => localStorage.getItem(INSTALL_DECLINED_KEY) === '1',
  );
  const [pollTimedOut, setPollTimedOut] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await api.bmadStatus();
      setApiError(undefined);
      setStatus(next);
      return next;
    } catch (err) {
      setApiError((err as Error).message);
      setStatus(undefined);
      return undefined;
    }
  }, []);

  useEffect(() => {
    void refresh().then((next) => {
      // o GET /api/bmad registra os presets na primeira consulta — recarrega o catálogo
      if (next?.installed) {
        void loadAgents();
        void loadSkills();
      }
    });
  }, [refresh, loadAgents, loadSkills]);

  // enquanto instala, fica de olho no status — com teto de 3 min: passou disso,
  // para de sondar e oferece tentar de novo (a instalação pode ter travado)
  useEffect(() => {
    if (!status?.installing || pollTimedOut) return;
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - startedAt > INSTALL_POLL_TIMEOUT_MS) {
        clearInterval(timer);
        setPollTimedOut(true);
        return;
      }
      const next = await refresh();
      if (next && !next.installing) {
        clearInterval(timer);
        if (next.error) toast(next.error, 'error');
        else {
          toast('BMAD instalado: agentes e skills disponíveis em todos os projetos.', 'ok');
          void loadAgents();
          void loadSkills();
        }
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [status?.installing, pollTimedOut, refresh, toast, loadAgents, loadSkills]);

  const install = async () => {
    localStorage.removeItem(INSTALL_DECLINED_KEY);
    setDeclined(false);
    setPollTimedOut(false);
    try {
      setStatus(await api.bmadInstall());
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const decline = () => {
    localStorage.setItem(INSTALL_DECLINED_KEY, '1');
    setDeclined(true);
  };

  // depois do teto: confere o status de novo e, se ainda estiver instalando,
  // volta a sondar com um orçamento novo de 3 min
  const retryAfterTimeout = () => {
    setPollTimedOut(false);
    void refresh();
  };

  // instalado e saudável = nada a mostrar: as personas já estão no seletor de
  // agente do chat e as ações na barra BMAD — o painel só aparece para
  // instalar, acompanhar a instalação ou reportar erro
  if (status?.installed && !status.installing && !status.error && !apiError) return null;

  return (
    <Panel title="BMAD — time de produto">
      {apiError && !status && (
        <EmptyState
          icon={<TriangleAlert className="icon icon--lg" aria-hidden />}
          title="Não foi possível consultar o BMAD"
          hint={
            <>
              O servidor do portal respondeu com erro ({apiError}). Provavelmente alguma janela
              do VS Code está servindo um build antigo da extensão — recarregue as janelas
              (<code>Developer: Reload Window</code>) e abra o portal de novo.
            </>
          }
          action={
            <button className="btn" onClick={() => void refresh()}>
              <RefreshCw className="icon" aria-hidden /> Tentar de novo
            </button>
          }
        />
      )}
      {status && !status.installed && !status.installing && status.error && (
        <EmptyState
          icon={<Package className="icon icon--lg" aria-hidden />}
          title="BMAD não instalado"
          hint={
            <>
              O BMAD (módulo BMM) instala uma única vez, valendo para todos os projetos:
              personas viram agentes no chat e os workflows viram comandos <code>/bmad-*</code>.
            </>
          }
          action={
            <button className="btn btn--primary" onClick={() => void install()}>
              <RefreshCw className="icon" aria-hidden /> Tentar instalar de novo
            </button>
          }
        />
      )}
      {status && !status.installed && !status.installing && !status.error && !declined && (
        <EmptyState
          icon={<Package className="icon icon--lg" aria-hidden />}
          title="Instalar o método BMAD neste projeto?"
          hint={
            <>
              O BMAD traz o time de produto para o chat: personas viram agentes e os workflows
              viram comandos <code>/bmad-*</code> (instala uma vez, vale para todos os projetos).
            </>
          }
          action={
            <>
              <button className="btn btn--primary" onClick={() => void install()}>
                <Package className="icon" aria-hidden /> Instalar
              </button>
              <button className="btn btn--ghost" onClick={decline}>
                Agora não
              </button>
            </>
          }
        />
      )}
      {status && !status.installed && !status.installing && !status.error && declined && (
        <EmptyState
          icon={<Package className="icon icon--lg" aria-hidden />}
          title="BMAD não instalado"
          hint="Quando quiser, instale o método BMAD para liberar as personas e as ações do fluxo de produto."
          action={
            <button className="btn" onClick={() => void install()}>
              <Package className="icon" aria-hidden /> Instalar BMAD
            </button>
          }
        />
      )}
      {status?.installing && !pollTimedOut && (
        <EmptyState
          icon={<Hourglass className="icon icon--lg" aria-hidden />}
          title="Instalando BMAD…"
          hint="Rodando npx bmad-method install (instalação global do portal). Isso pode levar alguns minutos."
        />
      )}
      {status?.installing && pollTimedOut && (
        <EmptyState
          icon={<TriangleAlert className="icon icon--lg" aria-hidden />}
          title="A instalação está demorando mais que o esperado"
          hint="Já se passaram mais de 3 minutos. A instalação pode ainda estar rodando em segundo plano — ou pode ter travado (rede, proxy, npm). Verifique de novo ou tente reinstalar."
          action={
            <button className="btn btn--primary" onClick={retryAfterTimeout}>
              <RefreshCw className="icon" aria-hidden /> Tentar de novo
            </button>
          }
        />
      )}
      {status?.error && !status.installing && (
        <p className="page-hint" style={{ color: 'var(--danger)' }}>
          {status.error}
        </p>
      )}
    </Panel>
  );
}

export function ProjectHome() {
  const viewProjectId = useSessions((s) => s.viewProjectId);
  const projects = useSessions((s) => s.projects);
  const byProject = useSessions((s) => s.byProject);
  const loadProjects = useSessions((s) => s.loadProjects);
  const newSession = useSessions((s) => s.newSession);
  const selectSession = useSessions((s) => s.selectSession);
  const openProject = useSessions((s) => s.openProject);
  const setView = useUi((s) => s.setView);
  const toast = useUi((s) => s.toast);
  const confirm = useUi((s) => s.confirm);

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

  const removeProject = async () => {
    const ok = await confirm({
      title: 'Remover projeto',
      message: `Remover o projeto "${project.name}" do portal? A pasta e os arquivos permanecem no disco.`,
      confirmLabel: 'Remover',
      danger: true,
    });
    if (!ok) return;
    await api.deleteProject(project.id);
    openProject(undefined);
    await loadProjects();
  };

  return (
    <div className="page">
      <div className="page__head">
        <span className="page__icon">
          <Folder className="icon icon--lg" aria-hidden />
        </span>
        <div className="page__head-text">
          <h1 className="page__title">{project.name}</h1>
          <p className="page__subtitle">
            {sessions.length} conversa{sessions.length === 1 ? '' : 's'} neste projeto
          </p>
        </div>
        <div className="page__actions">
          <button className="btn btn--primary" onClick={() => void newSession(project.id)}>
            <Plus className="icon" aria-hidden /> Nova conversa
          </button>
          <button className="btn btn--danger" onClick={() => void removeProject()} title="Remover projeto do portal">
            Remover
          </button>
        </div>
      </div>

      <div className="page__body">
        <div className="page-cols">
          <Panel title="Conversas" count={sessions.length}>
            {sessions.length === 0 && (
              <EmptyState
                icon={<MessagesSquare className="icon icon--lg" aria-hidden />}
                title="Nenhuma conversa neste projeto"
                action={
                  <button className="btn btn--primary" onClick={() => void newSession(project.id)}>
                    <Plus className="icon" aria-hidden /> Começar a primeira
                  </button>
                }
              />
            )}
            {sessions.map((session) => (
              <button
                key={session.id}
                className="page-list-item"
                onClick={() => {
                  setView('chat');
                  void selectSession(session.id);
                }}
              >
                <span className="item-card__name">
                  <MessagesSquare className="icon" aria-hidden /> {session.title}
                </span>
                <span className="item-card__desc">
                  {session.messageCount} mensagen{session.messageCount === 1 ? '' : 's'}
                </span>
              </button>
            ))}
          </Panel>

          <div className="page-stack">
            <Panel title="Instruções do projeto" className="panel--form">
              <p className="page-hint">
                Entram no contexto de todas as conversas deste projeto: glossário, padrões de
                entrega, tom…
              </p>
              <div className="field page-card__grow">
                <textarea
                  className="page-card__editor"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  onBlur={() => void saveInstructions()}
                  placeholder="Contexto do projeto, glossário, padrões de entrega…"
                />
              </div>
            </Panel>

            <BmadPanel />
          </div>
        </div>
      </div>
    </div>
  );
}

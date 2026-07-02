import { useCallback, useEffect, useRef, useState } from 'react';
import type { BmadStatus, Project } from '@aiportal/shared';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';
import { api } from '../../api/client';
import { useCatalog } from '../../stores/catalogStore';
import { EmptyState, Panel } from '../pages/PageShell';

/**
 * Painel da integração BMAD: a instalação é GLOBAL (vale para todos os
 * projetos); só os documentos gerados ficam na pasta deste projeto.
 */
function BmadPanel({ project }: { project: Project }) {
  const newSession = useSessions((s) => s.newSession);
  const catalogAgents = useCatalog((s) => s.agents);
  const loadAgents = useCatalog((s) => s.loadAgents);
  const loadSkills = useCatalog((s) => s.loadSkills);
  const setView = useUi((s) => s.setView);
  const toast = useUi((s) => s.toast);
  const [status, setStatus] = useState<BmadStatus | undefined>();
  const [apiError, setApiError] = useState<string | undefined>();

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

  // enquanto instala, fica de olho no status
  useEffect(() => {
    if (!status?.installing) return;
    const timer = setInterval(async () => {
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
  }, [status?.installing, refresh, toast, loadAgents, loadSkills]);

  const install = async () => {
    try {
      setStatus(await api.bmadInstall());
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  // o BMAD vem embutido: se por algum motivo ainda não está instalado (ex.: a
  // ativação rodou sem Node), dispara a instalação sozinho — uma vez por visita
  const autoInstallTried = useRef(false);
  useEffect(() => {
    if (!status || status.installed || status.installing || status.error) return;
    if (autoInstallTried.current) return;
    autoInstallTried.current = true;
    void install();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // personas desabilitadas (Configurações → Agentes BMAD) ficam fora da lista
  const visibleAgents = (status?.agents ?? []).filter(
    (agent) => catalogAgents.find((a) => a.id === agent.presetId)?.enabled !== false,
  );

  return (
    <Panel
      title="BMAD — time de produto"
      count={status?.installed ? visibleAgents.length : undefined}
      actions={
        status?.installed && !status.installing ? (
          <button className="btn btn--sm" onClick={() => void install()} title="Reinstalar / atualizar">
            ↻ Atualizar
          </button>
        ) : undefined
      }
    >
      {apiError && !status && (
        <EmptyState
          icon="⚠️"
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
              ↻ Tentar de novo
            </button>
          }
        />
      )}
      {status && !status.installed && !status.installing && (
        <EmptyState
          icon="🅱️"
          title={status.error ? 'BMAD não instalado' : 'Preparando o BMAD…'}
          hint={
            <>
              O BMAD (módulo BMM) é instalado automaticamente, uma única vez, valendo para todos
              os projetos: personas viram agentes no chat e os workflows viram comandos{' '}
              <code>/bmad-*</code>.
            </>
          }
          action={
            status.error ? (
              <button className="btn btn--primary" onClick={() => void install()}>
                ↻ Tentar instalar de novo
              </button>
            ) : undefined
          }
        />
      )}
      {status?.installing && (
        <EmptyState
          icon="⏳"
          title="Instalando BMAD…"
          hint="Rodando npx bmad-method install (instalação global do portal). Isso pode levar alguns minutos."
        />
      )}
      {status?.error && !status.installing && (
        <p className="page-hint" style={{ color: 'var(--danger)' }}>
          {status.error}
        </p>
      )}
      {status?.installed && !status.installing && (
        <>
          {visibleAgents.map((agent) => (
            <div className="page-list-item page-list-item--static" key={agent.presetId}>
              <span className="item-card__name">
                {agent.icon ?? '🅱️'} {agent.name}
              </span>
              <span className="item-card__desc">{agent.description || '—'}</span>
              <span className="page-list-item__actions">
                <span
                  role="button"
                  className="mini-btn"
                  title="Nova conversa neste projeto com esta persona"
                  onClick={() => {
                    setView('chat');
                    void newSession(project.id, { agentId: agent.presetId });
                  }}
                >
                  Conversar →
                </span>
              </span>
            </div>
          ))}
          <p className="page-hint" style={{ marginTop: 10 }}>
            Instalação global: as personas e os +{status.skillCount} workflows (<code>/bmad-…</code>)
            valem em todos os projetos. Os documentos gerados ficam em{' '}
            <code>_bmad-output/</code> do projeto da conversa. Digite <code>/bmad</code> no chat
            para ver os comandos (ex: <code>/bmad-create-prd</code>, <code>/bmad-party-mode</code>,{' '}
            <code>/bmad-help</code>).
          </p>
        </>
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
  const openPanel = useUi((s) => s.openPanel);
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
        <span className="page__icon">📁</span>
        <div className="page__head-text">
          <h1 className="page__title">{project.name}</h1>
          <p className="page__subtitle">
            {sessions.length} conversa{sessions.length === 1 ? '' : 's'} neste projeto
          </p>
        </div>
        <div className="page__actions">
          <button className="btn btn--primary" onClick={() => void newSession(project.id)}>
            ＋ Nova conversa
          </button>
          <button className="btn" onClick={() => openPanel({ kind: 'files' })}>
            📄 Arquivos
          </button>
          <button className="btn" onClick={() => setView('skills')}>
            ⚡ Skills
          </button>
          <button className="btn" onClick={() => setView('knowledge')}>
            📚 Conhecimento
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
                icon="💬"
                title="Nenhuma conversa neste projeto"
                action={
                  <button className="btn btn--primary" onClick={() => void newSession(project.id)}>
                    ＋ Começar a primeira
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
                <span className="item-card__name">💬 {session.title}</span>
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

            <BmadPanel project={project} />
          </div>
        </div>
      </div>
    </div>
  );
}

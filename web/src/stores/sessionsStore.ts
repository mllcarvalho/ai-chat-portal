import { create } from 'zustand';
import type { Project, Session, SessionMode, SessionSummary } from '@aiportal/shared';
import { api } from '../api/client';
import { useUi } from './uiStore';

/** Erro de rede/servidor vira toast — sem isso a falha era silenciosa na UI. */
function reportError(prefix: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  useUi.getState().toast(`${prefix}: ${message}`, 'error');
}

interface SessionsState {
  projects: Project[];
  standalone: SessionSummary[];
  byProject: Record<string, SessionSummary[]>;
  expandedProjects: Record<string, boolean>;
  current?: Session;
  /** Projeto "aberto" sem sessão (tela do projeto). */
  viewProjectId?: string;

  loadProjects: () => Promise<void>;
  loadSessions: (projectId?: string | null) => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  newSession: (
    projectId?: string | null,
    init?: { agentId?: string; title?: string },
  ) => Promise<Session>;
  renameSession: (id: string, title: string) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  patchCurrent: (patch: Partial<Session>) => Promise<void>;
  setMode: (mode: SessionMode) => Promise<void>;
  toggleProject: (id: string) => void;
  openProject: (id: string | undefined) => void;
  createProject: (name: string) => Promise<Project>;
  closeSession: () => void;
  /** Atualização local (streaming) sem ida ao servidor. */
  mutateCurrent: (fn: (session: Session) => Session) => void;
  /**
   * Atualização local de UMA sessão, aplicada só se ela estiver aberta —
   * streams em background usam isto para não escrever na conversa errada
   * (fora da tela, o servidor persiste e o selectSession recarrega).
   */
  mutateSession: (id: string, fn: (session: Session) => Session) => void;
  refreshSummary: (summary: SessionSummary) => void;
  /** Título otimista na sidebar ao enviar a 1ª mensagem (o servidor grava o mesmo). */
  applyLocalTitle: (id: string, projectId: string | undefined, title: string) => void;
  /**
   * Evento "sessão mudou" vindo do canal global (outra aba/pessoa): insere ou
   * atualiza o resumo nas listas da sidebar, sem refetch.
   */
  applyRemoteSummary: (summary: SessionSummary) => void;
  /** Evento "sessão excluída" vindo do canal global. */
  removeRemoteSession: (sessionId: string, projectId: string | null) => void;
  /**
   * Substitui a conversa aberta pelo estado do servidor (mudou por fora desta
   * aba). O `guard` roda DEPOIS do fetch: se um envio começou nesse meio
   * tempo, a troca é abortada para não engolir a mensagem otimista.
   */
  reloadCurrentFromServer: (id: string, guard?: () => boolean) => Promise<void>;
}

export const useSessions = create<SessionsState>((set, get) => ({
  projects: [],
  standalone: [],
  byProject: {},
  expandedProjects: {},

  loadProjects: async () => {
    try {
      set({ projects: await api.listProjects() });
    } catch (err) {
      reportError('Falha ao carregar projetos', err);
    }
  },

  loadSessions: async (projectId) => {
    let list: SessionSummary[];
    try {
      list = await api.listSessions(projectId);
    } catch (err) {
      reportError('Falha ao carregar conversas', err);
      return;
    }
    if (projectId) {
      set({ byProject: { ...get().byProject, [projectId]: list } });
    } else {
      set({ standalone: list });
    }
  },

  selectSession: async (id) => {
    try {
      const session = await api.getSession(id);
      set({ current: session, viewProjectId: undefined });
    } catch (err) {
      reportError('Falha ao abrir a conversa', err);
    }
  },

  newSession: async (projectId, init) => {
    // quem chama depende do retorno: o toast avisa e o erro segue propagando
    let session: Session;
    // herda o motor da conversa aberta: quem estava no Claude Code e clica em
    // "nova conversa" espera continuar nele, não voltar para o padrão
    const inherited = get().current?.provider;
    try {
      session = await api.createSession({
        projectId: projectId ?? null,
        ...(inherited ? { provider: inherited } : {}),
        ...init,
      });
    } catch (err) {
      reportError('Falha ao criar a conversa', err);
      throw err;
    }
    await get().loadSessions(projectId ?? null);
    set({ current: session, viewProjectId: undefined });
    if (projectId) set({ expandedProjects: { ...get().expandedProjects, [projectId]: true } });
    return session;
  },

  renameSession: async (id, title) => {
    try {
      const updated = await api.patchSession(id, { title });
      const { current } = get();
      if (current?.id === id) set({ current: { ...current, title: updated.title } });
      await get().loadSessions(updated.projectId);
    } catch (err) {
      reportError('Falha ao renomear a conversa', err);
    }
  },

  removeSession: async (id) => {
    const { current, standalone, byProject } = get();
    const summary =
      standalone.find((s) => s.id === id) ??
      Object.values(byProject)
        .flat()
        .find((s) => s.id === id);
    try {
      await api.deleteSession(id);
    } catch (err) {
      reportError('Falha ao excluir a conversa', err);
      return;
    }
    if (current?.id === id) set({ current: undefined });
    await get().loadSessions(summary?.projectId ?? null);
  },

  patchCurrent: async (patch) => {
    const { current } = get();
    if (!current) return;
    let updated: Session;
    try {
      updated = await api.patchSession(current.id, patch);
    } catch (err) {
      reportError('Falha ao salvar a conversa', err);
      return;
    }
    // sincroniza as listas da sidebar na hora (sem refetch): título, modo etc.
    const { standalone, byProject } = get();
    const fields: Partial<Session> = { ...updated };
    delete (fields as { messages?: unknown }).messages;
    const apply = (list: SessionSummary[]) =>
      list.map((s) => (s.id === updated.id ? { ...s, ...fields } : s));
    set({
      current: updated,
      standalone: apply(standalone),
      byProject: Object.fromEntries(
        Object.entries(byProject).map(([pid, list]) => [pid, apply(list)]),
      ),
    });
  },

  setMode: async (mode) => {
    await get().patchCurrent({ mode });
  },

  toggleProject: (id) => {
    const { expandedProjects } = get();
    const open = !expandedProjects[id];
    set({ expandedProjects: { ...expandedProjects, [id]: open } });
    if (open) void get().loadSessions(id);
  },

  openProject: (id) => {
    set({ viewProjectId: id, current: undefined });
    if (id) void get().loadSessions(id);
  },

  createProject: async (name) => {
    let project: Project;
    try {
      project = await api.createProject(name);
    } catch (err) {
      reportError('Falha ao criar o projeto', err);
      throw err;
    }
    await get().loadProjects();
    set({ expandedProjects: { ...get().expandedProjects, [project.id]: true } });
    return project;
  },

  closeSession: () => set({ current: undefined }),

  mutateCurrent: (fn) => {
    const { current } = get();
    if (current) set({ current: fn(current) });
  },

  mutateSession: (id, fn) => {
    const { current } = get();
    if (current?.id === id) set({ current: fn(current) });
  },

  refreshSummary: (summary) => {
    const { current } = get();
    if (current?.id === summary.id && current.title !== summary.title) {
      set({ current: { ...current, title: summary.title } });
    }
    void get().loadSessions(summary.projectId);
  },

  applyLocalTitle: (id, projectId, title) => {
    const { current, standalone, byProject } = get();
    if (current?.id === id) set({ current: { ...current, title } });
    const patch = (list: SessionSummary[]) =>
      list.map((s) => (s.id === id ? { ...s, title } : s));
    if (projectId) {
      set({ byProject: { ...byProject, [projectId]: patch(byProject[projectId] ?? []) } });
    } else {
      set({ standalone: patch(standalone) });
    }
  },

  applyRemoteSummary: (summary) => {
    const { current, standalone, byProject } = get();
    const upsert = (list: SessionSummary[]) =>
      [summary, ...list.filter((s) => s.id !== summary.id)].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );
    if (summary.projectId) {
      // só atualiza projetos já carregados: os demais buscam ao expandir
      if (byProject[summary.projectId]) {
        set({
          byProject: { ...byProject, [summary.projectId]: upsert(byProject[summary.projectId]) },
        });
      }
    } else {
      set({ standalone: upsert(standalone) });
    }
    if (current?.id === summary.id && current.title !== summary.title) {
      set({ current: { ...current, title: summary.title } });
    }
  },

  removeRemoteSession: (sessionId, projectId) => {
    const { current, standalone, byProject } = get();
    const without = (list: SessionSummary[]) => list.filter((s) => s.id !== sessionId);
    if (projectId) {
      if (byProject[projectId]) {
        set({ byProject: { ...byProject, [projectId]: without(byProject[projectId]) } });
      }
    } else {
      set({ standalone: without(standalone) });
    }
    if (current?.id === sessionId) set({ current: undefined });
  },

  reloadCurrentFromServer: async (id, guard) => {
    if (get().current?.id !== id) return;
    let fresh: Session;
    try {
      fresh = await api.getSession(id);
    } catch {
      return; // transitório; o próximo evento tenta de novo
    }
    // a pessoa pode ter trocado de conversa (ou começado a gerar) durante o fetch
    if (get().current?.id === id && (guard?.() ?? true)) set({ current: fresh });
  },
}));

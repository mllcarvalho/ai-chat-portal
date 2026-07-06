import { create } from 'zustand';
import type { Project, Session, SessionMode, SessionSummary } from '@aiportal/shared';
import { api } from '../api/client';

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
}

export const useSessions = create<SessionsState>((set, get) => ({
  projects: [],
  standalone: [],
  byProject: {},
  expandedProjects: {},

  loadProjects: async () => {
    set({ projects: await api.listProjects() });
  },

  loadSessions: async (projectId) => {
    const list = await api.listSessions(projectId);
    if (projectId) {
      set({ byProject: { ...get().byProject, [projectId]: list } });
    } else {
      set({ standalone: list });
    }
  },

  selectSession: async (id) => {
    const session = await api.getSession(id);
    set({ current: session, viewProjectId: undefined });
  },

  newSession: async (projectId, init) => {
    const session = await api.createSession({ projectId: projectId ?? null, ...init });
    await get().loadSessions(projectId ?? null);
    set({ current: session, viewProjectId: undefined });
    if (projectId) set({ expandedProjects: { ...get().expandedProjects, [projectId]: true } });
    return session;
  },

  renameSession: async (id, title) => {
    const updated = await api.patchSession(id, { title });
    const { current } = get();
    if (current?.id === id) set({ current: { ...current, title: updated.title } });
    await get().loadSessions(updated.projectId);
  },

  removeSession: async (id) => {
    const { current, standalone, byProject } = get();
    const summary =
      standalone.find((s) => s.id === id) ??
      Object.values(byProject)
        .flat()
        .find((s) => s.id === id);
    await api.deleteSession(id);
    if (current?.id === id) set({ current: undefined });
    await get().loadSessions(summary?.projectId ?? null);
  },

  patchCurrent: async (patch) => {
    const { current } = get();
    if (!current) return;
    const updated = await api.patchSession(current.id, patch);
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
    const project = await api.createProject(name);
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
}));

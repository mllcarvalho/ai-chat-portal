import { create } from 'zustand';
import type {
  AgentPreset,
  CopilotQuota,
  HealthInfo,
  MeInfo,
  ModelInfo,
  Skill,
  ToolInfo,
} from '@aiportal/shared';
import { api } from '../api/client';
import { useUi } from './uiStore';

/** Falha de rede num refresh: mantém o catálogo anterior e avisa via toast. */
function reportError(prefix: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  useUi.getState().toast(`${prefix}: ${message}`, 'error');
}

interface CatalogState {
  health?: HealthInfo;
  me?: MeInfo;
  models: ModelInfo[];
  skills: Skill[];
  agents: AgentPreset[];
  tools: ToolInfo[];
  /** null = consultado e indisponível (sem conta, rede, plano sem cota). */
  quota?: CopilotQuota | null;
  /** Motivo da indisponibilidade (mensagem do servidor), quando quota === null. */
  quotaError?: string;
  loadHealth: () => Promise<HealthInfo | undefined>;
  loadAll: () => Promise<void>;
  /** Catálogo completo: skills globais + de todos os projetos (filtragem é no cliente). */
  loadSkills: () => Promise<void>;
  loadAgents: () => Promise<void>;
  loadTools: (sessionId?: string) => Promise<void>;
  loadQuota: (fresh?: boolean) => Promise<void>;
}

export const useCatalog = create<CatalogState>((set) => ({
  models: [],
  skills: [],
  agents: [],
  tools: [],

  loadHealth: async () => {
    try {
      const health = await api.health();
      set({ health });
      return health;
    } catch {
      set({ health: undefined });
      return undefined;
    }
  },

  loadAll: async () => {
    const [me, models, skills, agents] = await Promise.allSettled([
      api.me(),
      api.models(),
      api.listSkills(),
      api.listAgents(),
    ]);
    set({
      me: me.status === 'fulfilled' ? me.value : undefined,
      models: models.status === 'fulfilled' ? models.value : [],
      skills: skills.status === 'fulfilled' ? skills.value : [],
      agents: agents.status === 'fulfilled' ? agents.value : [],
    });
  },

  loadSkills: async () => {
    try {
      set({ skills: await api.listSkills() });
    } catch (err) {
      reportError('Falha ao carregar skills', err);
    }
  },

  loadAgents: async () => {
    try {
      set({ agents: await api.listAgents() });
    } catch (err) {
      reportError('Falha ao carregar agentes', err);
    }
  },

  loadTools: async (sessionId) => {
    try {
      set({ tools: await api.listTools(sessionId) });
    } catch (err) {
      reportError('Falha ao carregar ferramentas', err);
    }
  },

  loadQuota: async (fresh = false) => {
    try {
      set({ quota: await api.copilotQuota(fresh), quotaError: undefined });
    } catch (err) {
      set({ quota: null, quotaError: err instanceof Error ? err.message : undefined });
    }
  },
}));

import { create } from 'zustand';
import type {
  AgentPreset,
  HealthInfo,
  MeInfo,
  ModelInfo,
  Skill,
  ToolInfo,
} from '@aiportal/shared';
import { api } from '../api/client';

interface CatalogState {
  health?: HealthInfo;
  me?: MeInfo;
  models: ModelInfo[];
  skills: Skill[];
  agents: AgentPreset[];
  tools: ToolInfo[];
  loadHealth: () => Promise<HealthInfo | undefined>;
  loadAll: () => Promise<void>;
  loadSkills: (projectId?: string) => Promise<void>;
  loadAgents: () => Promise<void>;
  loadTools: (sessionId?: string) => Promise<void>;
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

  loadSkills: async (projectId) => {
    set({ skills: await api.listSkills(projectId) });
  },

  loadAgents: async () => {
    set({ agents: await api.listAgents() });
  },

  loadTools: async (sessionId) => {
    set({ tools: await api.listTools(sessionId) });
  },
}));

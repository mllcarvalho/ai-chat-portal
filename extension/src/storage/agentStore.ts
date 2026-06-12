import * as crypto from 'node:crypto';
import type { AgentPreset } from '@aiportal/shared';
import { readJson, writeJsonAtomic } from './jsonStore';
import { agentsPath } from './paths';

function readAll(): AgentPreset[] {
  return readJson<AgentPreset[]>(agentsPath()) ?? [];
}

export function listAgents(): AgentPreset[] {
  return readAll().sort((a, b) => a.name.localeCompare(b.name));
}

export function getAgent(id: string): AgentPreset | undefined {
  return readAll().find((a) => a.id === id);
}

export function createAgent(
  input: Omit<AgentPreset, 'id' | 'createdAt' | 'updatedAt'>,
): AgentPreset {
  const now = new Date().toISOString();
  const agent: AgentPreset = { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
  writeJsonAtomic(agentsPath(), [...readAll(), agent]);
  return agent;
}

/** Cria ou atualiza um preset com id fixo (integrações idempotentes, ex: BMAD). */
export function upsertAgentWithId(
  id: string,
  input: Omit<AgentPreset, 'id' | 'createdAt' | 'updatedAt'>,
): AgentPreset {
  const agents = readAll();
  const now = new Date().toISOString();
  const idx = agents.findIndex((a) => a.id === id);
  if (idx >= 0) {
    agents[idx] = { ...agents[idx], ...input, updatedAt: now };
    writeJsonAtomic(agentsPath(), agents);
    return agents[idx];
  }
  const agent: AgentPreset = { ...input, id, createdAt: now, updatedAt: now };
  writeJsonAtomic(agentsPath(), [...agents, agent]);
  return agent;
}

export function updateAgent(
  id: string,
  patch: Partial<Omit<AgentPreset, 'id' | 'createdAt' | 'updatedAt'>>,
): AgentPreset | undefined {
  const agents = readAll();
  const idx = agents.findIndex((a) => a.id === id);
  if (idx < 0) return undefined;
  agents[idx] = { ...agents[idx], ...patch, updatedAt: new Date().toISOString() };
  writeJsonAtomic(agentsPath(), agents);
  return agents[idx];
}

export function deleteAgent(id: string): boolean {
  const agents = readAll();
  const next = agents.filter((a) => a.id !== id);
  if (next.length === agents.length) return false;
  writeJsonAtomic(agentsPath(), next);
  return true;
}

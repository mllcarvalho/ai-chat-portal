import * as crypto from 'node:crypto';
import type { AgentPreset } from '@aiportal/shared';
import { readJson, writeJsonAtomic } from './jsonStore';
import { AGENTS_PATH } from './paths';

function readAll(): AgentPreset[] {
  return readJson<AgentPreset[]>(AGENTS_PATH) ?? [];
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
  writeJsonAtomic(AGENTS_PATH, [...readAll(), agent]);
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
  writeJsonAtomic(AGENTS_PATH, agents);
  return agents[idx];
}

export function deleteAgent(id: string): boolean {
  const agents = readAll();
  const next = agents.filter((a) => a.id !== id);
  if (next.length === agents.length) return false;
  writeJsonAtomic(AGENTS_PATH, next);
  return true;
}

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentPreset } from '@aiportal/shared';
import { readJson, writeJsonAtomic } from './jsonStore';
import { agentsPath } from './paths';
import { SHARED_AGENTS_DIR, getLibrary, libraryDir, libraryDirs } from './sharedLibrary';

/**
 * Agentes locais ficam todos em agents.json. Os de biblioteca compartilhada
 * ficam UM ARQUIVO POR AGENTE dentro de <biblioteca>/agents/<id>.json: numa
 * pasta de rede, um arquivo único seria reescrito inteiro por quem salvasse
 * primeiro e apagaria o agente que o colega acabou de criar.
 */

function readLocal(): AgentPreset[] {
  return readJson<AgentPreset[]>(agentsPath()) ?? [];
}

/** Agentes de todas as bibliotecas que respondem agora. */
function readShared(): AgentPreset[] {
  const agents: AgentPreset[] = [];
  for (const { lib, dir } of libraryDirs(SHARED_AGENTS_DIR)) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
      continue; // biblioteca sem pasta de agentes ainda
    }
    for (const file of files) {
      const agent = readJson<AgentPreset>(path.join(dir, file));
      if (agent?.id) agents.push({ ...agent, scope: 'shared', libraryId: lib.id });
    }
  }
  return agents;
}

function readAll(): AgentPreset[] {
  return [...readLocal(), ...readShared()];
}

/** Arquivo do agente compartilhado (undefined quando a biblioteca sumiu). */
function sharedFileFor(agent: Pick<AgentPreset, 'id' | 'libraryId'>): string | undefined {
  if (!agent.libraryId) return undefined;
  const lib = getLibrary(agent.libraryId);
  if (!lib) return undefined;
  return path.join(libraryDir(lib, SHARED_AGENTS_DIR, true), `${agent.id}.json`);
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
  if (agent.scope === 'shared') {
    const file = sharedFileFor(agent);
    if (!file) throw new Error('Biblioteca compartilhada não encontrada para gravar o agente');
    writeJsonAtomic(file, agent);
    return agent;
  }
  writeJsonAtomic(agentsPath(), [...readLocal(), agent]);
  return agent;
}

/** Cria ou atualiza um preset com id fixo (integrações idempotentes, ex: BMAD). */
export function upsertAgentWithId(
  id: string,
  input: Omit<AgentPreset, 'id' | 'createdAt' | 'updatedAt'>,
): AgentPreset {
  const agents = readLocal();
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
  const current = getAgent(id);
  if (!current) return undefined;
  const updated: AgentPreset = { ...current, ...patch, updatedAt: new Date().toISOString() };
  const wasShared = current.scope === 'shared';
  const isShared = updated.scope === 'shared';

  if (isShared) {
    const file = sharedFileFor(updated);
    if (!file) throw new Error('Biblioteca compartilhada não encontrada para gravar o agente');
    writeJsonAtomic(file, updated);
    // veio do agents.json local (a pessoa moveu o agente para a biblioteca)
    if (!wasShared) {
      writeJsonAtomic(
        agentsPath(),
        readLocal().filter((a) => a.id !== id),
      );
    }
    return updated;
  }

  updated.libraryId = undefined;
  const local = readLocal();
  const idx = local.findIndex((a) => a.id === id);
  if (idx >= 0) {
    local[idx] = updated;
    writeJsonAtomic(agentsPath(), local);
  } else {
    // saiu da biblioteca para o local: grava aqui e apaga lá
    writeJsonAtomic(agentsPath(), [...local, updated]);
    if (wasShared) removeSharedFile(current);
  }
  return updated;
}

export function deleteAgent(id: string): boolean {
  const current = getAgent(id);
  if (!current) return false;
  if (current.scope === 'shared') return removeSharedFile(current);
  const agents = readLocal();
  const next = agents.filter((a) => a.id !== id);
  if (next.length === agents.length) return false;
  writeJsonAtomic(agentsPath(), next);
  return true;
}

function removeSharedFile(agent: AgentPreset): boolean {
  const file = sharedFileFor(agent);
  if (!file) return false;
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

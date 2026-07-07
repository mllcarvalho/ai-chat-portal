import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Session, SessionMode, SessionSummary } from '@aiportal/shared';
import { readJson, writeJsonAtomic, deleteFile } from './jsonStore';
import { PROJECT_META_DIR, sessionWorkspaceDir, sessionsDir } from './paths';
import { getProject, listProjects, projectDir } from './projectStore';

function sessionsDirFor(projectId: string | null): string | undefined {
  if (!projectId) return sessionsDir();
  const project = getProject(projectId);
  if (!project) return undefined;
  return path.join(projectDir(project), PROJECT_META_DIR, 'sessions');
}

function readSessionsIn(dir: string): Session[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const sessions: Session[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const session = readJson<Session>(path.join(dir, file));
    if (session?.id) sessions.push(session);
  }
  return sessions;
}

export function toSummary(session: Session): SessionSummary {
  const { messages, activeSkillIds: _skills, enabledTools: _tools, ...rest } = session;
  return { ...rest, messageCount: messages.length };
}

export function listSessions(projectId: string | null): SessionSummary[] {
  const dir = sessionsDirFor(projectId);
  if (!dir) return [];
  return readSessionsIn(dir)
    .map(toSummary)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function findSessionFile(id: string): string | undefined {
  const standalone = path.join(sessionsDir(), `${id}.json`);
  if (fs.existsSync(standalone)) return standalone;
  for (const project of listProjects()) {
    const file = path.join(projectDir(project), PROJECT_META_DIR, 'sessions', `${id}.json`);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

export function getSession(id: string): Session | undefined {
  const file = findSessionFile(id);
  return file ? readJson<Session>(file) : undefined;
}

export function createSession(init: {
  title?: string;
  projectId?: string | null;
  mode?: SessionMode;
  modelId?: string;
  agentId?: string;
}): Session | undefined {
  const projectId = init.projectId ?? null;
  const dir = sessionsDirFor(projectId);
  if (!dir) return undefined;
  const now = new Date().toISOString();
  const session: Session = {
    id: crypto.randomUUID(),
    title: init.title || 'Nova conversa',
    projectId,
    mode: init.mode ?? 'agent',
    modelId: init.modelId,
    agentId: init.agentId,
    activeSkillIds: [],
    enabledTools: null,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  writeJsonAtomic(path.join(dir, `${session.id}.json`), session);
  return session;
}

export function saveSession(session: Session): void {
  const dir = sessionsDirFor(session.projectId);
  if (!dir) throw new Error(`Projeto da sessão ${session.id} não encontrado`);
  session.updatedAt = new Date().toISOString();
  writeJsonAtomic(path.join(dir, `${session.id}.json`), session);
}

/**
 * Releitura + mutação + gravação no mesmo tick (tudo síncrono): requests
 * concorrentes na MESMA sessão (streaming longo × rename, usage_update tardio
 * × edição) não se sobrescrevem, ao contrário de segurar um objeto em memória
 * através de awaits e regravar o arquivo inteiro depois.
 */
export function updateSession(id: string, mutate: (session: Session) => void): Session | undefined {
  const file = findSessionFile(id);
  if (!file) return undefined;
  const session = readJson<Session>(file);
  if (!session) return undefined;
  mutate(session);
  session.updatedAt = new Date().toISOString();
  writeJsonAtomic(file, session);
  return session;
}

export function deleteSession(id: string): boolean {
  const file = findSessionFile(id);
  if (!file) return false;
  deleteFile(file);
  // o workspace é o rascunho da conversa: morre junto com ela
  try {
    fs.rmSync(sessionWorkspaceDir(id), { recursive: true, force: true });
  } catch {
    // melhor-esforço (ex: arquivo aberto no Windows); a pasta órfã não atrapalha
  }
  return true;
}

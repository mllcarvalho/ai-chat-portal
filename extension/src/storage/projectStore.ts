import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Project } from '@aiportal/shared';
import { getConfig } from './configStore';
import { readJson, writeJsonAtomic } from './jsonStore';
import { PROJECT_META_DIR, ensureDir } from './paths';

function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'projeto';
}

function projectJsonPath(dirName: string): string {
  return path.join(getConfig().projectsRoot, dirName, PROJECT_META_DIR, 'project.json');
}

export function projectDir(project: Project): string {
  return path.join(getConfig().projectsRoot, project.dirName);
}

export function listProjects(): Project[] {
  const root = getConfig().projectsRoot;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects: Project[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = readJson<Project>(projectJsonPath(entry.name));
    if (meta?.id) projects.push({ ...meta, dirName: entry.name });
  }
  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getProject(id: string): Project | undefined {
  return listProjects().find((p) => p.id === id);
}

export function createProject(name: string): Project {
  const base = slugify(name);
  let dirName = base;
  let i = 2;
  while (fs.existsSync(path.join(getConfig().projectsRoot, dirName))) {
    dirName = `${base}-${i++}`;
  }
  const now = new Date().toISOString();
  const project: Project = {
    id: crypto.randomUUID(),
    name,
    dirName,
    createdAt: now,
    updatedAt: now,
  };
  ensureDir(path.join(getConfig().projectsRoot, dirName, PROJECT_META_DIR, 'sessions'));
  ensureDir(path.join(getConfig().projectsRoot, dirName, PROJECT_META_DIR, 'skills'));
  writeJsonAtomic(projectJsonPath(dirName), project);
  return project;
}

export function patchProject(
  id: string,
  patch: Partial<Pick<Project, 'name' | 'instructions' | 'defaultAgentId'>>,
): Project | undefined {
  const project = getProject(id);
  if (!project) return undefined;
  const updated: Project = { ...project, ...patch, updatedAt: new Date().toISOString() };
  writeJsonAtomic(projectJsonPath(project.dirName), updated);
  return updated;
}

/** Só desregistra o projeto (renomeia o project.json); a pasta e os arquivos ficam no disco. */
export function unregisterProject(id: string): boolean {
  const project = getProject(id);
  if (!project) return false;
  const metaPath = projectJsonPath(project.dirName);
  fs.renameSync(metaPath, `${metaPath}.removed`);
  return true;
}

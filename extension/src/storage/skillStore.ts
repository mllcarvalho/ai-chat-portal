import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Skill, SkillWithContent } from '@aiportal/shared';
import { readJson, writeJsonAtomic, deleteFile } from './jsonStore';
import { PROJECT_META_DIR, skillsDir, ensureDir } from './paths';
import { getProject, listProjects, projectDir } from './projectStore';

function skillsDirFor(scope: 'global' | 'project', projectId?: string): string | undefined {
  if (scope === 'global') return skillsDir();
  if (!projectId) return undefined;
  const project = getProject(projectId);
  if (!project) return undefined;
  return path.join(projectDir(project), PROJECT_META_DIR, 'skills');
}

function readSkillsIn(dir: string): Skill[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const skill = readJson<Skill>(path.join(dir, file));
    if (skill?.id) skills.push(skill);
  }
  return skills;
}

/** Skills globais + (se informado) as do projeto. */
export function listSkills(projectId?: string): Skill[] {
  const skills = readSkillsIn(skillsDir());
  if (projectId) {
    const dir = skillsDirFor('project', projectId);
    if (dir) skills.push(...readSkillsIn(dir));
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function findSkillDir(id: string): string | undefined {
  if (fs.existsSync(path.join(skillsDir(), `${id}.json`))) return skillsDir();
  for (const project of listProjects()) {
    const dir = path.join(projectDir(project), PROJECT_META_DIR, 'skills');
    if (fs.existsSync(path.join(dir, `${id}.json`))) return dir;
  }
  return undefined;
}

export function getSkill(id: string): SkillWithContent | undefined {
  const dir = findSkillDir(id);
  if (!dir) return undefined;
  const meta = readJson<Skill>(path.join(dir, `${id}.json`));
  if (!meta) return undefined;
  let content = '';
  try {
    content = fs.readFileSync(path.join(dir, `${id}.md`), 'utf8');
  } catch {
    // skill sem conteúdo ainda
  }
  return { ...meta, content };
}

export function createSkill(input: {
  kind: 'instruction' | 'command';
  scope: 'global' | 'project';
  projectId?: string;
  name: string;
  description: string;
  command?: string;
  content: string;
}): SkillWithContent | undefined {
  const dir = skillsDirFor(input.scope, input.projectId);
  if (!dir) return undefined;
  ensureDir(dir);
  const now = new Date().toISOString();
  const skill: Skill = {
    id: crypto.randomUUID(),
    kind: input.kind,
    scope: input.scope,
    projectId: input.scope === 'project' ? input.projectId : undefined,
    name: input.name,
    description: input.description,
    command: input.kind === 'command' ? input.command : undefined,
    createdAt: now,
    updatedAt: now,
  };
  writeJsonAtomic(path.join(dir, `${skill.id}.json`), skill);
  fs.writeFileSync(path.join(dir, `${skill.id}.md`), input.content, 'utf8');
  return { ...skill, content: input.content };
}

export function updateSkill(
  id: string,
  patch: Partial<Pick<SkillWithContent, 'name' | 'description' | 'command' | 'content'>>,
): SkillWithContent | undefined {
  const dir = findSkillDir(id);
  if (!dir) return undefined;
  const existing = readJson<Skill>(path.join(dir, `${id}.json`));
  if (!existing) return undefined;
  const { content, ...metaPatch } = patch;
  const updated: Skill = { ...existing, ...metaPatch, updatedAt: new Date().toISOString() };
  writeJsonAtomic(path.join(dir, `${id}.json`), updated);
  if (content !== undefined) {
    fs.writeFileSync(path.join(dir, `${id}.md`), content, 'utf8');
  }
  return getSkill(id);
}

export function deleteSkill(id: string): boolean {
  const dir = findSkillDir(id);
  if (!dir) return false;
  deleteFile(path.join(dir, `${id}.json`));
  deleteFile(path.join(dir, `${id}.md`));
  return true;
}

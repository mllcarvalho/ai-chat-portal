import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const ROOT = path.join(os.homedir(), 'AIChatPortal');
export const SESSIONS_DIR = path.join(ROOT, 'sessions');
export const SKILLS_DIR = path.join(ROOT, 'skills');
export const DEFAULT_PROJECTS_ROOT = path.join(ROOT, 'projects');
export const CONFIG_PATH = path.join(ROOT, 'config.json');
export const RUNTIME_PATH = path.join(ROOT, 'runtime.json');
export const AGENTS_PATH = path.join(ROOT, 'agents.json');
export const MCP_SERVERS_PATH = path.join(ROOT, 'mcp-servers.json');

/** Subpasta de metadados dentro de cada projeto (sessões, skills, project.json). */
export const PROJECT_META_DIR = '.aiportal';

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function ensureLayout(projectsRoot: string): void {
  ensureDir(ROOT);
  ensureDir(SESSIONS_DIR);
  ensureDir(SKILLS_DIR);
  ensureDir(projectsRoot);
}

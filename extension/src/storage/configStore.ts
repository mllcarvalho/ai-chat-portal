import * as crypto from 'node:crypto';
import type { Config } from '@aiportal/shared';
import { DEFAULT_PORT } from '@aiportal/shared';
import { CONFIG_PATH, DEFAULT_PROJECTS_ROOT, ensureLayout } from './paths';
import { readJson, writeJsonAtomic } from './jsonStore';

let cached: Config | undefined;

export function loadConfig(): Config {
  const existing = readJson<Config>(CONFIG_PATH);
  if (existing && existing.token && existing.projectsRoot) {
    cached = existing;
  } else {
    cached = {
      version: 1,
      port: DEFAULT_PORT,
      token: crypto.randomBytes(32).toString('hex'),
      projectsRoot: DEFAULT_PROJECTS_ROOT,
      devOrigins: ['http://localhost:5173'],
    };
    writeJsonAtomic(CONFIG_PATH, cached);
  }
  ensureLayout(cached.projectsRoot);
  return cached;
}

export function getConfig(): Config {
  if (!cached) return loadConfig();
  return cached;
}

export function patchConfig(patch: Partial<Pick<Config, 'projectsRoot' | 'devOrigins'>>): Config {
  const cfg = getConfig();
  cached = { ...cfg, ...patch };
  writeJsonAtomic(CONFIG_PATH, cached);
  ensureLayout(cached.projectsRoot);
  return cached;
}

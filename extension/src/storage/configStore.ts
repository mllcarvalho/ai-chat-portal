import * as crypto from 'node:crypto';
import type { Config } from '@aiportal/shared';
import { DEFAULT_PORT } from '@aiportal/shared';
import {
  CONFIG_PATH,
  LEGACY_PROJECTS_ROOT,
  defaultProjectsRoot,
  ensureLayout,
} from './paths';
import { readJson, writeJsonAtomic } from './jsonStore';

let cached: Config | undefined;

/**
 * O projectsRoot default acompanha a raiz de dados (portal-data/projects quando
 * o repo do portal está aberto). Configs antigas apontando para o default legado
 * (~/AIChatPortal/projects) são tratadas como "sem customização".
 */
function resolveProjectsRoot(stored: string | undefined): string {
  if (!stored || stored === LEGACY_PROJECTS_ROOT) return defaultProjectsRoot();
  return stored;
}

export function loadConfig(): Config {
  const existing = readJson<Partial<Config>>(CONFIG_PATH);
  if (existing && existing.token) {
    cached = { ...(existing as Config), projectsRoot: resolveProjectsRoot(existing.projectsRoot) };
  } else {
    // primeira ativação. O instalador pode ter deixado um config parcial
    // (ex.: hostedPortalUrl via `--portal`) — preserva o que veio, só
    // completa o que falta
    cached = {
      version: 1,
      port: DEFAULT_PORT,
      projectsRoot: defaultProjectsRoot(),
      devOrigins: ['http://localhost:5173'],
      ...(existing ?? {}),
      token: crypto.randomBytes(32).toString('hex'),
    };
    cached.projectsRoot = resolveProjectsRoot(cached.projectsRoot);
    writeJsonAtomic(CONFIG_PATH, cached);
  }
  ensureLayout(cached.projectsRoot);
  return cached;
}

export function getConfig(): Config {
  if (!cached) return loadConfig();
  return cached;
}

export function patchConfig(
  patch: Partial<
    Pick<
      Config,
      | 'projectsRoot'
      | 'devOrigins'
      | 'network'
      | 'microsoft'
      | 'racfUser'
      | 'commandAllowlist'
      | 'sharedLibraries'
      | 'captureBrowser'
      | 'collab'
      | 'hostedPortalUrl'
    >
  >,
): Config {
  const cfg = getConfig();
  cached = { ...cfg, ...patch };
  writeJsonAtomic(CONFIG_PATH, cached);
  ensureLayout(cached.projectsRoot);
  return cached;
}

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Config global da máquina (porta/token/runtime) fica em ~/AIChatPortal.
 * Tudo que o usuário cria pela UI (skills, agentes, sessões, projetos,
 * conhecimento) fica em <repo do portal>/portal-data — assim vive junto do
 * código que a pessoa mantém aberto no VS Code por causa dos MCPs.
 */
export const GLOBAL_ROOT = path.join(os.homedir(), 'AIChatPortal');
export const CONFIG_PATH = path.join(GLOBAL_ROOT, 'config.json');
export const RUNTIME_PATH = path.join(GLOBAL_ROOT, 'runtime.json');

/** Subpasta de metadados dentro de cada projeto (sessões, skills, project.json). */
export const PROJECT_META_DIR = '.aiportal';

let portalRoot: string | undefined;

/**
 * Define a raiz do repositório do portal (workspace que contém este projeto).
 * Chamado uma vez na ativação da extensão, antes de qualquer leitura.
 */
export function initPortalRoot(root: string | undefined): void {
  portalRoot = root;
  if (root) migrateLegacyData();
}

/** Raiz do repo do portal quando aberto no VS Code (undefined = janela sem o repo). */
export function getPortalRoot(): string | undefined {
  return portalRoot;
}

/** Raiz dos dados do usuário: <repo>/portal-data, ou ~/AIChatPortal como fallback. */
export function dataRoot(): string {
  return portalRoot ? path.join(portalRoot, 'portal-data') : GLOBAL_ROOT;
}

export function sessionsDir(): string {
  return path.join(dataRoot(), 'sessions');
}

export function skillsDir(): string {
  return path.join(dataRoot(), 'skills');
}

export function knowledgeDir(): string {
  return path.join(dataRoot(), 'knowledge');
}

export function agentsPath(): string {
  return path.join(dataRoot(), 'agents.json');
}

export function mcpStatePath(): string {
  return path.join(dataRoot(), 'mcp-state.json');
}

export function defaultProjectsRoot(): string {
  return path.join(dataRoot(), 'projects');
}

/** Caminho legado de projetos (~/AIChatPortal/projects) para detectar config antiga. */
export const LEGACY_PROJECTS_ROOT = path.join(GLOBAL_ROOT, 'projects');

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function ensureLayout(projectsRoot: string): void {
  ensureDir(GLOBAL_ROOT);
  ensureDir(dataRoot());
  ensureDir(sessionsDir());
  ensureDir(skillsDir());
  ensureDir(knowledgeDir());
  ensureDir(projectsRoot);
}

/**
 * Migração única: copia dados antigos de ~/AIChatPortal para portal-data/
 * na primeira vez que o portal roda com o repo aberto.
 */
function migrateLegacyData(): void {
  const target = dataRoot();
  const marker = path.join(target, '.migrated');
  if (fs.existsSync(marker)) return;
  ensureDir(target);
  const pairs: Array<[string, string]> = [
    [path.join(GLOBAL_ROOT, 'sessions'), path.join(target, 'sessions')],
    [path.join(GLOBAL_ROOT, 'skills'), path.join(target, 'skills')],
    [path.join(GLOBAL_ROOT, 'projects'), path.join(target, 'projects')],
    [path.join(GLOBAL_ROOT, 'agents.json'), path.join(target, 'agents.json')],
  ];
  for (const [from, to] of pairs) {
    try {
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.cpSync(from, to, { recursive: true });
      }
    } catch {
      // migração é melhor-esforço; dados antigos continuam em ~/AIChatPortal
    }
  }
  fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
}

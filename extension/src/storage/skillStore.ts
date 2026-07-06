import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Skill, SkillWithContent } from '@aiportal/shared';
import { slugifyCommand } from '@aiportal/shared';
import { readJson, writeJsonAtomic, deleteFile } from './jsonStore';
import { PROJECT_META_DIR, skillsDir, ensureDir } from './paths';
import { getProject, listProjects, projectDir } from './projectStore';

/**
 * Toda skill vale das duas formas: injetada no contexto quando ativa E
 * invocável por /comando. Skills antigas (sem command) ganham um derivado
 * do nome na leitura; o campo kind é legado e ignorado.
 *
 * FORMATO NO DISCO: cada skill é uma PASTA (nome = slug do comando) com
 *   skill.json  — metadados (Skill)
 *   SKILL.md    — o conteúdo markdown
 *   …outros arquivos/subpastas = ANEXOS da skill (referências, templates),
 *   listados em SkillWithContent.files e lidos pelo modelo via
 *   portal_read_skill_file.
 * O formato antigo (<id>.json + <id>.md soltos na raiz) é migrado
 * automaticamente na primeira leitura de cada diretório.
 */

const META_FILE = 'skill.json';
const CONTENT_FILE = 'SKILL.md';
/** Teto de anexos listados por skill (proteção contra pastas gigantes). */
const MAX_ASSET_FILES = 200;

function normalizeSkill(skill: Skill): Skill {
  return { ...skill, command: skill.command || slugifyCommand(skill.name) };
}

function skillsDirFor(scope: 'global' | 'project', projectId?: string): string | undefined {
  if (scope === 'global') return skillsDir();
  if (!projectId) return undefined;
  const project = getProject(projectId);
  if (!project) return undefined;
  return path.join(projectDir(project), PROJECT_META_DIR, 'skills');
}

/** Bases onde skills podem morar: global + a de cada projeto. */
function allSkillBases(): string[] {
  const bases = [skillsDir()];
  for (const project of listProjects()) {
    bases.push(path.join(projectDir(project), PROJECT_META_DIR, 'skills'));
  }
  return bases;
}

/**
 * Pasta única para a skill dentro da base: slug do comando (legível no disco);
 * colisão com pasta de OUTRA skill ganha sufixo -2, -3…
 */
function uniqueFolderFor(base: string, meta: Pick<Skill, 'id' | 'name' | 'command'>): string {
  const slug = slugifyCommand(meta.command || meta.name) || meta.id;
  let candidate = path.join(base, slug);
  for (let i = 2; ; i++) {
    if (!fs.existsSync(candidate)) return candidate;
    const existing = readJson<Skill>(path.join(candidate, META_FILE));
    if (existing?.id === meta.id) return candidate;
    candidate = path.join(base, `${slug}-${i}`);
  }
}

/** Migra o formato antigo (<id>.json + <id>.md soltos) para pasta por skill. */
function migrateLegacyPairs(base: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const legacyMeta = path.join(base, entry.name);
    const meta = readJson<Skill>(legacyMeta);
    if (!meta?.id) continue;
    try {
      const folder = uniqueFolderFor(base, meta);
      ensureDir(folder);
      writeJsonAtomic(path.join(folder, META_FILE), meta);
      const legacyMd = path.join(base, entry.name.replace(/\.json$/, '.md'));
      try {
        fs.renameSync(legacyMd, path.join(folder, CONTENT_FILE));
      } catch {
        // skill antiga sem conteúdo — segue só com os metadados
      }
      deleteFile(legacyMeta);
    } catch {
      // melhor-esforço: um par problemático não pode travar a listagem
    }
  }
}

/** Pastas de skill (com skill.json) dentro da base, migrando o legado antes. */
function skillFoldersIn(base: string): string[] {
  migrateLegacyPairs(base);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(base, e.name, META_FILE)))
    .map((e) => path.join(base, e.name));
}

function readSkillsIn(base: string): Skill[] {
  const skills: Skill[] = [];
  for (const folder of skillFoldersIn(base)) {
    const skill = readJson<Skill>(path.join(folder, META_FILE));
    if (skill?.id) skills.push(normalizeSkill(skill));
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

/** Todas as skills: globais + as de todos os projetos (catálogo completo do portal). */
export function listAllSkills(): Skill[] {
  const skills: Skill[] = [];
  for (const base of allSkillBases()) skills.push(...readSkillsIn(base));
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Pasta da skill com este id (procura na base global e nas dos projetos). */
function findSkillFolder(id: string): string | undefined {
  for (const base of allSkillBases()) {
    for (const folder of skillFoldersIn(base)) {
      if (readJson<Skill>(path.join(folder, META_FILE))?.id === id) return folder;
    }
  }
  return undefined;
}

/** Caminho absoluto da pasta da skill, para abrir no gerenciador de arquivos. */
export function skillFolderPath(id: string): string | undefined {
  return findSkillFolder(id);
}

/** Anexos da pasta (tudo além de skill.json/SKILL.md), como caminhos relativos com /. */
function listAssetsIn(folder: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_ASSET_FILES) return;
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile() && rel !== META_FILE && rel !== CONTENT_FILE) {
        files.push(rel);
      }
    }
  };
  walk(folder, '');
  return files.sort();
}

export function getSkill(id: string): SkillWithContent | undefined {
  const folder = findSkillFolder(id);
  if (!folder) return undefined;
  const meta = readJson<Skill>(path.join(folder, META_FILE));
  if (!meta) return undefined;
  let content = '';
  try {
    content = fs.readFileSync(path.join(folder, CONTENT_FILE), 'utf8');
  } catch {
    // skill sem conteúdo ainda
  }
  const files = listAssetsIn(folder);
  return { ...normalizeSkill(meta), content, files: files.length ? files : undefined };
}

function writeSkillTo(base: string, skill: Skill, content: string): void {
  const folder = uniqueFolderFor(base, skill);
  ensureDir(folder);
  writeJsonAtomic(path.join(folder, META_FILE), skill);
  fs.writeFileSync(path.join(folder, CONTENT_FILE), content, 'utf8');
}

export function createSkill(input: {
  scope: 'global' | 'project';
  projectId?: string;
  name: string;
  description: string;
  command?: string;
  content: string;
  importedFrom?: string;
}): SkillWithContent | undefined {
  const base = skillsDirFor(input.scope, input.projectId);
  if (!base) return undefined;
  ensureDir(base);
  const now = new Date().toISOString();
  const skill: Skill = {
    id: crypto.randomUUID(),
    scope: input.scope,
    projectId: input.scope === 'project' ? input.projectId : undefined,
    name: input.name,
    description: input.description,
    command: input.command || slugifyCommand(input.name),
    importedFrom: input.importedFrom,
    createdAt: now,
    updatedAt: now,
  };
  writeSkillTo(base, skill, input.content);
  return { ...skill, content: input.content };
}

export function updateSkill(
  id: string,
  patch: Partial<Pick<SkillWithContent, 'name' | 'description' | 'command' | 'content'>>,
): SkillWithContent | undefined {
  const folder = findSkillFolder(id);
  if (!folder) return undefined;
  const existing = readJson<Skill>(path.join(folder, META_FILE));
  if (!existing) return undefined;
  const { content, ...metaPatch } = patch;
  const updated: Skill = { ...existing, ...metaPatch, updatedAt: new Date().toISOString() };
  if (!updated.command) updated.command = slugifyCommand(updated.name);
  // a pasta mantém o nome original mesmo se o comando mudar: renomear
  // quebraria referências externas e o nome da pasta é só cosmético
  writeJsonAtomic(path.join(folder, META_FILE), updated);
  if (content !== undefined) {
    fs.writeFileSync(path.join(folder, CONTENT_FILE), content, 'utf8');
  }
  return getSkill(id);
}

export function deleteSkill(id: string): boolean {
  const folder = findSkillFolder(id);
  if (!folder) return false;
  fs.rmSync(folder, { recursive: true, force: true });
  return true;
}

/** Cria ou atualiza uma skill com id fixo (integrações idempotentes, ex: BMAD). */
export function upsertSkillWithId(
  id: string,
  input: {
    scope: 'global' | 'project';
    projectId?: string;
    name: string;
    description: string;
    command?: string;
    content: string;
  },
): SkillWithContent | undefined {
  const base = skillsDirFor(input.scope, input.projectId);
  if (!base) return undefined;
  ensureDir(base);
  migrateLegacyPairs(base);
  const existingFolder = findSkillFolder(id);
  const existing = existingFolder
    ? readJson<Skill>(path.join(existingFolder, META_FILE))
    : undefined;
  const now = new Date().toISOString();
  const skill: Skill = {
    id,
    scope: input.scope,
    projectId: input.scope === 'project' ? input.projectId : undefined,
    name: input.name,
    description: input.description,
    command: input.command || slugifyCommand(input.name),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (existingFolder) {
    writeJsonAtomic(path.join(existingFolder, META_FILE), skill);
    fs.writeFileSync(path.join(existingFolder, CONTENT_FILE), input.content, 'utf8');
  } else {
    writeSkillTo(base, skill, input.content);
  }
  return { ...skill, content: input.content };
}

// --- Anexos da skill (arquivos além do SKILL.md) ------------------------------

/** Resolve um caminho relativo DENTRO da pasta da skill (bloqueia traversal e os arquivos reservados). */
function resolveAsset(folder: string, rel: string): string | undefined {
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean) return undefined;
  const target = path.resolve(folder, clean);
  const root = path.resolve(folder);
  if (target !== root && !target.startsWith(root + path.sep)) return undefined;
  if (clean === META_FILE || clean === CONTENT_FILE) return undefined;
  return target;
}

const ASSET_READ_LIMIT = 256 * 1024;

/** Lê um anexo como texto (para o modelo). Retorna undefined se não existir/for inválido. */
export function readSkillAsset(id: string, rel: string): string | undefined {
  const folder = findSkillFolder(id);
  if (!folder) return undefined;
  const target = resolveAsset(folder, rel);
  if (!target) return undefined;
  try {
    const raw = fs.readFileSync(target);
    const text = raw.subarray(0, ASSET_READ_LIMIT).toString('utf8');
    return raw.length > ASSET_READ_LIMIT ? `${text}\n… (arquivo truncado)` : text;
  } catch {
    return undefined;
  }
}

/** Lê um anexo com os bytes originais (export em zip — sem truncar). */
export function readSkillAssetRaw(id: string, rel: string): Buffer | undefined {
  const folder = findSkillFolder(id);
  if (!folder) return undefined;
  const target = resolveAsset(folder, rel);
  if (!target) return undefined;
  try {
    return fs.readFileSync(target);
  } catch {
    return undefined;
  }
}

/** Grava um anexo (upload da UI). Cria subpastas do caminho se preciso. */
export function writeSkillAsset(id: string, rel: string, data: Buffer): boolean {
  const folder = findSkillFolder(id);
  if (!folder) return false;
  const target = resolveAsset(folder, rel);
  if (!target) return false;
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, data);
  return true;
}

export function deleteSkillAsset(id: string, rel: string): boolean {
  const folder = findSkillFolder(id);
  if (!folder) return false;
  const target = resolveAsset(folder, rel);
  if (!target || !fs.existsSync(target)) return false;
  fs.rmSync(target, { force: true });
  // remove subpastas que ficaram vazias (até a raiz da skill)
  let dir = path.dirname(target);
  const root = path.resolve(folder);
  while (dir !== root) {
    try {
      fs.rmdirSync(dir);
    } catch {
      break; // não vazia (ou inacessível) — para
    }
    dir = path.dirname(dir);
  }
  return true;
}

const SKILL_CREATOR_ID = 'skill-creator';
const SEED_VERSION = 'v5';

/*
 * Não documentar o marcador de input com as chaves literais aqui: o
 * expandSlashCommand substitui TODAS as ocorrências no conteúdo. A sintaxe
 * exata já está descrita no schema da ferramenta portal_create_skill.
 * (O SKILL.md original embarcado não contém o marcador — verificado.)
 */
const SKILL_CREATOR_ADAPTER = `Você vai criar (ou melhorar) uma skill do AI Product BMAD Chat seguindo o skill-creator da Anthropic. Abaixo está o SKILL.md original, embarcado verbatim (fonte: github.com/anthropics/skills, Apache-2.0). Siga o método dele com estas adaptações obrigatórias deste ambiente, que prevalecem sobre o SKILL.md:

- **Registro**: o produto final NÃO é uma pasta criada à mão no disco. Ao terminar o rascunho, registre com a ferramenta portal_create_skill: o name e a description que você escreveria no frontmatter viram os campos name/description; o corpo do SKILL.md vira o campo content (markdown). Nunca crie a skill como arquivo solto com portal_write_file.
- **Modelo único**: toda skill funciona das duas formas ao mesmo tempo — o conteúdo é injetado no contexto quando a skill está ativa no menu Skills E pode ser invocado por /comando no chat (campo command; se omitido, é derivado do nome). Não existe escolha de tipo.
- **Sem subagentes nem scripts**: este ambiente não executa os scripts/ do skill-creator nem cria subagentes. Siga a seção "Claude.ai-specific instructions" do SKILL.md: rode os testes você mesmo, sequencialmente, nesta conversa, e pule benchmarking e otimização automatizada de description.
- **Recursos empacotados** (references/, assets/): cada skill do portal É uma pasta e aceita anexos — mas quem anexa é o usuário, pela página Skills (editar skill → Anexos). Se a skill precisar de material de apoio, inclua-o no content ou oriente o usuário a anexá-lo; o conteúdo deve citar os anexos pelo caminho, e o modelo os lê com a ferramenta portal_read_skill_file.

---

`;

const SKILL_CREATOR_FOOTER = `

---

Pedido do usuário: {{input}}`;

/**
 * Seed por data root do comando global /criar-skill, com o SKILL.md oficial
 * (passado pelo activate a partir de extension/assets) entre o adaptador e o
 * footer. O marker guarda a versão do seed: mudou a versão, o conteúdo é
 * reescrito; na mesma versão, exclusão ou edição do usuário são respeitadas.
 */
export function seedDefaultSkills(skillCreatorMd: string | undefined): void {
  ensureDir(skillsDir());
  const marker = path.join(skillsDir(), '.seeded');
  if (!skillCreatorMd) return; // asset ausente: não semeia nem queima a versão
  let seeded: string | undefined;
  try {
    seeded = fs.readFileSync(marker, 'utf8').trim();
  } catch {
    // primeiro seed neste data root
  }
  if (seeded === SEED_VERSION) return;
  upsertSkillWithId(SKILL_CREATOR_ID, {
    scope: 'global',
    name: 'Criar skill (skill-creator)',
    description:
      'Cria skills seguindo o skill-creator oficial da Anthropic (SKILL.md embarcado). Use: /criar-skill descrevendo o que a skill deve fazer.',
    command: 'criar-skill',
    content: SKILL_CREATOR_ADAPTER + skillCreatorMd.trim() + SKILL_CREATOR_FOOTER,
  });
  fs.writeFileSync(marker, SEED_VERSION, 'utf8');
}

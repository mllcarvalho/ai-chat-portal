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
 */
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
  const skills = readSkillsIn(skillsDir());
  for (const project of listProjects()) {
    skills.push(...readSkillsIn(path.join(projectDir(project), PROJECT_META_DIR, 'skills')));
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
  return { ...normalizeSkill(meta), content };
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
  const dir = skillsDirFor(input.scope, input.projectId);
  if (!dir) return undefined;
  ensureDir(dir);
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
  if (!updated.command) updated.command = slugifyCommand(updated.name);
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
  const dir = skillsDirFor(input.scope, input.projectId);
  if (!dir) return undefined;
  ensureDir(dir);
  const existing = readJson<Skill>(path.join(dir, `${id}.json`));
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
  writeJsonAtomic(path.join(dir, `${id}.json`), skill);
  fs.writeFileSync(path.join(dir, `${id}.md`), input.content, 'utf8');
  return { ...skill, content: input.content };
}

const SKILL_CREATOR_ID = 'skill-creator';
const SEED_VERSION = 'v3';

/*
 * Não documentar o marcador de input com as chaves literais aqui: o
 * expandSlashCommand substitui TODAS as ocorrências no conteúdo. A sintaxe
 * exata já está descrita no schema da ferramenta portal_create_skill.
 * (O SKILL.md original embarcado não contém o marcador — verificado.)
 */
const SKILL_CREATOR_ADAPTER = `Você vai criar (ou melhorar) uma skill do AI Chat Portal seguindo o skill-creator da Anthropic. Abaixo está o SKILL.md original, embarcado verbatim (fonte: github.com/anthropics/skills, Apache-2.0). Siga o método dele com estas adaptações obrigatórias deste ambiente, que prevalecem sobre o SKILL.md:

- **Registro**: o produto final NÃO é uma pasta com SKILL.md no disco. Ao terminar o rascunho, registre com a ferramenta portal_create_skill: o name e a description que você escreveria no frontmatter viram os campos name/description; o corpo do SKILL.md vira o campo content (markdown). Nunca crie a skill como arquivo solto com portal_write_file.
- **Modelo único**: toda skill funciona das duas formas ao mesmo tempo — o conteúdo é injetado no contexto quando a skill está ativa no menu Skills E pode ser invocado por /comando no chat (campo command; se omitido, é derivado do nome). Não existe escolha de tipo.
- **Sem subagentes nem scripts**: este ambiente não executa os scripts/ do skill-creator nem cria subagentes. Siga a seção "Claude.ai-specific instructions" do SKILL.md: rode os testes você mesmo, sequencialmente, nesta conversa, e pule benchmarking e otimização automatizada de description.
- **Recursos empacotados** (scripts/, references/, assets/) não existem no formato do portal: se a skill precisar de material de apoio, inclua-o no próprio content ou em arquivos do projeto referenciados pelo content.

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
  const now = new Date().toISOString();
  const skill: Skill = {
    id: SKILL_CREATOR_ID,
    scope: 'global',
    name: 'Criar skill (skill-creator)',
    description:
      'Cria skills seguindo o skill-creator oficial da Anthropic (SKILL.md embarcado). Use: /criar-skill descrevendo o que a skill deve fazer.',
    command: 'criar-skill',
    createdAt: now,
    updatedAt: now,
  };
  writeJsonAtomic(path.join(skillsDir(), `${SKILL_CREATOR_ID}.json`), skill);
  fs.writeFileSync(
    path.join(skillsDir(), `${SKILL_CREATOR_ID}.md`),
    SKILL_CREATOR_ADAPTER + skillCreatorMd.trim() + SKILL_CREATOR_FOOTER,
    'utf8',
  );
  fs.writeFileSync(marker, SEED_VERSION, 'utf8');
}

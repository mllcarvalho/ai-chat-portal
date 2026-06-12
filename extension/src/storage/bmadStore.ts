import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BMAD_ASSET_PREFIX, type BmadStatus } from '@aiportal/shared';
import { bmadRootDir, ensureDir, isBmadInstalled } from './paths';
import { deleteAgent, listAgents, upsertAgentWithId } from './agentStore';
import { deleteSkill, listAllSkills, upsertSkillWithId } from './skillStore';
import { getPython, shellAvailable } from '../tools/envCheck';

/**
 * Integração BMAD (bmad-method): instalação GLOBAL em <dataRoot>/bmad,
 * compartilhada por todos os projetos. Os agentes leem workflows e templates
 * pela ferramenta bmad_read_file; os documentos gerados são gravados com
 * portal_write_file em _bmad-output/ do projeto da conversa.
 *
 * O instalador gera SKILL.md em .agents/skills/bmad-… e daí registramos:
 *  - personas (bmad-agent-…) como presets de agente, escolhíveis no header do chat;
 *  - as demais skills como skills GLOBAIS, invocáveis por /comando em qualquer chat.
 */

const SKILLS_SUBDIR = path.join('.agents', 'skills');
const PRESET_PREFIX = BMAD_ASSET_PREFIX;

interface InstallState {
  installing: boolean;
  error?: string;
  log: string;
}

let install: InstallState | undefined;
let registeredThisSession = false;

const PERSONA_ICONS: Record<string, string> = {
  'bmad-agent-analyst': '📊',
  'bmad-agent-architect': '🏛️',
  'bmad-agent-dev': '💻',
  'bmad-agent-pm': '📋',
  'bmad-agent-tech-writer': '✍️',
  'bmad-agent-ux-designer': '🎨',
};

function parseSkillMd(file: string): { description: string; title?: string; body: string } | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  let body = raw;
  let description = '';
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (fm) {
    body = raw.slice(fm[0].length);
    const desc = /^description\s*:\s*(['"]?)([\s\S]*?)\1\s*$/m.exec(fm[1]);
    if (desc) description = desc[2].trim();
  }
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  return { description, title, body: body.trim() };
}

function adapterFor(skillFolder: string): string {
  // verifica AGORA quais overrides existem, para o agente não sondar às cegas
  const overrides = ['.toml', '.user.toml']
    .map((suffix) => `_bmad/custom/${skillFolder}${suffix}`)
    .filter((rel) => fs.existsSync(path.join(bmadRootDir(), rel)));
  const overridesNote = overrides.length
    ? `Overrides desta skill que EXISTEM e devem entrar no merge: ${overrides
        .map((rel) => `bmad_read_file "${rel}"`)
        .join(' e ')}. `
    : `Os overrides _bmad/custom/${skillFolder}.toml e ${skillFolder}.user.toml NÃO existem nesta ` +
      `instalação — NÃO tente lê-los (nem com bmad_read_file nem com portal_read_file); ` +
      `siga direto com o customize.toml da skill. `;
  // a skill em si fica intocada: o que muda conforme o ambiente é só esta nota
  // sobre COMO executar os comandos que ela pede (e o fallback quando não dá)
  const python = getPython();
  // em comandos de terminal os placeholders precisam virar caminho REAL da
  // instalação global (os scripts ficam lá, não na pasta da conversa); com /
  // mesmo no Windows, que é o que o Git Bash e o python aceitam sem susto
  const absRoot = bmadRootDir().split(path.sep).join('/');
  const commandPathsNote =
    `Nos COMANDOS de terminal (diferente das leituras), troque os placeholders por caminhos absolutos ` +
    `da instalação BMAD entre aspas: {project-root} → "${absRoot}" e {skill-root} → ` +
    `"${absRoot}/.agents/skills/${skillFolder}". Ex: python3 "${absRoot}/_bmad/scripts/resolve_customization.py" ` +
    `--skill "${absRoot}/.agents/skills/${skillFolder}" --key workflow. `;
  const commandsNote = !shellAvailable()
    ? `Não há shell nesta máquina: pule qualquer comando de terminal (inclusive \`python3 …\`) e use o ` +
      `fallback manual descrito na skill (ex: ler e mesclar os .toml com bmad_read_file).`
    : python
      ? `Comandos de terminal da skill (inclusive python): execute-os com portal_run_command — o usuário ` +
        `aprova cada um na interface. ` +
        commandPathsNote +
        `Python disponível como \`${python.cmd}\`. Se um comando falhar ou for negado, NÃO insista: ` +
        `use o fallback manual descrito na skill (ex: ler e mesclar os .toml com bmad_read_file).`
      : `Comandos de shell da skill: execute-os com portal_run_command (o usuário aprova cada um). ` +
        commandPathsNote +
        `Python NÃO está instalado: pule comandos \`python3 …\` e vá direto ao fallback manual descrito ` +
        `na skill (ex: ler e mesclar os .toml com bmad_read_file).`;
  return (
    `> **Adaptação ao AI Product BMAD Chat** — esta skill BMAD usa a instalação global compartilhada. ` +
    `Materiais do BMAD (workflows, templates, configs): leia com bmad_read_file / bmad_list_files, ` +
    `com caminhos relativos à raiz do BMAD. Mapeie os placeholders: {skill-root} → ${SKILLS_SUBDIR}/${skillFolder}; ` +
    `caminhos "bare" (ex: references/x.md) → ${SKILLS_SUBDIR}/${skillFolder}/<caminho>; ` +
    `qualquer referência a _bmad/… → bmad_read_file com esse mesmo caminho, MESMO quando escrita como ` +
    `{project-root}/_bmad/… (a instalação é global; a pasta do projeto NÃO tem _bmad/). ` +
    `Ex: config → bmad_read_file "_bmad/bmm/config.yaml". ` +
    overridesNote +
    `Documentos do trabalho ({project-root}, {output_folder}, _bmad-output/…): use portal_read_file / portal_write_file ` +
    `na pasta de trabalho da conversa — saídas vão em _bmad-output/ (ex: _bmad-output/planning-artifacts/prd.md). ` +
    `Conversas fora de projeto também têm pasta de trabalho (o workspace da conversa); use-a do mesmo jeito. ` +
    commandsNote +
    `\n\n`
  );
}

function bmadSkillFolders(): string[] {
  try {
    return fs
      .readdirSync(path.join(bmadRootDir(), SKILLS_SUBDIR), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('bmad-'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Remove presets/skills da época em que o BMAD era instalado por projeto. */
function cleanupLegacyPerProjectAssets(): void {
  const legacy = /^bmad-[0-9a-f]{8}-/;
  for (const agent of listAgents()) {
    if (legacy.test(agent.id)) deleteAgent(agent.id);
  }
  for (const skill of listAllSkills()) {
    if (legacy.test(skill.id)) deleteSkill(skill.id);
  }
}

/** (Re)registra personas como agentes globais e workflows como skills globais. */
export function registerBmadAssets(): { agents: number; skills: number } {
  cleanupLegacyPerProjectAssets();
  let agents = 0;
  let skills = 0;
  for (const folder of bmadSkillFolders()) {
    const parsed = parseSkillMd(path.join(bmadRootDir(), SKILLS_SUBDIR, folder, 'SKILL.md'));
    if (!parsed) continue;
    const content = adapterFor(folder) + parsed.body;
    if (folder.startsWith('bmad-agent-')) {
      upsertAgentWithId(PRESET_PREFIX + folder, {
        name: `${parsed.title ?? folder} (BMAD)`,
        icon: PERSONA_ICONS[folder] ?? '🅱️',
        description: parsed.description,
        instructions: content,
        defaultMode: 'agent',
      });
      agents++;
    } else {
      upsertSkillWithId(PRESET_PREFIX + folder, {
        scope: 'global',
        name: parsed.title ?? folder,
        description: parsed.description,
        command: folder,
        content,
      });
      skills++;
    }
  }
  return { agents, skills };
}

export function getBmadStatus(): BmadStatus {
  const installed = isBmadInstalled();
  const folders = bmadSkillFolders();
  // cobre instalações feitas por fora (npx no terminal): registra na primeira consulta
  if (installed && !install?.installing && !registeredThisSession) {
    registeredThisSession = true;
    try {
      registerBmadAssets();
    } catch {
      // melhor-esforço; o install via UI re-registra
    }
  }
  const agents = folders
    .filter((f) => f.startsWith('bmad-agent-'))
    .map((folder) => {
      const parsed = parseSkillMd(path.join(bmadRootDir(), SKILLS_SUBDIR, folder, 'SKILL.md'));
      return {
        presetId: PRESET_PREFIX + folder,
        name: parsed?.title ?? folder,
        description: parsed?.description,
        icon: PERSONA_ICONS[folder] ?? '🅱️',
      };
    });
  return {
    installed,
    installing: install?.installing ?? false,
    error: install?.error,
    agents,
    skillCount: folders.length - agents.length,
  };
}

/** Roda `npx bmad-method install` na instalação global (assíncrono). */
export function startBmadInstall(): BmadStatus {
  if (install?.installing) return getBmadStatus();

  const dir = bmadRootDir();
  ensureDir(dir);
  const state: InstallState = { installing: true, log: '' };
  install = state;

  const args = [
    '-y',
    'bmad-method@latest',
    'install',
    '--directory',
    dir,
    '--modules',
    'bmm',
    '--tools',
    'github-copilot',
    '-y',
    '--output-folder',
    '_bmad-output',
    '--communication-language',
    'Português (Brasil)',
    '--document-output-language',
    'Português (Brasil)',
  ];
  const child = spawn('npx', args, {
    cwd: dir,
    env: process.env,
    shell: process.platform === 'win32',
  });
  const append = (chunk: Buffer) => {
    state.log = (state.log + chunk.toString()).slice(-4000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.on('error', (err) => {
    state.installing = false;
    state.error = `Falha ao executar npx: ${err.message}. Rode manualmente: npx bmad-method install (em portal-data/bmad).`;
  });
  child.on('close', (code) => {
    state.installing = false;
    if (code === 0) {
      try {
        const result = registerBmadAssets();
        registeredThisSession = true;
        state.error = undefined;
        state.log += `\nRegistrados ${result.agents} agentes e ${result.skills} skills no portal.`;
      } catch (err) {
        state.error = `Instalado, mas falhou ao registrar no portal: ${(err as Error).message}`;
      }
    } else if (!state.error) {
      const tail = state.log.split('\n').slice(-6).join('\n');
      state.error = `Instalador saiu com código ${code}. Última saída:\n${tail}`;
    }
  });

  return getBmadStatus();
}

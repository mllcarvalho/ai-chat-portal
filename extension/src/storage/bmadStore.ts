import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BMAD_ASSET_PREFIX, type BmadStatus } from '@aiportal/shared';
import { bmadRootDir, ensureDir, isBmadInstalled } from './paths';
import { deleteAgent, getAgent, listAgents, upsertAgentWithId } from './agentStore';
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

/**
 * Versão FIXADA do bmad-method. Não usar @latest: um novo release pode mudar a
 * CLI do `install` (flags, argumentos) e quebrar o instalador do portal sem aviso.
 * Ao subir esta versão, revalide os args de startBmadInstall com `install --help`.
 */
const BMAD_VERSION = '6.9.0';

interface InstallState {
  installing: boolean;
  error?: string;
  log: string;
}

let install: InstallState | undefined;
let registeredThisSession = false;

/**
 * Personas habilitadas por default no primeiro registro: Analista de negócio,
 * PM e UX Designer. As demais ficam desabilitadas, com toggle nas
 * Configurações — e o que o usuário escolher lá é preservado nos re-registros.
 */
const DEFAULT_ENABLED_PERSONAS = new Set([
  'bmad-agent-analyst',
  'bmad-agent-pm',
  'bmad-agent-ux-designer',
]);

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
    `Pesquisa na web: EXISTE neste ambiente — instruções de "web search" (ex: "Search the web: X") viram ` +
    `portal_web_search (descobre as fontes) + portal_fetch_url (lê a página); cite as URLs reais dos resultados, ` +
    `nunca uma URL que você não abriu. Alguns sites são bloqueados na rede: se um falhar, siga para outro resultado. ` +
    `Subagentes ("spawn/launch subagents", subprocesses): use portal_spawn_subagent — chamadas na mesma rodada ` +
    `rodam em paralelo. Os subagentes do portal SÓ LEEM: quando a skill mandar um subagente ESCREVER um arquivo ` +
    `(ex: review-*.md, artefatos em .working/), peça o conteúdo como resposta do subagente e grave você mesmo ` +
    `com portal_write_file. ` +
    `Artefatos visuais: NÃO há navegador no servidor (webbrowser.open não existe) — mas arquivos .html e ` +
    `.excalidraw gravados têm preview embutido no painel Arquivos da conversa, e diagramas Mermaid renderizam ` +
    `nos balões do chat e nos .md; em vez de "abrir no navegador", diga ao usuário para clicar no arquivo no ` +
    `painel Arquivos. ` +
    commandsNote +
    `\n\n`
  );
}

/**
 * Roster de personas para o party mode: as mesmas 4 camadas que o
 * resolve_config.py mescla (base → base.user → custom → custom.user), lidas
 * direto para não depender de python na ativação da skill.
 */
function bmadAgentRoster(): Array<{
  code: string;
  name: string;
  title: string;
  icon: string;
  description: string;
}> {
  const merged = new Map<string, Record<string, string>>();
  const layers = [
    'config.toml',
    'config.user.toml',
    path.join('custom', 'config.toml'),
    path.join('custom', 'config.user.toml'),
  ];
  for (const rel of layers) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(bmadRootDir(), '_bmad', rel), 'utf8');
    } catch {
      continue;
    }
    let current: Record<string, string> | undefined;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      const section = /^\[agents\.([^\]]+)\]$/.exec(trimmed);
      if (section) {
        current = merged.get(section[1]) ?? {};
        merged.set(section[1], current);
        continue;
      }
      if (trimmed.startsWith('[')) {
        current = undefined;
        continue;
      }
      if (!current) continue;
      const kv = /^(\w+)\s*=\s*"(.*)"\s*$/.exec(trimmed);
      if (kv) current[kv[1]] = kv[2];
    }
  }
  return [...merged.entries()]
    .filter(([code]) => {
      // respeita o toggle das Configurações do portal: persona registrada como
      // agente e desabilitada fica fora do roster (codes sem preset — ex.
      // agentes custom só do BMAD — continuam entrando)
      const preset = getAgent(PRESET_PREFIX + code);
      return !preset || preset.enabled !== false;
    })
    .map(([code, v]) => ({
      code,
      name: v.name ?? code,
      title: v.title ?? '',
      icon: v.icon ?? '🅱️',
      description: v.description ?? '',
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * Nota extra da skill bmad-party-mode: mapeia a orquestração (pensada para o
 * Agent tool do Claude Code) para portal_spawn_subagent e embute o roster já
 * resolvido, para a discussão funcionar igual ao BMAD tradicional.
 */
function partyModeAdapter(): string {
  const roster = bmadAgentRoster();
  if (!roster.length) {
    return (
      `> **Party mode no AI Product BMAD Chat** — NENHUMA persona BMAD está habilitada nas ` +
      `Configurações do portal, então não há roster para a discussão. NÃO invente personas: avise o ` +
      `usuário que o party mode precisa de agentes habilitados e peça para ele ativar as personas ` +
      `desejadas em Configurações → Agentes BMAD antes de tentar de novo.\n\n`
    );
  }
  const rosterLines = roster
    .map((a) => `> - ${a.icon} **${a.name}** — ${a.title} (\`${a.code}\`): ${a.description}`)
    .join('\n');
  return (
    `> **Party mode no AI Product BMAD Chat** — mapeie a orquestração desta skill assim: o "Agent tool" ` +
    `é a ferramenta portal_spawn_subagent. UMA chamada por persona escolhida na rodada, todas na MESMA ` +
    `resposta (rodam em paralelo). Em cada chamada: label = "{icon} {name}" e task = o prompt do template ` +
    `da skill JÁ PREENCHIDO (persona, contexto da discussão, o que os outros agentes disseram quando for ` +
    `reação, mensagem do usuário e guidelines). Os subagentes NÃO veem a conversa nem uns aos outros — tudo ` +
    `precisa ir na task; não use personaPath nem personaAgent aqui (a persona vai no próprio template). ` +
    `Cada resposta de subagente já aparece como um balão próprio no chat, identificado pelo label: NÃO ` +
    `repita nem resuma as respostas no seu texto — no máximo a "Orchestrator Note" curta. Pule o passo do ` +
    `resolve_config.py: o roster já resolvido está abaixo. O flag --model vira o parâmetro modelId do ` +
    `subagente; --solo funciona como descrito na skill. Ao preencher os templates, identifique o ` +
    `usuário pelo nome dado nas instruções da conversa (o RACF) — se as instruções não derem nome, ` +
    `as personas cumprimentam SEM nome (nunca inventam um).\n>\n` +
    `> Roster resolvido (SOMENTE estes agentes participam — a lista já reflete as personas habilitadas ` +
    `nas Configurações do portal; use name/title/icon/description no template de cada agente):\n` +
    `${rosterLines}\n\n`
  );
}

/** As 3 skills de research exigem web search como pré-requisito hard ("abort if unavailable"). */
const RESEARCH_NOTE =
  `> **Web search neste ambiente** — o pré-requisito de web search desta skill é ATENDIDO pela ferramenta ` +
  `portal_web_search: NÃO aborte na ativação. Fluxo: portal_web_search para cada busca que os steps pedirem, ` +
  `portal_fetch_url para ler as fontes relevantes, e cite as URLs REAIS dos resultados — nunca preencha ` +
  `"_Source: [URL]_" com uma URL que você não abriu. Sites bloqueados pela rede corporativa: troque de fonte. ` +
  `Dado que não conseguir verificar em fonte viva entra como "[SUPOSIÇÃO — não verificada]", nunca como fato ` +
  `com fonte.\n\n`;

/**
 * Notas de adaptação por skill, prefixadas depois do adapter genérico: cobrem
 * mecânicas que a skill descreve em termos do Claude Code e que no portal têm
 * outra tradução (ou fallback) — sem tocar no corpo da skill.
 */
const SKILL_ADAPTER_NOTES: Record<string, () => string> = {
  'bmad-party-mode': partyModeAdapter,
  'bmad-market-research': () => RESEARCH_NOTE,
  'bmad-domain-research': () => RESEARCH_NOTE,
  'bmad-technical-research': () => RESEARCH_NOTE,
  'bmad-shard-doc': () =>
    `> **Fallback do shard neste ambiente** — se o npx do @kayvan/markdown-tree-parser não existir ou o ` +
    `comando for negado, NÃO dê HALT: faça o shard manualmente, replicando o explode — leia o documento com ` +
    `portal_read_file, divida nas seções de nível 2 (##), grave cada seção como arquivo próprio (nome ` +
    `kebab-case do título) com portal_write_file e gere o index.md com os links.\n\n`,
  'bmad-customize': () =>
    `> **Persistência dos overrides neste ambiente** — grave os arquivos de customização com a ferramenta ` +
    `bmad_write_custom (caminhos _bmad/custom/<skill>.toml ou <skill>.user.toml), NUNCA com portal_write_file: ` +
    `a pasta da conversa não é lida pelas skills na ativação. A instalação BMAD é global, então o override ` +
    `gravado vale para todas as conversas do portal — avise isso ao usuário antes de gravar.\n\n`,
};

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
    const content =
      adapterFor(folder) + (SKILL_ADAPTER_NOTES[folder]?.() ?? '') + parsed.body;
    if (folder.startsWith('bmad-agent-')) {
      const id = PRESET_PREFIX + folder;
      upsertAgentWithId(id, {
        name: `${parsed.title ?? folder} (BMAD)`,
        icon: PERSONA_ICONS[folder] ?? '🅱️',
        description: parsed.description,
        instructions: content,
        defaultMode: 'agent',
        enabled: getAgent(id)?.enabled ?? DEFAULT_ENABLED_PERSONAS.has(folder),
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

/**
 * No Windows precisamos de shell:true para o `npx` (npx.cmd) resolver, mas com
 * shell:true o spawn NÃO cita os itens do array de args — o cmd.exe então quebra
 * valores com espaço/parênteses como "Português (Brasil)" em tokens soltos, que
 * o bmad interpreta como argumentos posicionais ("too many arguments for
 * install: Expected 0 arguments but got 2"). Quando há shell, citamos nós mesmos.
 */
function quoteArg(arg: string): string {
  if (/^[\w@.:/\\-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
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
    `bmad-method@${BMAD_VERSION}`,
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
  const useShell = process.platform === 'win32';
  const child = spawn('npx', useShell ? args.map(quoteArg) : args, {
    cwd: dir,
    env: process.env,
    shell: useShell,
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

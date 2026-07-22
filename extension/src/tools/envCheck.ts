import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvStatus } from '@aiportal/shared';
import { dataRoot } from '../storage/paths';

/**
 * Detecção das dependências externas, feita uma vez na ativação:
 *  - node: obrigatório (instalador BMAD via npx e servidores MCP stdio);
 *  - bash: habilita o portal_run_command (Git Bash no Windows; shell do
 *    usuário no Mac/Linux). Sem ele, execução de comandos fica desativada;
 *  - python: opcional — sem ele o modelo é instruído a pular comandos python.
 */

export interface ShellInfo {
  /** Executável a spawnar (aceita -c "comando"). */
  path: string;
  /** Nome curto para mensagens/prompt (ex: "zsh", "Git Bash"). */
  label: string;
}

export interface PythonInfo {
  /** Comando que respondeu (python3 ou python). */
  cmd: string;
  version: string;
}

interface ResolvedEnv {
  checked: boolean;
  node: string | null;
  shell: ShellInfo | null;
  python: PythonInfo | null;
  /** Versão do uv, se instalado — caminho preferido para scripts com dependências. */
  uv: string | null;
}

const env: ResolvedEnv = { checked: false, node: null, shell: null, python: null, uv: null };

function probe(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: 5000, shell: process.platform === 'win32' },
      (err, stdout, stderr) => {
        if (err) resolve(null);
        else resolve((stdout || stderr).trim().split('\n')[0] || null);
      },
    );
  });
}

/** true se o comando sai com código 0 (para checagens sem saída útil). */
function probeOk(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err) => resolve(!err));
  });
}

/** Candidatos a Python, do preferido ao fallback (no macOS, o python3 do sistema). */
function pythonCandidates(): string[] {
  if (process.platform === 'win32') return ['python3', 'python', 'py'];
  if (process.platform === 'darwin') return ['python3', 'python', '/usr/bin/python3'];
  return ['python3', 'python'];
}

/**
 * Primeiro Python utilizável da máquina: responde --version com versão real
 * (o stub da Microsoft Store não passa) e, fora do Windows, carrega os módulos
 * nativos que o pip usa — um brew desatualizado com pyexpat quebrado derruba
 * qualquer pip/venv e precisa ser pulado.
 */
export async function findHealthyPython(): Promise<PythonInfo | null> {
  for (const cmd of pythonCandidates()) {
    const version = await probe(cmd, ['--version']);
    if (!version || !/^Python \d/.test(version)) continue;
    if (
      process.platform !== 'win32' &&
      !(await probeOk(cmd, ['-c', 'import ssl,zlib,xml.parsers.expat']))
    ) {
      continue;
    }
    return { cmd, version: version.replace(/^Python\s*/, '') };
  }
  return null;
}

/** Venv compartilhado do portal (geração de documentos) — criado sob demanda. */
export function portalVenvDir(): string {
  return path.join(dataRoot(), 'pyenv');
}

export function portalVenvPython(): string {
  return process.platform === 'win32'
    ? path.join(portalVenvDir(), 'Scripts', 'python.exe')
    : path.join(portalVenvDir(), 'bin', 'python');
}

/**
 * "Pacote Office" do portal: bibliotecas pip para gerar .pptx/.xlsx/.docx/.pdf
 * (pandas entra porque o modelo o usa direto para planilhas), e os módulos
 * correspondentes para validar o import — sem espaços, vira argumento de -c.
 */
export const OFFICE_LIBS = [
  'python-pptx',
  'openpyxl',
  'python-docx',
  'reportlab',
  'pandas',
  'pillow',
];
export const OFFICE_IMPORTS = 'pptx,openpyxl,docx,reportlab,pandas,PIL';

function findWindowsBash(): ShellInfo | null {
  const roots = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['LocalAppData'] ? path.join(process.env['LocalAppData'], 'Programs') : undefined,
  ].filter((p): p is string => !!p);
  for (const root of roots) {
    const candidate = path.join(root, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(candidate)) return { path: candidate, label: 'Git Bash' };
  }
  return null;
}

function findPosixShell(): ShellInfo | null {
  const userShell = process.env.SHELL;
  if (userShell && fs.existsSync(userShell)) {
    return { path: userShell, label: path.basename(userShell) };
  }
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (fs.existsSync(candidate)) return { path: candidate, label: path.basename(candidate) };
  }
  return null;
}

export async function checkEnvironment(): Promise<EnvStatus> {
  if (env.checked) return getEnvStatus();

  const [nodeVersion, shell, uvVersion] = await Promise.all([
    probe('node', ['--version']),
    Promise.resolve(process.platform === 'win32' ? findWindowsBash() : findPosixShell()),
    probe('uv', ['--version']),
  ]);
  env.node = nodeVersion;
  env.shell = shell;
  env.uv = uvVersion;

  env.python = await findHealthyPython();
  env.checked = true;
  return getEnvStatus();
}

/** false enquanto a detecção da ativação não terminou (UI não deve avisar). */
export function envCheckDone(): boolean {
  return env.checked;
}

/** Snapshot para o /api/health e para a UI. */
export function getEnvStatus(): EnvStatus {
  return {
    node: env.node,
    bash: env.shell ? (process.platform === 'win32' ? env.shell.path : env.shell.label) : null,
    python: env.python ? `${env.python.cmd} ${env.python.version}` : null,
  };
}

export function getShell(): ShellInfo | null {
  return env.shell;
}

/**
 * Bash para rodar instaladores (Git Bash no Windows; shell do usuário no
 * mac/linux) — funciona mesmo antes de o checkEnvironment da ativação acabar.
 */
export function findBash(): ShellInfo | null {
  if (env.checked && env.shell) return env.shell;
  return process.platform === 'win32' ? findWindowsBash() : findPosixShell();
}

export function shellAvailable(): boolean {
  return !!env.shell;
}

export function getPython(): PythonInfo | null {
  return env.python;
}

/**
 * Bloco para o preâmbulo do chat (modo agent): diz ao modelo o que existe na
 * máquina, para ele tentar comandos quando dá e pular/usar fallback quando não.
 */
export function describeEnvForPrompt(): string | undefined {
  if (!env.checked) return undefined;
  if (!env.shell) {
    return (
      'Ambiente de execução: NÃO há shell disponível nesta máquina — a ferramenta ' +
      'portal_run_command não existe nesta conversa. Pule qualquer passo que dependa de ' +
      'terminal e use a alternativa manual (ler/escrever arquivos com as ferramentas do portal).'
    );
  }
  const python = fs.existsSync(portalVenvPython())
    ? `Python disponível (use \`${process.platform === 'win32' ? 'python' : 'python3'}\` — já aponta para o ambiente Python do portal).`
    : env.python
      ? `Python disponível (use \`${env.python.cmd}\`).`
      : 'Python NÃO está instalado: pule comandos `python`/`python3` e use a alternativa manual quando houver.';
  return (
    `Ambiente de execução: portal_run_command roda comandos no ${env.shell.label} com a pasta de ` +
    `trabalho da conversa como cwd; cada comando precisa da aprovação do usuário na interface. ` +
    `${python}${docGenerationNote()} Se um comando falhar ou for negado, não insista: siga pelo caminho manual quando existir.`
  );
}

/**
 * Como gerar documentos binários (.pptx/.xlsx/.docx/.pdf) NESTA máquina, do
 * caminho mais robusto ao fallback: venv do portal já preparado (pelo passo
 * opcional do Diagnóstico — tudo instalado, funciona offline) > uv (resolve
 * biblioteca e Python sozinho) > criar o venv na hora (pip global falha em
 * Python gerenciado — PEP 668 — e polui a máquina) > sem Python, não tem como.
 */
function docGenerationNote(): string {
  const header =
    ' Para gerar documentos binários (.pptx com python-pptx, .xlsx com openpyxl, .docx com ' +
    'python-docx, .pdf com reportlab), escreva um script Python em `.tmp/` da pasta de trabalho ' +
    '(o painel Arquivos oculta essa pasta — o usuário quer o documento, não o script; só grave ' +
    'um .py visível se ele pedir o script). O documento gerado deve ser salvo FORA de `.tmp/` ' +
    '(na raiz da pasta de trabalho ou onde o usuário pediu). Rode o script ';
  const footer =
    ' O script salva o documento direto no destino final: depois de rodar, NÃO mova nem renomeie ' +
    'o .py (deixe-o em .tmp/ — o usuário não o vê e mover o script por cima do documento o ' +
    'destruiria). NUNCA instale pacotes no Python global (`pip install` fora de venv falha ou ' +
    'quebra em muitas máquinas) e NUNCA grave esses formatos com portal_write_file: o arquivo ' +
    'sai corrompido.';
  if (fs.existsSync(portalVenvPython())) {
    // com o venv na frente do PATH (runCommand), o python "normal" já é o do
    // portal — instrução simples, sem caminho absoluto para o modelo errar
    const py = process.platform === 'win32' ? 'python' : 'python3';
    return (
      header +
      `com \`${py} .tmp/gera.py\` — os comandos python do portal_run_command já rodam no ambiente ` +
      `Python do portal, que tem python-pptx, openpyxl, python-docx, reportlab e pandas ` +
      `instalados; se precisar de outra biblioteca, \`pip install <lib>\` instala nesse ambiente.` +
      footer
    );
  }
  if (env.uv) {
    return (
      header +
      'com `uv run --with python-pptx .tmp/gera.py` — o uv resolve a biblioteca e o Python ' +
      'sozinho. Repita --with para CADA biblioteca que o script importa (ex.: usar pandas exige ' +
      '`--with pandas --with openpyxl`); qualquer import não declarado falha com ModuleNotFoundError.' +
      footer
    );
  }
  if (env.python) {
    // Git Bash aceita caminho Windows com barras normais
    const venv = portalVenvDir().replace(/\\/g, '/');
    const vpy = portalVenvPython().replace(/\\/g, '/');
    return (
      header +
      `com o venv compartilhado do portal: crie-o UMA vez se ainda não existir ` +
      `(\`${env.python.cmd} -m venv "${venv}"\`), instale nele TODAS as bibliotecas que o script ` +
      `importa (\`"${vpy}" -m pip install python-pptx\`) e execute \`"${vpy}" .tmp/gera.py\`.` +
      footer
    );
  }
  return (
    ' Sem Python não há como gerar documentos binários (.pptx, .xlsx, .docx, .pdf): avise o usuário ' +
    'em vez de tentar gravá-los com portal_write_file (sairiam corrompidos).'
  );
}

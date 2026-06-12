import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvStatus } from '@aiportal/shared';

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
}

const env: ResolvedEnv = { checked: false, node: null, shell: null, python: null };

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

  const [nodeVersion, shell] = await Promise.all([
    probe('node', ['--version']),
    Promise.resolve(process.platform === 'win32' ? findWindowsBash() : findPosixShell()),
  ]);
  env.node = nodeVersion;
  env.shell = shell;

  // win32: o launcher "python" da Microsoft Store responde com erro de loja —
  // exigir uma versão real no stdout filtra esse caso
  for (const cmd of ['python3', 'python']) {
    const version = await probe(cmd, ['--version']);
    if (version && /^Python \d/.test(version)) {
      env.python = { cmd, version: version.replace(/^Python\s*/, '') };
      break;
    }
  }
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
  const python = env.python
    ? `Python disponível (use \`${env.python.cmd}\`).`
    : 'Python NÃO está instalado: pule comandos `python`/`python3` e use a alternativa manual quando houver.';
  return (
    `Ambiente de execução: portal_run_command roda comandos no ${env.shell.label} com a pasta de ` +
    `trabalho da conversa como cwd; cada comando precisa da aprovação do usuário na interface. ` +
    `${python} Se um comando falhar ou for negado, não insista: siga pelo caminho manual quando existir.`
  );
}

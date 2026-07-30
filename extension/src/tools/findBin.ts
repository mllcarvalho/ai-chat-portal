import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { netProcessEnv, resolveShellEnv } from './netEnv';

/**
 * Localiza um executável de CLI de forma confiável a partir do host da
 * extensão.
 *
 * Por que não basta chamar `spawn('claude')`: o VS Code aberto pela GUI herda
 * um PATH mínimo (sem homebrew, sem ~/.local/bin, sem nvm), então o binário
 * "existe no terminal e não existe no portal". O resto do código resolve isso
 * com `await resolveShellEnv()` antes de cada spawn — aqui fazemos o mesmo, e
 * ainda caímos numa lista de locais conhecidos quando nem o PATH do shell de
 * login tem o programa (ex.: instalação nativa em ~/.local/bin).
 */

/** Locais onde as CLIs agênticas costumam se instalar, por plataforma. */
function candidates(bin: string): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [
      path.join(home, '.local', 'bin', `${bin}.exe`),
      path.join(home, 'AppData', 'Roaming', 'npm', `${bin}.cmd`),
      path.join(home, 'AppData', 'Local', 'Programs', bin, `${bin}.exe`),
    ];
  }
  return [
    // instalador nativo (Claude Code e Devin usam este caminho)
    path.join(home, '.local', 'bin', bin),
    path.join(home, `.${bin}`, 'local', bin),
    '/opt/homebrew/bin/' + bin,
    '/usr/local/bin/' + bin,
    '/usr/bin/' + bin,
  ];
}

function whichCommand(bin: string): Promise<string | undefined> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(
      cmd,
      [bin],
      { timeout: 5000, env: { ...process.env, ...netProcessEnv() } },
      (err, stdout) => {
        if (err || !stdout.trim()) return resolve(undefined);
        // `where` no Windows pode devolver várias linhas
        const first = stdout.trim().split(/\r?\n/)[0]?.trim();
        resolve(first && fs.existsSync(first) ? first : undefined);
      },
    );
  });
}

/**
 * Caminho absoluto do executável, ou undefined se não existir na máquina.
 * Resolver para caminho ABSOLUTO (em vez de confiar no PATH do filho) evita
 * que o spawn dependa de o ambiente ter sido corrigido a tempo.
 */
export async function findBin(bin: string): Promise<string | undefined> {
  // mesma precaução dos outros spawns do portal: sem isto o PATH pode ainda
  // ser o mínimo da GUI quando a primeira detecção roda
  await resolveShellEnv();
  const fromPath = await whichCommand(bin);
  if (fromPath) return fromPath;
  for (const candidate of candidates(bin)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // próximo candidato
    }
  }
  return undefined;
}

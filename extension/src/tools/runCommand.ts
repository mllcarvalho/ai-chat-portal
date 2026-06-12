import { spawn } from 'node:child_process';
import type * as vscode from 'vscode';
import { getShell } from './envCheck';

/** Saída devolvida ao modelo: mantém o FIM (onde ficam os erros). */
const OUTPUT_LIMIT = 24 * 1024;
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 600;

export interface CommandOutcome {
  ok: boolean;
  content: string;
}

function clampTail(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text;
  return `… (início truncado)\n${text.slice(-OUTPUT_LIMIT)}`;
}

/**
 * Roda o comando no shell detectado (Git Bash no Windows; shell do usuário no
 * Mac/Linux), com a pasta de trabalho da conversa como cwd. O processo roda em
 * grupo próprio para o kill (timeout/cancelamento) alcançar os filhos.
 */
export function executeCommand(
  command: string,
  cwd: string,
  token: vscode.CancellationToken,
  timeoutSeconds?: number,
): Promise<CommandOutcome> {
  const shell = getShell();
  if (!shell) {
    return Promise.resolve({
      ok: false,
      content:
        'Nenhum shell disponível nesta máquina (no Windows é preciso o Git Bash). ' +
        'Siga pela alternativa manual.',
    });
  }
  const timeoutMs =
    Math.min(Math.max(Number(timeoutSeconds) || DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S) * 1000;

  return new Promise((resolve) => {
    const child = spawn(shell.path, ['-c', command], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = clampTail(stdout + chunk.toString());
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = clampTail(stderr + chunk.toString());
    });

    const kill = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        } else {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const cancelListener = token.onCancellationRequested(() => {
      cancelled = true;
      kill();
    });

    const finish = (outcome: CommandOutcome) => {
      clearTimeout(timer);
      cancelListener.dispose();
      resolve(outcome);
    };

    child.on('error', (err) => {
      finish({ ok: false, content: `Falha ao iniciar o shell: ${err.message}` });
    });
    child.on('close', (code, signal) => {
      const sections: string[] = [];
      if (timedOut) {
        sections.push(`Comando interrompido por timeout (${timeoutMs / 1000}s).`);
      } else if (cancelled) {
        sections.push('Comando interrompido: a geração foi cancelada.');
      } else {
        sections.push(`Exit code: ${code ?? `sinal ${signal}`}`);
      }
      if (stdout.trim()) sections.push(`--- stdout ---\n${stdout.trim()}`);
      if (stderr.trim()) sections.push(`--- stderr ---\n${stderr.trim()}`);
      if (!stdout.trim() && !stderr.trim()) sections.push('(sem saída)');
      finish({ ok: !timedOut && !cancelled && code === 0, content: sections.join('\n') });
    });
  });
}

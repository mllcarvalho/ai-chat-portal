import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { getShell, portalVenvDir, portalVenvPython } from './envCheck';

/**
 * Env dos comandos do modelo: se o venv do portal existe (passo "Geração de
 * documentos" do Diagnóstico), ele entra na frente do PATH — `python3`,
 * `python` e `pip` caem no ambiente com as bibliotecas de Office instaladas,
 * mesmo quando o modelo ignora as instruções e chama o python "global"; um
 * `pip install` perdido instala no venv em vez de falhar no Python gerenciado.
 * VIRTUAL_ENV cobre o launcher `py` do Windows, que não olha o PATH.
 */
function commandEnv(): NodeJS.ProcessEnv {
  const vpy = portalVenvPython();
  if (!fs.existsSync(vpy)) return process.env;
  const bin = path.dirname(vpy);
  return {
    ...process.env,
    VIRTUAL_ENV: portalVenvDir(),
    PATH: process.env.PATH ? `${bin}${path.delimiter}${process.env.PATH}` : bin,
  };
}

/** Saída devolvida ao modelo: mantém o FIM (onde ficam os erros). */
const OUTPUT_LIMIT = 24 * 1024;
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 600;

/**
 * Validação dos documentos que o comando gerou: .pptx/.xlsx/.docx são ZIP
 * (começam com "PK") e .pdf começa com "%PDF" — assinatura errada = arquivo
 * que não abre. O veredito volta na saída do comando para o modelo se
 * corrigir na MESMA rodada, em vez de entregar arquivo corrompido ao usuário.
 */
const CHECKED_DOC_EXTS = new Set(['.pptx', '.xlsx', '.xlsm', '.docx', '.pdf']);

interface DocStamp {
  size: number;
  mtimeMs: number;
}

function walkDocs(root: string, dir: string, depth: number, out: Map<string, DocStamp>): void {
  if (depth > 6 || out.size > 2000) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === '.aiportal' || entry.name === 'node_modules' || entry.name === '.git') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDocs(root, full, depth + 1, out);
    } else if (CHECKED_DOC_EXTS.has(path.extname(entry.name).toLowerCase())) {
      try {
        const stat = fs.statSync(full);
        out.set(path.relative(root, full), { size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // arquivo sumiu no meio — ignora
      }
    }
  }
}

function snapshotDocs(root: string): Map<string, DocStamp> {
  const out = new Map<string, DocStamp>();
  if (fs.existsSync(root)) walkDocs(root, root, 0, out);
  return out;
}

function docSignatureOk(file: string, ext: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(5);
    try {
      fs.readSync(fd, buf, 0, 5, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (ext === '.pdf') return buf.toString('latin1').startsWith('%PDF');
    return buf[0] === 0x50 && buf[1] === 0x4b; // "PK": ZIP/OOXML
  } catch {
    return false;
  }
}

function docsReport(root: string, before: Map<string, DocStamp>): string | undefined {
  const lines: string[] = [];
  for (const [rel, stamp] of snapshotDocs(root)) {
    const prev = before.get(rel);
    if (prev && prev.size === stamp.size && prev.mtimeMs === stamp.mtimeMs) continue;
    const ext = path.extname(rel).toLowerCase();
    let line = docSignatureOk(path.join(root, rel), ext)
      ? `${rel}: OK (assinatura de ${ext} válida)`
      : `${rel}: INVÁLIDO — o conteúdo não é um ${ext} de verdade e o arquivo NÃO vai abrir; ` +
        `gere-o com a biblioteca correta (não grave o formato à mão nem renomeie outro arquivo).`;
    if (rel.startsWith('.tmp/') || rel.startsWith(`.tmp${path.sep}`)) {
      line += ' · ATENÇÃO: está dentro de .tmp/, que o usuário NÃO vê — salve fora de .tmp/.';
    }
    lines.push(line);
  }
  if (!lines.length) return undefined;
  return `--- documentos gerados ---\n${lines.join('\n')}`;
}

export interface CommandOutcome {
  ok: boolean;
  content: string;
}

function clampTail(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text;
  return `… (início truncado)\n${text.slice(-OUTPUT_LIMIT)}`;
}

/**
 * Processos em background (background: true no portal_run_command): ficam num
 * registro global com a saída acumulada; o modelo consulta/encerra com
 * portal_command_output e todos são mortos na desativação da extensão.
 */
interface BackgroundJob {
  id: string;
  command: string;
  pid: number | undefined;
  output: string;
  running: boolean;
  exitCode: number | null;
}

const jobs = new Map<string, BackgroundJob>();
let jobSeq = 0;

function killPid(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // já morreu
    }
  }
}

export function startBackgroundCommand(command: string, cwd: string): CommandOutcome {
  const shell = getShell();
  if (!shell) {
    return { ok: false, content: 'Nenhum shell disponível nesta máquina.' };
  }
  const id = `bg${++jobSeq}`;
  const child = spawn(shell.path, ['-c', command], {
    cwd,
    env: commandEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const job: BackgroundJob = {
    id,
    command,
    pid: child.pid,
    output: '',
    running: true,
    exitCode: null,
  };
  const push = (chunk: Buffer): void => {
    job.output = clampTail(job.output + chunk.toString());
  };
  child.stdout?.on('data', push);
  child.stderr?.on('data', push);
  child.on('error', (err) => {
    job.running = false;
    job.output = clampTail(`${job.output}\nFalha ao iniciar: ${err.message}`);
  });
  child.on('close', (code) => {
    job.running = false;
    job.exitCode = code;
  });
  child.unref();
  jobs.set(id, job);
  return {
    ok: true,
    content:
      `Comando iniciado em segundo plano (id: ${id}). ` +
      'Consulte a saída (e o status) com portal_command_output quando precisar.',
  };
}

export function backgroundOutput(id: string, kill: boolean): CommandOutcome {
  const job = jobs.get(id);
  if (!job) {
    return { ok: false, content: `Não existe processo em background com id ${id}` };
  }
  if (kill && job.running) killPid(job.pid);
  const status = job.running
    ? kill
      ? 'encerramento solicitado'
      : 'em execução'
    : `finalizado (exit code ${job.exitCode ?? '?'})`;
  return {
    ok: true,
    content: `[${job.id}] ${job.command} — ${status}\n${job.output.trim() || '(sem saída até agora)'}`,
  };
}

/** Mata processos em background e shells persistentes (desativação da extensão). */
export function killAllBackground(): void {
  for (const job of jobs.values()) {
    if (job.running) killPid(job.pid);
  }
  for (const session of shells.values()) killPid(session.child.pid);
  shells.clear();
}

/**
 * Shell persistente por conversa (paridade com o terminal do Copilot): `cd`,
 * variáveis exportadas e venv ativado sobrevivem entre um comando e o próximo.
 * Cada comando é delimitado por um sentinel que carrega o exit code; timeout
 * ou cancelamento MATAM o shell (estado descartado) e o próximo comando recria.
 */
interface ShellSession {
  child: ReturnType<typeof spawn>;
  /** Comando em andamento — nunca dois ao mesmo tempo no mesmo shell. */
  busy: boolean;
  /** O venv do portal existia quando o shell nasceu (mudou → recriar p/ PATH). */
  hadVenv: boolean;
  buf: string;
  err: string;
}

const shells = new Map<string, ShellSession>();
const SHELL_LIMIT = 8;

function getShellSession(key: string, cwd: string): ShellSession | null {
  const venvNow = fs.existsSync(portalVenvPython());
  const existing = shells.get(key);
  if (existing && existing.child.exitCode === null && !existing.busy && existing.hadVenv === venvNow) {
    return existing;
  }
  if (existing) {
    killPid(existing.child.pid);
    shells.delete(key);
  }
  const shell = getShell();
  if (!shell) return null;
  // fish não é POSIX ("$?" não existe) — o sentinel quebraria; usa o modo avulso
  if (shell.label === 'fish') return null;
  const child = spawn(shell.path, [], {
    cwd,
    env: commandEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const session: ShellSession = { child, busy: false, hadVenv: venvNow, buf: '', err: '' };
  const drop = (): void => {
    if (shells.get(key) === session) shells.delete(key);
  };
  child.on('close', drop);
  child.on('error', drop);
  shells.set(key, session);
  if (shells.size > SHELL_LIMIT) {
    const oldestKey = shells.keys().next().value;
    if (oldestKey !== undefined && oldestKey !== key) {
      killPid(shells.get(oldestKey)?.child.pid);
      shells.delete(oldestKey);
    }
  }
  return session;
}

function runInShellSession(
  key: string,
  session: ShellSession,
  command: string,
  cwd: string,
  timeoutMs: number,
  token: vscode.CancellationToken,
): Promise<CommandOutcome> {
  const docsBefore = snapshotDocs(cwd);
  const mark = `__PORTAL_DONE_${Math.random().toString(36).slice(2, 10)}__`;
  session.busy = true;
  session.buf = '';
  session.err = '';
  const child = session.child;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: CommandOutcome, killShell: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancelListener.dispose();
      child.stdout?.off('data', onOut);
      child.stderr?.off('data', onErr);
      child.off('close', onClose);
      if (killShell) {
        killPid(child.pid);
        if (shells.get(key) === session) shells.delete(key);
      } else {
        session.busy = false;
      }
      const docs = docsReport(cwd, docsBefore);
      resolve(docs ? { ...outcome, content: `${outcome.content}\n${docs}` } : outcome);
    };
    const onOut = (chunk: Buffer): void => {
      session.buf = clampTail(session.buf + chunk.toString());
      const idx = session.buf.indexOf(mark);
      if (idx < 0) return;
      const codeMatch = session.buf.slice(idx + mark.length).match(/\s*(\d+)/);
      if (!codeMatch) return; // exit code ainda não chegou inteiro
      const code = Number(codeMatch[1]);
      const out = session.buf.slice(0, idx);
      // janela curta para o resto do stderr chegar (streams não são ordenados)
      setTimeout(() => {
        const sections = [`Exit code: ${code}`];
        if (out.trim()) sections.push(`--- stdout ---\n${out.trim()}`);
        if (session.err.trim()) sections.push(`--- stderr ---\n${session.err.trim()}`);
        if (!out.trim() && !session.err.trim()) sections.push('(sem saída)');
        finish({ ok: code === 0, content: sections.join('\n') }, false);
      }, 60);
    };
    const onErr = (chunk: Buffer): void => {
      session.err = clampTail(session.err + chunk.toString());
    };
    const onClose = (): void =>
      finish(
        {
          ok: false,
          content: `O shell da conversa terminou inesperadamente.\n${session.err.trim()}`.trim(),
        },
        true,
      );
    child.stdout?.on('data', onOut);
    child.stderr?.on('data', onErr);
    child.on('close', onClose);
    const timer = setTimeout(
      () =>
        finish(
          {
            ok: false,
            content:
              `Comando interrompido por timeout (${timeoutMs / 1000}s). ` +
              'O shell da conversa foi reiniciado (cd/variáveis foram descartados).',
          },
          true,
        ),
      timeoutMs,
    );
    const cancelListener = token.onCancellationRequested(() =>
      finish({ ok: false, content: 'Comando interrompido: a geração foi cancelada.' }, true),
    );
    try {
      // o printf garante o sentinel numa linha própria, com o exit code junto
      child.stdin?.write(`${command}\nprintf '\\n%s %s\\n' '${mark}' "$?"\n`);
    } catch (err) {
      finish(
        { ok: false, content: `Falha ao enviar o comando ao shell: ${(err as Error).message}` },
        true,
      );
    }
  });
}

/**
 * Roda o comando no shell detectado (Git Bash no Windows; shell do usuário no
 * Mac/Linux), com a pasta de trabalho da conversa como cwd. Com persistKey
 * (id da conversa), usa o shell persistente da conversa — estado (cd, env)
 * sobrevive entre comandos; sem ele, processo avulso em grupo próprio para o
 * kill (timeout/cancelamento) alcançar os filhos.
 */
export function executeCommand(
  command: string,
  cwd: string,
  token: vscode.CancellationToken,
  timeoutSeconds?: number,
  persistKey?: string,
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
  if (persistKey) {
    const session = getShellSession(persistKey, cwd);
    if (session) return runInShellSession(persistKey, session, command, cwd, timeoutMs, token);
  }
  const docsBefore = snapshotDocs(cwd);

  return new Promise((resolve) => {
    const child = spawn(shell.path, ['-c', command], {
      cwd,
      env: commandEnv(),
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
      const docs = docsReport(cwd, docsBefore);
      if (docs) sections.push(docs);
      finish({ ok: !timedOut && !cancelled && code === 0, content: sections.join('\n') });
    });
  });
}

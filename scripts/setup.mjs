#!/usr/bin/env node
/**
 * Comando único do BMAD Product Studio:
 *   npm start
 * Instala dependências, builda tudo, empacota e instala a extensão no VS Code,
 * garante que o servidor está de pé e abre o portal no navegador.
 */
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = platform() === 'win32';
const runtimePath = join(homedir(), 'AIChatPortal', 'runtime.json');

const log = (msg) => console.log(`\x1b[36m▸\x1b[0m ${msg}`);
const ok = (msg) => console.log(`\x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
};

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', cwd: root, ...opts });
}

// ---------- 1. localizar o binário `code` ----------

/** No Windows o spawn com shell não cita argumentos — caminhos com espaço quebram sem isso. */
const winQuote = (s) => (isWindows && /\s/.test(s) ? `"${s}"` : s);

function findCode() {
  const candidates = isWindows
    ? [
        'code.cmd',
        'code',
        join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
        join(process.env.ProgramFiles ?? '', 'Microsoft VS Code', 'bin', 'code.cmd'),
      ]
    : [
        'code',
        '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
        join(homedir(), 'Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'),
        '/usr/local/bin/code',
        '/usr/bin/code',
      ];
  for (const candidate of candidates) {
    try {
      const result = spawnSync(winQuote(candidate), ['--version'], {
        stdio: 'pipe',
        shell: isWindows,
      });
      if (result.status === 0) return candidate;
    } catch {
      // tenta o próximo
    }
  }
  return undefined;
}

function code(args) {
  // no Windows o binário é um .cmd e precisa de shell
  const result = spawnSync(winQuote(codeBin), args.map(winQuote), {
    stdio: 'inherit',
    shell: isWindows,
  });
  if (result.status !== 0) fail(`Falha ao executar: code ${args.join(' ')}`);
}

const codeBin = findCode();
if (!codeBin) {
  fail(
    'VS Code não encontrado.\n' +
      '  - Instale o VS Code: https://code.visualstudio.com\n' +
      '  - No macOS, rode no VS Code: Cmd+Shift+P → "Shell Command: Install \'code\' command in PATH"',
  );
}
ok(`VS Code encontrado (${codeBin})`);

// ---------- 2. npm install (com cache por hash do lockfile) ----------

const stampFile = join(root, '.setup-done');
const lockFile = join(root, 'package-lock.json');
const lockHash = existsSync(lockFile)
  ? createHash('sha256').update(readFileSync(lockFile)).digest('hex')
  : 'no-lock';
const stamp = existsSync(stampFile) ? readFileSync(stampFile, 'utf8') : '';

if (stamp !== lockHash || !existsSync(join(root, 'node_modules'))) {
  log('Instalando dependências (npm install)…');
  run('npm install');
} else {
  ok('Dependências já instaladas');
}

// ---------- 3. build ----------

log('Buildando interface web e extensão…');
run('npm run build');
writeFileSync(stampFile, lockHash);
ok('Build concluído');

// ---------- 4. empacotar e instalar a extensão ----------

log('Empacotando a extensão…');
run('npm run package -w ai-chat-portal-extension');

const extDir = join(root, 'extension');
// o vsix EXATO da versão recém-empacotada — nada de sort() lexicográfico, que
// escolhia um vsix velho quando havia vários (ex: "0.2.9" > "0.2.11" como string)
const extVersion = JSON.parse(readFileSync(join(extDir, 'package.json'), 'utf8')).version;
const vsix = join(extDir, `ai-chat-portal-extension-${extVersion}.vsix`);
if (!existsSync(vsix)) fail(`Arquivo .vsix não foi gerado (${vsix})`);

log('Instalando a extensão no VS Code…');
code(['--install-extension', vsix, '--force']);
ok('Extensão instalada');

// garante o Copilot Chat
const installed = execFileSync(codeBin, ['--list-extensions'], {
  shell: isWindows,
  encoding: 'utf8',
});
if (!/github\.copilot-chat/i.test(installed)) {
  log('GitHub Copilot Chat não encontrado — instalando…');
  code(['--install-extension', 'GitHub.copilot-chat']);
}

// ---------- 5. garantir servidor ativo ----------

const expectedVersion = extVersion;

async function healthCheck(port) {
  try {
    // o /api/health pode levar ~6s (timeouts internos de modelos/conta quando a rede está ruim)
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

function readRuntime() {
  try {
    return JSON.parse(readFileSync(runtimePath, 'utf8'));
  } catch {
    return undefined;
  }
}

async function findLivePortal() {
  const runtime = readRuntime();
  if (!runtime) return undefined;
  const health = await healthCheck(runtime.port);
  if (health && health.version === expectedVersion) return { runtime, health };
  return undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let portal = await findLivePortal();
if (!portal) {
  log('Abrindo uma janela do VS Code para ativar o portal…');
  code(['-n', root]);
  log('Aguardando o servidor do portal subir (até 90s)…');
  for (let i = 0; i < 90 && !portal; i++) {
    await sleep(1000);
    portal = await findLivePortal();
  }
}
if (!portal) {
  fail(
    'O servidor do portal não respondeu.\n' +
      '  - Causa mais comum: o VS Code já estava aberto e não carregou a extensão recém-instalada.\n' +
      '    Feche TODAS as janelas do VS Code e rode npm start de novo.\n' +
      '  - Se persistir, abra o VS Code e rode o comando "BMAD Product Studio: Abrir no Navegador"',
  );
}
ok(`Portal ativo em http://127.0.0.1:${portal.runtime.port}`);

// ---------- 6. diagnóstico ----------

if (!portal.health.copilotChatInstalled) {
  console.warn(
    '\x1b[33m⚠ GitHub Copilot Chat ainda não está ativo nessa janela — o portal mostrará o checklist de configuração.\x1b[0m',
  );
}
if (!portal.health.account) {
  console.warn(
    '\x1b[33m⚠ Nenhuma conta GitHub conectada no VS Code — entre pelo menu Accounts (canto inferior esquerdo).\x1b[0m',
  );
}

// ---------- 7. abrir o navegador ----------

const url = portal.runtime.portalUrl;
log('Abrindo o portal no navegador…');
try {
  if (isWindows) {
    // explorer.exe abre o navegador padrão de forma confiável em cmd, PowerShell
    // E Git Bash/MSYS; o antigo `cmd /c start` falha silenciosamente em vários
    // Git Bash. explorer.exe retorna status 1 mesmo com sucesso, então só caímos
    // no fallback se ele NÃO conseguiu nem iniciar (r.error).
    const r = spawnSync('explorer.exe', [url], { stdio: 'ignore' });
    if (r.error) spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
  } else if (platform() === 'darwin') {
    spawnSync('open', [url], { stdio: 'ignore' });
  } else {
    spawnSync('xdg-open', [url], { stdio: 'ignore' });
  }
} catch {
  // sem browser? mostra a URL
}

console.log('\n\x1b[32m✦ Tudo pronto!\x1b[0m');
console.log(`  URL do portal: ${url}`);
console.log('  Para reabrir depois: npm start (instantâneo) ou, no VS Code,');
console.log('  Cmd/Ctrl+Shift+P → "BMAD Product Studio: Abrir no Navegador"\n');

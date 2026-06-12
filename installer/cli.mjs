#!/usr/bin/env node
/**
 * Instalador de um comando do AI Product BMAD Chat:
 *   npx ai-product-bmad-chat
 * Instala a extensão no VS Code (o .vsix vem embutido neste pacote),
 * garante que o servidor está de pé e abre o portal no navegador.
 *
 * É o scripts/setup.mjs do repositório sem os passos de build — quem instala
 * via npx não precisa de git nem do código-fonte.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = dirname(fileURLToPath(import.meta.url));
const isWindows = platform() === 'win32';
const runtimePath = join(homedir(), 'AIChatPortal', 'runtime.json');

const log = (msg) => console.log(`\x1b[36m▸\x1b[0m ${msg}`);
const ok = (msg) => console.log(`\x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
};

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

// ---------- 2. instalar a extensão (vsix embutido no pacote) ----------

const vsix = join(pkgDir, 'ai-product-bmad-chat.vsix');
if (!existsSync(vsix)) {
  fail(
    'O .vsix não está no pacote.\n' +
      '  - Via npx: rode npx ai-product-bmad-chat@latest\n' +
      '  - No repositório: rode npm run release para gerá-lo',
  );
}

// em Macs corporativos ~/.vscode às vezes fica com dono root e a instalação falha em silêncio
if (!isWindows) {
  const vscodeDir = join(homedir(), '.vscode');
  for (const dir of [vscodeDir, join(vscodeDir, 'extensions')]) {
    if (!existsSync(dir)) continue;
    try {
      accessSync(dir, constants.W_OK);
    } catch {
      fail(
        `Sem permissão de escrita em ${dir} — o VS Code não consegue instalar extensões.\n` +
          '  Recupere a posse da pasta e rode o comando de novo:\n' +
          '    sudo chown -R "$(whoami)" ~/.vscode',
      );
    }
  }
}

log('Instalando a extensão no VS Code…');
code(['--install-extension', vsix, '--force']);

// o CLI do VS Code pode falhar em silêncio (exit 0) — confirma na lista
let installed = '';
try {
  installed = execFileSync(winQuote(codeBin), ['--list-extensions'], {
    shell: isWindows,
    encoding: 'utf8',
  });
} catch {
  // sem a lista, segue sem os checks
}
if (installed && !/aichatportal\.ai-chat-portal-extension/i.test(installed)) {
  fail(
    'A extensão não apareceu na lista do VS Code após a instalação.\n' +
      '  - Rode manualmente para ver o erro real:\n' +
      `    code --install-extension "${vsix}"\n` +
      '  - Confira se há mais de um VS Code na máquina (Insiders, fork etc.)',
  );
}
ok('Extensão instalada');

// garante o Copilot Chat
if (installed && !/github\.copilot-chat/i.test(installed)) {
  log('GitHub Copilot Chat não encontrado — instalando…');
  code(['--install-extension', 'GitHub.copilot-chat']);
}

// ---------- 3. garantir servidor ativo ----------

const expectedVersion = JSON.parse(
  readFileSync(join(pkgDir, 'package.json'), 'utf8'),
).version;

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
  code(['-n']);
  log('Aguardando o servidor do portal subir (até 90s)…');
  log('(se o VS Code já estava aberto, pode ser preciso fechar todas as janelas e rodar de novo)');
  for (let i = 0; i < 90 && !portal; i++) {
    await sleep(1000);
    portal = await findLivePortal();
  }
}
if (!portal) {
  fail(
    'O servidor do portal não respondeu.\n' +
      '  - Causa mais comum: o VS Code já estava aberto e não carregou a extensão recém-instalada.\n' +
      '    Feche TODAS as janelas do VS Code e rode npx ai-product-bmad-chat de novo.\n' +
      '  - Se persistir, abra o VS Code e confira se "AI Product BMAD Chat" aparece na aba\n' +
      '    Extensions; depois rode o comando "AI Product BMAD Chat: Abrir no Navegador"',
  );
}
ok(`Portal ativo em http://127.0.0.1:${portal.runtime.port}`);

// ---------- 4. diagnóstico ----------

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

// ---------- 5. abrir o navegador ----------

const url = portal.runtime.portalUrl;
log('Abrindo o portal no navegador…');
try {
  if (isWindows) {
    spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
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
console.log('  Para reabrir depois: npx ai-product-bmad-chat (instantâneo) ou, no VS Code,');
console.log('  Cmd/Ctrl+Shift+P → "AI Product BMAD Chat: Abrir no Navegador"\n');

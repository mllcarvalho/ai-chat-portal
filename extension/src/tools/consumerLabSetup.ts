import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type {
  ConsumerLabAccount,
  ConsumerLabConnection,
  ConsumerLabStatus,
  McpServerEntry,
} from '@aiportal/shared';
import { dataRoot, ensureDir } from '../storage/paths';
import { readJson, writeJsonAtomic } from '../storage/jsonStore';
import { setServerEnabled, upsertServer } from './mcpManager';
import { findBash } from './envCheck';
import { maskProxyUrl, netProcessEnv, resolveShellEnv } from './netEnv';

/**
 * Setup guiado do MCP ConsumerLab (Itaú) — porta do setup.sh usado no fluxo
 * manual do VS Code para dentro do portal: pré-requisitos (git/python/uv/aws),
 * clone do repositório do servidor, uv sync, login SSO na AWS (abre o browser),
 * escolha de conta/role pela UI e registro do servidor stdio no mcp.json.
 * Mesmo padrão do instalador do BMAD: processo em background + log acumulado
 * + polling via GET; as fases awaiting-* pausam esperando um POST de escolha.
 */

export const CONSUMERLAB_SERVER_NAME = 'consumerlab';
const REPO_URL = 'https://github.com/itau-corp/itau-vy4-modules-mcp-server-consumerlab.git';
const REPO_DIR_NAME = 'itau-vy4-modules-mcp-server-consumerlab';
const AWS_REGION = 'sa-east-1';
const LEGACY_TMP_PROFILE = '_itau_sso_tmp';
const LOG_LIMIT = 8000;

/**
 * Portais SSO onde a conta pode morar. O usuário escolhe por qual começar ao
 * iniciar o setup (há quem só tenha acesso no CTPRO — começar sempre pela
 * Landing Zone travava essas pessoas no primeiro login); se a conta não
 * aparecer na lista, ainda dá para trocar para o outro portal pela UI (cada
 * portal exige um login próprio no browser, então não dá para "validar nos
 * dois" de uma vez sem forçar duas autenticações em todo mundo).
 * Cada portal tem a PRÓPRIA região de SSO — a Landing Zone vive em us-east-1,
 * o CTPRO em sa-east-1; registrar/listar na região errada falha o login.
 */
interface SsoPortal {
  id: string;
  label: string;
  session: string;
  startUrl: string;
  ssoRegion: string;
}
const SSO_PORTALS: SsoPortal[] = [
  {
    id: 'itaulzprod',
    label: 'Landing Zone (itaulzprod)',
    session: 'itau-sso',
    startUrl: 'https://itaulzprod.awsapps.com/start',
    ssoRegion: 'us-east-1',
  },
  {
    id: 'ctpro',
    label: 'CTPRO (itau-pro-ctpro-01)',
    session: 'itau-sso-ctpro',
    startUrl: 'https://itau-pro-ctpro-01.awsapps.com/start',
    ssoRegion: 'sa-east-1',
  },
];

const PHASE_LABELS: Record<ConsumerLabStatus['phase'], string> = {
  idle: 'Aguardando início',
  prereqs: 'Verificando pré-requisitos (git, python, uv, AWS CLI)…',
  repo: 'Baixando o repositório do servidor…',
  'repo-auth': 'Autorização do GitHub — confirme na janela do VS Code (Sign in with browser)',
  deps: 'Instalando dependências (uv sync)…',
  'sso-login': 'Login SSO na AWS — conclua a autenticação no browser',
  accounts: 'Buscando contas AWS disponíveis…',
  'awaiting-account': 'Escolha a conta AWS',
  roles: 'Buscando roles da conta…',
  'awaiting-role': 'Escolha a role',
  profile: 'Gravando o profile AWS…',
  register: 'Registrando e ligando o servidor MCP…',
  done: 'Setup concluído — servidor ligado',
  error: 'Falha no setup',
};

interface SetupState {
  status: ConsumerLabStatus;
  /** Token SSO da rodada — nunca entra no status/log. */
  accessToken?: string;
  /** CLI < 2.7 usa o fluxo SSO legado (profile temporário, sem sso-session). */
  legacySso?: boolean;
  /** Índice do portal SSO em uso (SSO_PORTALS). */
  portalIndex: number;
  /** Lista completa (sem o filtro "consumer"), para validar a escolha. */
  allAccounts?: ConsumerLabAccount[];
  selectedAccountId?: string;
  child?: ChildProcess;
  cancelled?: boolean;
}

let state: SetupState = { status: emptyStatus(), portalIndex: 0 };

function emptyStatus(): ConsumerLabStatus {
  return { running: false, phase: 'idle', phaseLabel: PHASE_LABELS.idle, log: '' };
}

/** Conta/role do último setup concluído — sobrevive ao restart da extensão. */
function connectionPath(): string {
  return path.join(dataRoot(), 'mcp', 'consumerlab-connection.json');
}

function currentPortal(): SsoPortal {
  return SSO_PORTALS[state.portalIndex];
}

function setPhase(phase: ConsumerLabStatus['phase']): void {
  state.status.phase = phase;
  state.status.phaseLabel = PHASE_LABELS[phase];
  state.status.ssoPortal = currentPortal().label;
  const alt = SSO_PORTALS[(state.portalIndex + 1) % SSO_PORTALS.length];
  state.status.altSsoPortal = alt === currentPortal() ? undefined : alt.label;
  if (phase === 'sso-login' || phase === 'awaiting-account') {
    state.status.phaseLabel += ` — ${currentPortal().label}`;
  }
}

function appendLog(text: string): void {
  if (!text) return;
  // erros de rede dos comandos (aws/pip/git) podem citar a URL do proxy com a
  // senha do RACF — mascara tudo que entra no log (best-effort por chunk)
  const merged = state.status.log + maskProxyUrl(text);
  state.status.log = merged.length > LOG_LIMIT ? merged.slice(-LOG_LIMIT) : merged;
}

function fail(message: string): never {
  throw new Error(message);
}

/** Com shell:true (Windows) o spawn não cita args — citamos nós mesmos. */
function quoteArg(arg: string): string {
  if (/^[\w@.:/\\=-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

interface RunResult {
  code: number | null;
  output: string;
}

function run(
  command: string,
  args: string[],
  opts: {
    cwd?: string;
    timeoutMs?: number;
    quiet?: boolean;
    logAs?: string;
    /** Spawna direto (sem cmd.exe no Windows) — evita expansão de %VAR% nos args. */
    direct?: boolean;
    /** Overrides de env por cima do process.env (valor undefined REMOVE a chave). */
    env?: Record<string, string | undefined>;
  } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (state.cancelled) {
      reject(new Error('Setup cancelado.'));
      return;
    }
    const useShell = process.platform === 'win32' && !opts.direct;
    const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
    for (const key of Object.keys(env)) {
      if (env[key] === undefined) delete env[key];
    }
    appendLog(`\n$ ${opts.logAs ?? [command, ...args].join(' ')}\n`);
    const child = spawn(command, useShell ? args.map(quoteArg) : args, {
      cwd: opts.cwd,
      env,
      shell: useShell,
    });
    state.child = child;
    let output = '';
    const timeout = opts.timeoutMs
      ? setTimeout(() => {
          appendLog('\n(tempo esgotado — encerrando o comando)\n');
          child.kill();
        }, opts.timeoutMs)
      : undefined;
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 512 * 1024) output = output.slice(-256 * 1024);
      if (!opts.quiet) appendLog(chunk.toString());
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      if (timeout) clearTimeout(timeout);
      state.child = undefined;
      resolve({ code: null, output: `${output}\n${err.message}` });
    });
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      state.child = undefined;
      if (state.cancelled) reject(new Error('Setup cancelado.'));
      else resolve({ code, output });
    });
  });
}

/** `cmd --version` funcionou? Devolve a primeira linha da saída (ou undefined). */
async function versionOf(command: string, args = ['--version']): Promise<string | undefined> {
  const result = await run(command, args, { timeoutMs: 30_000, quiet: true, logAs: `${command} ${args.join(' ')}` });
  if (result.code !== 0) return undefined;
  const line = result.output.trim().split('\n')[0]?.trim();
  return line || undefined;
}

// --- Edição do ~/.aws/config (mesma lógica dos blocos do setup.sh) ----------

function awsConfigPath(): string {
  return path.join(os.homedir(), '.aws', 'config');
}

function readAwsConfig(): string {
  try {
    return fs.readFileSync(awsConfigPath(), 'utf8');
  } catch {
    return '';
  }
}

function writeAwsConfig(content: string): void {
  ensureDir(path.join(os.homedir(), '.aws'));
  fs.writeFileSync(awsConfigPath(), content, 'utf8');
}

/** Remove o bloco `[<header>] …` (até a próxima seção) e devolve o restante. */
function stripConfigBlock(content: string, header: string): string {
  const pattern = new RegExp(`\\[${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][^\\[]*`, 'g');
  return content.replace(pattern, '').replace(/\s+$/, '') + '\n';
}

function upsertConfigBlock(header: string, lines: Record<string, string>): void {
  const body = Object.entries(lines)
    .map(([k, v]) => `${k} = ${v}`)
    .join('\n');
  const content = stripConfigBlock(readAwsConfig(), header);
  writeAwsConfig(`${content}\n[${header}]\n${body}\n`);
}

function removeConfigBlock(header: string): void {
  writeAwsConfig(stripConfigBlock(readAwsConfig(), header));
}

// --- Passos do setup ---------------------------------------------------------

function uvBin(): string {
  return process.platform === 'win32' ? 'uv.exe' : 'uv';
}

/** Diretório de scripts do Python — onde `pip install uv` põe o uv/uv.exe. */
async function pythonScriptsDirs(): Promise<string[]> {
  // o scheme "user" do sysconfig dá o caminho REAL do pip --user (no Windows é
  // versionado: ...\AppData\Roaming\Python\Python314\Scripts — montar na mão
  // com site.getuserbase() erra a pasta e o uv instalado nunca era encontrado)
  const code =
    "import sysconfig,os;print(sysconfig.get_path('scripts'));" +
    "s=getattr(sysconfig,'get_preferred_scheme',None);" +
    "print(sysconfig.get_path('scripts',s('user') if s else os.name+'_user'))";
  for (const py of ['python3', 'python', 'py']) {
    const r = await run(py, ['-c', code], { quiet: true, timeoutMs: 15_000, logAs: `${py} -c (scripts dir)` });
    if (r.code === 0) {
      const dirs = r.output.split('\n').map((l) => l.trim()).filter(Boolean);
      if (dirs.length) return dirs;
    }
  }
  return [];
}

/** Diretórios onde o uv costuma cair: instalador oficial, cargo, brew, pip. */
async function uvCandidateDirs(): Promise<string[]> {
  const home = os.homedir();
  const dirs = [path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin')];
  if (process.platform === 'darwin') {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin');
    try {
      const base = path.join(home, 'Library', 'Python');
      for (const v of fs.readdirSync(base)) dirs.push(path.join(base, v, 'bin'));
    } catch {
      // sem pip --user no Mac
    }
  }
  for (const dir of await pythonScriptsDirs()) dirs.push(dir);
  return dirs;
}

/** Diretório onde o uv está instalado (procura nos candidatos), ou undefined. */
async function findUvDir(): Promise<string | undefined> {
  for (const dir of await uvCandidateDirs()) {
    try {
      if (fs.existsSync(path.join(dir, uvBin()))) return dir;
    } catch {
      // dir inacessível — tenta o próximo
    }
  }
  return undefined;
}

/** Prepõe um dir ao PATH DESTA sessão (sem duplicar). */
function prependProcessPath(dir: string): void {
  if (!(process.env.PATH ?? '').split(path.delimiter).includes(dir)) {
    process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ''}`;
  }
}

const UV_PATH_MARKER = '# uv (ConsumerLab) — PATH gerenciado pelo BMAD Product Studio';

/**
 * Persiste o dir do uv no PATH PERMANENTE do usuário — assim ele continua
 * funcionando depois de fechar o VS Code, sem o usuário mexer em nada:
 *  - mac/linux: `export PATH="<dir>:$PATH"` no ~/.bashrc (cria), ~/.zshrc e
 *    ~/.profile (se existirem), idempotente (não duplica).
 *  - Windows: prepende ao PATH do usuário no registro via PowerShell (lê e
 *    reescreve inteiro — NÃO usa setx, que trunca em 1024). O portal lê esse
 *    PATH do registro na inicialização (resolveWindowsEnv).
 * Best-effort: se persistir falhar (ex.: EDR bloqueia o PowerShell), o uv ainda
 * vale nesta sessão porque já foi prependado no process.env.
 */
async function persistUvDir(dir: string): Promise<void> {
  try {
    if (process.platform === 'win32') {
      const d = dir.replace(/'/g, "''");
      const script =
        `$d='${d}';` +
        "$p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not $p){$p=''};" +
        "$parts=@($p -split ';' | Where-Object { $_ });" +
        "if($parts -notcontains $d){ [Environment]::SetEnvironmentVariable('Path', ((@($d)+$parts) -join ';'),'User') }";
      const ps = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        quiet: true,
        timeoutMs: 20_000,
        logAs: 'persistir uv no PATH do usuário (registro)',
      });
      if (ps.code !== 0) {
        // PowerShell bloqueado (EDR corporativo) — reg.exe faz o mesmo
        await persistUvDirViaReg(dir);
        return;
      }
    } else {
      const home = os.homedir();
      const line = `export PATH="${dir}:$PATH"`;
      for (const { file, create } of [
        { file: path.join(home, '.bashrc'), create: true },
        { file: path.join(home, '.zshrc'), create: false },
        { file: path.join(home, '.profile'), create: false },
      ]) {
        let content: string | undefined;
        try {
          content = fs.readFileSync(file, 'utf8');
        } catch {
          if (!create) continue;
          content = '';
        }
        if (content.includes(`"${dir}:$PATH"`)) continue; // já persistido
        const next = `${content.replace(/\n*$/, '')}${content.trim() ? '\n\n' : ''}${UV_PATH_MARKER}\n${line}\n`;
        fs.writeFileSync(file, next, 'utf8');
      }
    }
    appendLog(`✓ uv adicionado ao PATH permanente (${dir})\n`);
  } catch {
    // best-effort — segue valendo nesta sessão via process.env
  }
}

/** Fallback do persist no Windows sem PowerShell: reg.exe (query + add). */
async function persistUvDirViaReg(dir: string): Promise<void> {
  const reg = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
  const query = await run(reg, ['query', 'HKCU\\Environment', '/v', 'Path'], {
    quiet: true,
    timeoutMs: 15_000,
    direct: true,
    logAs: 'reg query HKCU\\Environment /v Path',
  });
  let current = '';
  if (query.code === 0) {
    const m = /Path\s+REG(?:_EXPAND)?_SZ\s+(.*)/i.exec(query.output);
    if (!m) return; // Path existe mas não deu para ler — não sobrescreve às cegas
    current = m[1].trim();
  }
  const parts = current.split(';').filter(Boolean);
  if (parts.some((p) => p.trim().toLowerCase() === dir.toLowerCase())) return;
  const add = await run(
    reg,
    ['add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', [dir, ...parts].join(';'), '/f'],
    {
      quiet: true,
      timeoutMs: 15_000,
      direct: true,
      logAs: 'reg add HKCU\\Environment /v Path (prepend uv)',
    },
  );
  if (add.code === 0) appendLog(`✓ uv adicionado ao PATH permanente via reg.exe (${dir})\n`);
}

/** Achou o uv num dir? prepõe na sessão e persiste no PATH permanente. */
async function adoptUvDir(): Promise<boolean> {
  const dir = await findUvDir();
  if (!dir) return false;
  appendLog(`✓ uv encontrado em ${dir}\n`);
  prependProcessPath(dir);
  await persistUvDir(dir);
  return true;
}

/** Instala o uv via pip --user (transparente, sem admin; proxy/CA explícitos). */
async function pipInstallUv(): Promise<boolean> {
  // proxy e CA corporativos como ARGS (o pip ignora REQUESTS_CA_BUNDLE do env
  // em algumas versões e usa o certifi embutido) — nunca vão para o log
  // (logAs omite os args, e o proxy carrega a senha do RACF)
  const net = netProcessEnv();
  const proxy = net.HTTPS_PROXY ?? net.HTTP_PROXY;
  const cert = net.REQUESTS_CA_BUNDLE;
  const netArgs = [...(proxy ? ['--proxy', proxy] : []), ...(cert ? ['--cert', cert] : [])];
  for (const py of ['python3', 'python', 'py']) {
    const r = await run(py, ['-m', 'pip', 'install', '--user', '--upgrade', ...netArgs, 'uv'], {
      timeoutMs: 300_000,
      quiet: true,
      logAs: `${py} -m pip install --user uv`,
    });
    if (r.code === 0) return true;
    if (r.code === null) continue; // este python não existe — tenta o próximo
    // proxy que reassina o TLS derruba o pip mesmo com --cert quando a cadeia
    // está incompleta — repete confiando nos hosts oficiais do PyPI
    appendLog('pip falhou — tentando de novo com --trusted-host (TLS do proxy)…\n');
    const retry = await run(
      py,
      [
        '-m', 'pip', 'install', '--user', '--upgrade', ...netArgs,
        '--trusted-host', 'pypi.org', '--trusted-host', 'files.pythonhosted.org',
        'uv',
      ],
      { timeoutMs: 300_000, quiet: true, logAs: `${py} -m pip install --user uv (--trusted-host)` },
    );
    if (retry.code === 0) return true;
    // cauda do erro para diagnóstico — com a senha do proxy mascarada
    appendLog(`${maskProxyUrl(retry.output.trim().split('\n').slice(-3).join('\n'))}\n`);
  }
  return false;
}

/**
 * Garante o uv disponível E no PATH (na sessão e permanente). Ordem, do mais
 * transparente para o mais pesado:
 *   1. já no PATH;
 *   2. já instalado fora do PATH (pip/instalador) → adota e persiste;
 *   3. instala com `pip install --user uv` → adota e persiste (resolve o antigo
 *      "uv cai numa pasta fora do PATH": agora achamos a pasta e a persistimos);
 *   4. fallback: instalador nativo do SO (mac brew, win astral.sh, linux curl).
 * Exportado: o Diagnóstico usa como correção automática ("Instalar uv").
 */
export async function ensureUv(): Promise<string | undefined> {
  let uv = await versionOf('uv');
  if (uv) return uv;

  if (await adoptUvDir()) {
    uv = await versionOf('uv');
    if (uv) return uv;
  }

  appendLog('uv não encontrado — instalando com pip…\n');
  if (await pipInstallUv()) {
    if (await adoptUvDir()) {
      uv = await versionOf('uv');
      if (uv) return uv;
    }
  }

  if (process.platform === 'darwin') {
    appendLog('Tentando via brew…\n');
    await run('brew', ['install', 'uv'], { timeoutMs: 300_000 });
  } else if (process.platform === 'win32') {
    // o install.sh do astral roda no Git Bash (detecta MINGW/MSYS e baixa o
    // binário windows) — preferir SEMPRE o bash: o PowerShell costuma ser
    // bloqueado pelo antivírus corporativo (spawn UNKNOWN)
    const bash = findBash();
    if (bash) {
      appendLog(`Tentando pelo instalador oficial (astral.sh) via ${bash.label}…\n`);
      // direct: sem cmd.exe no meio (que expandiria %XX% da senha do proxy)
      await run(bash.path, ['-lc', uvInstallShCommand()], {
        timeoutMs: 300_000,
        direct: true,
        logAs: 'curl -LsSf https://astral.sh/uv/install.sh | sh (Git Bash)',
      });
      if (await adoptUvDir()) {
        const v = await versionOf('uv');
        if (v) return v;
      }
    }
    appendLog('Tentando pelo instalador oficial (astral.sh) via PowerShell…\n');
    await run(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://astral.sh/uv/install.ps1 | iex'],
      { timeoutMs: 300_000 },
    );
  } else {
    appendLog('Tentando pelo instalador oficial (astral.sh)…\n');
    await run('sh', ['-c', uvInstallShCommand()], { timeoutMs: 300_000, logAs: 'curl -LsSf https://astral.sh/uv/install.sh | sh' });
  }
  await adoptUvDir();
  return versionOf('uv');
}

/**
 * Comando `curl | sh` do instalador oficial, com proxy/CA corporativos
 * exportados na própria linha (o curl do Git Bash não herda a config do
 * portal) e sem mexer nos rc (o PATH é persistido por persistUvDir).
 */
function uvInstallShCommand(): string {
  const net = netProcessEnv();
  const sq = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  const exports = [
    net.HTTPS_PROXY ? `export HTTPS_PROXY=${sq(net.HTTPS_PROXY)} HTTP_PROXY=${sq(net.HTTPS_PROXY)};` : '',
    net.REQUESTS_CA_BUNDLE ? `export CURL_CA_BUNDLE=${sq(net.REQUESTS_CA_BUNDLE)};` : '',
    'export UV_NO_MODIFY_PATH=1;',
  ]
    .filter(Boolean)
    .join(' ');
  return `${exports} curl -LsSf https://astral.sh/uv/install.sh | sh`;
}

/** Marcador para instalar o uv no máximo uma vez automaticamente na inicialização. */
const UV_STARTUP_MARKER = '.uv-startup-attempted';

/**
 * Chamado na ativação da extensão: deixa o uv pronto de forma transparente.
 * Se já existe (mesmo fora do PATH), só adota e persiste — barato, sem rede.
 * Se falta, instala UMA vez (trava por marcador para não repetir a cada boot
 * caso a rede/pip falhem); a instalação sob demanda continua no ConsumerLab e
 * no botão "Instalar uv" do Diagnóstico. Totalmente best-effort e em background.
 */
export async function prepareUvOnStartup(): Promise<void> {
  try {
    if (await versionOf('uv')) return;
    if (await adoptUvDir()) return;
    const marker = path.join(dataRoot(), UV_STARTUP_MARKER);
    if (fs.existsSync(marker)) return;
    try {
      ensureDir(dataRoot());
      fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
    } catch {
      // sem marcador ainda tentamos — só não fica gravado
    }
    await ensureUv();
  } catch {
    // inicialização nunca falha por causa disso
  }
}

async function checkPrerequisites(): Promise<void> {
  setPhase('prereqs');
  const problems: string[] = [];

  const git = await versionOf('git');
  if (git) appendLog(`✓ ${git}\n`);
  else problems.push('Git não encontrado. Instale via Central de Software (Git Bash).');

  let python: string | undefined;
  for (const cmd of ['python3', 'python']) {
    const v = await versionOf(cmd);
    // saída esperada: "Python 3.11.x" — o stub do Microsoft Store falha no run
    const match = v?.match(/Python (\d+)\.(\d+)/);
    if (match && Number(match[1]) >= 3 && Number(match[2]) >= 9) {
      python = v;
      break;
    }
  }
  if (python) appendLog(`✓ ${python}\n`);
  else problems.push('Python >= 3.11 não encontrado. Instale via Central de Software.');

  const uv = await ensureUv();
  if (uv) appendLog(`✓ ${uv}\n`);
  else
    problems.push(
      process.platform === 'win32'
        ? 'Não consegui instalar o uv automaticamente (pip e instalador oficial falharam). Rode no Git Bash: curl -LsSf https://astral.sh/uv/install.sh | sh — depois FECHE e reabra o VS Code. (Evite o PowerShell: costuma ser bloqueado pelo antivírus corporativo.) Se estiver atrás do proxy corporativo, confira a rede/VPN.'
        : 'Não consegui instalar o uv automaticamente (pip e instalador oficial falharam). Rode: brew install uv (ou curl -LsSf https://astral.sh/uv/install.sh | sh) e reabra o VS Code.',
    );

  const aws = await versionOf('aws');
  if (aws) {
    appendLog(`✓ ${aws}\n`);
    const match = aws.match(/aws-cli\/(\d+)\.(\d+)/);
    const major = Number(match?.[1] ?? 0);
    const minor = Number(match?.[2] ?? 0);
    state.legacySso = major < 2 || (major === 2 && minor < 7);
    if (state.legacySso)
      appendLog(`⚠ AWS CLI antiga (recomendado >= 2.7). Usando fluxo SSO legado compatível.\n`);
  } else {
    problems.push('AWS CLI não encontrada. Instale via Central de Software (versão >= 2.0.0).');
  }

  if (problems.length) fail(problems.join('\n'));
}

/**
 * Env para git interativo: REMOVE o askpass do VS Code — herdado no spawn, ele
 * manda o pedido de credencial para uma caixinha DENTRO do VS Code (que o
 * usuário, olhando o portal no browser, nunca vê → clone "trava" até o
 * timeout). Sem ele, o git cai no credential helper normal (Git Credential
 * Manager), que abre a janela "Connect to GitHub" na tela do usuário.
 * GIT_TERMINAL_PROMPT=0 evita o prompt de usuário/senha num terminal que não
 * existe (a GUI do GCM não depende de terminal).
 */
const GIT_INTERACTIVE_ENV: Record<string, string | undefined> = {
  GIT_ASKPASS: undefined,
  VSCODE_GIT_ASKPASS_NODE: undefined,
  VSCODE_GIT_ASKPASS_MAIN: undefined,
  VSCODE_GIT_ASKPASS_EXTRA_ARGS: undefined,
  VSCODE_GIT_IPC_HANDLE: undefined,
  GIT_TERMINAL_PROMPT: '0',
};

/** Args de auth do git com o token da sessão (token NUNCA vai para o log — use logAs). */
function gitAuthArgs(token: string): string[] {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
}

/**
 * Token da conta GitHub já conectada no VS Code (a mesma do Copilot). Sem
 * sessão com escopo de repo, o createIfNone abre o fluxo do próprio VS Code:
 * notificação "Allow signing in with GitHub" → Sign in with your browser.
 */
async function githubSessionToken(): Promise<string | undefined> {
  try {
    const silent = await vscode.authentication.getSession('github', ['repo'], { silent: true });
    if (silent) return silent.accessToken;
  } catch {
    // sem sessão silenciosa — segue para o fluxo interativo
  }
  setPhase('repo-auth');
  try {
    const session = await vscode.authentication.getSession('github', ['repo'], {
      createIfNone: true,
    });
    return session?.accessToken;
  } catch {
    return undefined; // usuário cancelou ou o fluxo falhou
  } finally {
    setPhase('repo');
  }
}

const CLONE_FAIL_MSG =
  'Falha ao clonar o repositório do ConsumerLab. Rode UMA vez no Git Bash: ' +
  `git clone ${REPO_URL} — conclua o login na janela "Connect to GitHub" (Sign in with your browser) ` +
  'e refaça o setup por aqui. Se a janela não abrir, verifique seu acesso ao GitHub corporativo (SSO Itaú).';

async function setupRepository(): Promise<string> {
  setPhase('repo');
  const parent = path.join(dataRoot(), 'mcp');
  ensureDir(parent);
  const repoPath = path.join(parent, REPO_DIR_NAME);
  if (fs.existsSync(path.join(repoPath, '.git'))) {
    appendLog('Repositório já existe — atualizando…\n');
    const pull = await run('git', ['pull', '--ff-only'], {
      cwd: repoPath,
      timeoutMs: 120_000,
      env: GIT_INTERACTIVE_ENV,
    });
    if (pull.code !== 0) appendLog('⚠ Não foi possível atualizar (seguindo com a versão local).\n');
    state.status.repoPath = repoPath;
    return repoPath;
  }

  // clone anterior abortado deixa a pasta sem .git — limpa para o git não recusar
  fs.rmSync(repoPath, { recursive: true, force: true });

  // credencial já cacheada? teste rápido SEM abrir janela nenhuma
  const probe = await run('git', ['ls-remote', REPO_URL, 'HEAD'], {
    timeoutMs: 45_000,
    quiet: true,
    logAs: 'git ls-remote (teste de acesso ao repositório)',
    env: { ...GIT_INTERACTIVE_ENV, GCM_INTERACTIVE: 'false' },
  });

  if (probe.code !== 0) {
    appendLog(
      '\nSem credencial do GitHub nesta máquina. Se abrir a janela "Connect to GitHub", ' +
        'conclua o login por ela (Sign in with your browser) — o setup continua sozinho.\n',
    );
  }
  const clone = await run('git', ['clone', REPO_URL, repoPath], {
    timeoutMs: 300_000,
    env: GIT_INTERACTIVE_ENV,
  });
  if (clone.code !== 0) {
    // sem GCM (ou login cancelado): tenta a conta GitHub do próprio VS Code
    appendLog('\nClone falhou — tentando com a conta GitHub conectada no VS Code…\n');
    const token = await githubSessionToken();
    if (!token) fail(CLONE_FAIL_MSG);
    fs.rmSync(repoPath, { recursive: true, force: true }); // clone abortado deixa a pasta suja
    const retry = await run('git', [...gitAuthArgs(token), 'clone', REPO_URL, repoPath], {
      timeoutMs: 300_000,
      logAs: 'git clone (autenticado com a conta GitHub do VS Code)',
      env: GIT_INTERACTIVE_ENV,
    });
    if (retry.code !== 0) fail(CLONE_FAIL_MSG);
  }
  state.status.repoPath = repoPath;
  return repoPath;
}

async function installDependencies(repoPath: string): Promise<void> {
  setPhase('deps');
  const sync = await run('uv', ['sync', '--native-tls'], {
    cwd: repoPath,
    timeoutMs: 900_000,
    env: netProcessEnv(),
  });
  if (sync.code !== 0)
    fail('Falha ao instalar dependências. Tente manualmente: uv sync --native-tls (na pasta do repositório).');
}

async function ssoLogin(): Promise<void> {
  const portal = currentPortal();
  setPhase('sso-login');
  appendLog(`\nO browser vai abrir para o login SSO — ${portal.label}. Autentique-se e volte aqui.\n`);
  // proxy e CA corporativos no ambiente do aws: o git passa pelo proxy do git
  // config, mas o aws depende de HTTPS_PROXY/AWS_CA_BUNDLE — sem eles o
  // register/login falha na rede corporativa mesmo com o browser abrindo
  const env = netProcessEnv();
  let loginArgs: string[];
  if (state.legacySso) {
    // CLI < 2.7: login via profile temporário com campos SSO diretos
    upsertConfigBlock(`profile ${LEGACY_TMP_PROFILE}`, {
      sso_start_url: portal.startUrl,
      sso_region: portal.ssoRegion,
      sso_account_id: '000000000000',
      sso_role_name: '_placeholder',
      region: portal.ssoRegion,
      output: 'json',
    });
    loginArgs = ['sso', 'login', '--profile', LEGACY_TMP_PROFILE];
  } else {
    // sempre reescreve o bloco: um bloco antigo com região/URL erradas não
    // pode sobreviver só porque o header já existe no ~/.aws/config
    upsertConfigBlock(`sso-session ${portal.session}`, {
      sso_start_url: portal.startUrl,
      sso_region: portal.ssoRegion,
      sso_registration_scopes: 'sso:account:access',
    });
    loginArgs = ['sso', 'login', '--sso-session', portal.session];
  }
  let login = await run('aws', loginArgs, { timeoutMs: 600_000, env });
  if (login.code !== 0 && !state.cancelled) {
    // fluxo PKCE (browser + redirect local) falha em máquina travada — o
    // device code só precisa que o usuário abra a URL do log em QUALQUER
    // navegador e digite o código (CLI >= 2.22; em CLIs antigas o flag não
    // existe e este retry falha rápido, mantendo o erro original visível)
    appendLog(
      '\nO fluxo pelo browser falhou — tentando com código de dispositivo: ' +
        'abra a URL que aparecer ABAIXO em qualquer navegador e digite o código mostrado.\n',
    );
    login = await run('aws', [...loginArgs, '--use-device-code'], { timeoutMs: 600_000, env });
  }
  if (login.code !== 0)
    fail(
      'Falha no login SSO. Confira as últimas linhas do log acima (erro de proxy/rede é a causa ' +
        'mais comum na rede corporativa) e tente novamente.',
    );

  // token do cache (~/.aws/sso/cache/*.json mais recente com accessToken)
  const cacheDir = path.join(os.homedir(), '.aws', 'sso', 'cache');
  let token = '';
  try {
    const files = fs
      .readdirSync(cacheDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(cacheDir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
        const t = (data.accessToken ?? data.access_token) as string | undefined;
        if (t) {
          token = t;
          break;
        }
      } catch {
        /* arquivo de cache inválido — tenta o próximo */
      }
    }
  } catch {
    /* sem cache */
  }
  if (!token)
    fail('Não foi possível obter o token SSO do cache. Limpe ~/.aws/sso/cache e tente de novo.');
  state.accessToken = token;
}

async function listAccounts(): Promise<void> {
  setPhase('accounts');
  const result = await run(
    'aws',
    ['sso', 'list-accounts', '--access-token', state.accessToken!, '--region', currentPortal().ssoRegion, '--output', 'json'],
    { timeoutMs: 60_000, quiet: true, logAs: 'aws sso list-accounts (token omitido)', env: netProcessEnv() },
  );
  if (result.code !== 0) fail('Não foi possível listar as contas AWS. O token pode ter expirado — tente de novo.');
  let all: ConsumerLabAccount[] = [];
  try {
    const parsed = JSON.parse(result.output) as { accountList?: Array<{ accountId: string; accountName: string }> };
    all = (parsed.accountList ?? []).map((a) => ({ id: a.accountId, name: a.accountName }));
  } catch {
    fail('Resposta inesperada do aws sso list-accounts.');
  }
  if (!all.length)
    fail(
      'Nenhuma conta AWS encontrada para este usuário. Verifique seu acesso ao grupo G_AWS_SIGLA_PROD_ANALYTICS_CONSUMER no IU Acessos.',
    );
  all.sort((a, b) => a.name.localeCompare(b.name));
  state.allAccounts = all;
  // pré-filtra pelas contas do Consumer Lab; sem match, mostra todas
  const filtered = all.filter((a) => a.name.toLowerCase().includes('consumer'));
  state.status.accounts = filtered.length ? filtered : all;
  appendLog(`✓ ${all.length} conta(s) encontrada(s)${filtered.length ? `, ${filtered.length} com "consumer" no nome` : ''}.\n`);
  setPhase('awaiting-account');
}

async function listRoles(accountId: string): Promise<void> {
  setPhase('roles');
  const result = await run(
    'aws',
    [
      'sso',
      'list-account-roles',
      '--access-token',
      state.accessToken!,
      '--account-id',
      accountId,
      '--region',
      currentPortal().ssoRegion,
      '--output',
      'json',
    ],
    { timeoutMs: 60_000, quiet: true, logAs: `aws sso list-account-roles --account-id ${accountId} (token omitido)`, env: netProcessEnv() },
  );
  if (result.code !== 0) fail('Não foi possível listar as roles da conta. O token pode ter expirado — tente de novo.');
  let roles: string[] = [];
  try {
    const parsed = JSON.parse(result.output) as { roleList?: Array<{ roleName: string }> };
    roles = (parsed.roleList ?? []).map((r) => r.roleName);
  } catch {
    fail('Resposta inesperada do aws sso list-account-roles.');
  }
  if (!roles.length) fail('Nenhuma role disponível nesta conta para o seu usuário.');
  if (roles.length === 1) {
    appendLog(`✓ Role selecionada automaticamente: ${roles[0]}\n`);
    await finishSetup(accountId, roles[0]);
    return;
  }
  state.status.roles = roles;
  setPhase('awaiting-role');
}

async function finishSetup(accountId: string, roleName: string): Promise<void> {
  setPhase('profile');
  const profile = `${accountId}_CONSUMER`;
  const portal = currentPortal();
  if (state.legacySso) {
    upsertConfigBlock(`profile ${profile}`, {
      sso_start_url: portal.startUrl,
      sso_region: portal.ssoRegion,
      sso_account_id: accountId,
      sso_role_name: roleName,
      region: AWS_REGION,
      output: 'json',
    });
    removeConfigBlock(`profile ${LEGACY_TMP_PROFILE}`);
  } else {
    upsertConfigBlock(`profile ${profile}`, {
      sso_session: portal.session,
      sso_account_id: accountId,
      sso_role_name: roleName,
      region: AWS_REGION,
      output: 'json',
    });
  }
  state.status.profile = profile;
  appendLog(`✓ Profile "${profile}" gravado em ~/.aws/config\n`);

  setPhase('register');
  const repoPath = state.status.repoPath ?? path.join(dataRoot(), 'mcp', REPO_DIR_NAME);
  const entry: McpServerEntry = {
    type: 'stdio',
    command: 'uv',
    args: ['--directory', repoPath, 'run', '--native-tls', 'python', 'run.py'],
    env: { AWS_DEFAULT_REGION: AWS_REGION, AWS_PROFILE: profile },
  };
  upsertServer(CONSUMERLAB_SERVER_NAME, entry);
  const info = await setServerEnabled(CONSUMERLAB_SERVER_NAME, true);
  if (info.status === 'error')
    fail(`Servidor registrado, mas falhou ao iniciar: ${info.error ?? 'erro desconhecido'}`);
  appendLog(`✓ Servidor "${CONSUMERLAB_SERVER_NAME}" ligado · ${info.toolCount} ferramenta(s).\n`);
  const account = (state.allAccounts ?? []).find((a) => a.id === accountId);
  const connection: ConsumerLabConnection = {
    accountId,
    accountName: account?.name ?? accountId,
    role: roleName,
    ssoPortal: portal.label,
    profile,
    connectedAt: new Date().toISOString(),
  };
  try {
    ensureDir(path.join(dataRoot(), 'mcp'));
    writeJsonAtomic(connectionPath(), connection);
  } catch {
    // melhor-esforço: sem o arquivo a conta só some da UI após reiniciar
  }
  state.status.connection = connection;
  appendLog(`✓ Conta conectada: ${connection.accountName} (${accountId}) · ${roleName}\n`);
  state.accessToken = undefined;
  state.status.running = false;
  setPhase('done');
}

function toError(err: unknown): void {
  state.status.running = false;
  state.status.error = err instanceof Error ? err.message : String(err);
  state.accessToken = undefined;
  setPhase('error');
}

// --- API usada pelas rotas ----------------------------------------------------

export function getConsumerLabStatus(): ConsumerLabStatus {
  const status = { ...state.status, accounts: state.status.accounts, roles: state.status.roles };
  // portais disponíveis, para a UI oferecer a escolha antes de iniciar
  status.ssoPortals = SSO_PORTALS.map(({ id, label }) => ({ id, label }));
  // fora de um setup em andamento, resgata do disco a conta do último setup
  // concluído (o estado em memória zera a cada restart da extensão)
  if (!status.connection && !status.running) {
    status.connection = readJson<ConsumerLabConnection>(connectionPath());
  }
  return status;
}

/** Dispara o setup do zero (idempotente enquanto estiver rodando). */
export function startConsumerLabSetup(portalId?: string): ConsumerLabStatus {
  if (state.status.running) return getConsumerLabStatus();
  // há quem só tenha conta no CTPRO — respeita a escolha feita na UI
  const portalIndex = Math.max(0, SSO_PORTALS.findIndex((p) => p.id === portalId));
  state = { status: { ...emptyStatus(), running: true }, portalIndex };
  appendLog(`Portal SSO escolhido: ${currentPortal().label}\n`);
  void (async () => {
    try {
      // GUI-launch deixa o PATH mínimo (sem nvm/homebrew no Mac, sem o PATH
      // persistido do registro no Win) → git/uv/aws "não encontrados"
      await resolveShellEnv();
      await checkPrerequisites();
      const repoPath = await setupRepository();
      await installDependencies(repoPath);
      await ssoLogin();
      await listAccounts();
      // segue no chooseConsumerLabAccount/Role via rotas
    } catch (err) {
      toError(err);
    }
  })();
  return getConsumerLabStatus();
}

export function chooseConsumerLabAccount(accountId: string): ConsumerLabStatus {
  if (state.status.phase !== 'awaiting-account')
    fail('O setup não está aguardando escolha de conta.');
  const account = (state.allAccounts ?? []).find((a) => a.id === accountId);
  if (!account) fail(`Conta "${accountId}" não está entre as contas disponíveis.`);
  appendLog(`✓ Conta selecionada: ${account.name} (${account.id})\n`);
  state.selectedAccountId = account.id;
  state.status.accounts = undefined;
  void listRoles(account.id).catch(toError);
  return getConsumerLabStatus();
}

/**
 * A conta não está na lista: troca para o próximo portal SSO e refaz o login
 * + listagem de contas por lá (o browser abre de novo, agora no outro start URL).
 */
export function switchConsumerLabSso(): ConsumerLabStatus {
  if (state.status.phase !== 'awaiting-account')
    fail('A troca de portal SSO só está disponível na escolha de conta.');
  state.portalIndex = (state.portalIndex + 1) % SSO_PORTALS.length;
  state.accessToken = undefined;
  state.allAccounts = undefined;
  state.status.accounts = undefined;
  appendLog(`\n↺ Trocando para o portal SSO: ${currentPortal().label}\n`);
  void (async () => {
    try {
      await ssoLogin();
      await listAccounts();
    } catch (err) {
      toError(err);
    }
  })();
  return getConsumerLabStatus();
}

export function chooseConsumerLabRole(roleName: string): ConsumerLabStatus {
  if (state.status.phase !== 'awaiting-role') fail('O setup não está aguardando escolha de role.');
  if (!(state.status.roles ?? []).includes(roleName)) fail(`Role "${roleName}" não está disponível.`);
  appendLog(`✓ Role selecionada: ${roleName}\n`);
  state.status.roles = undefined;
  void finishSetup(state.selectedAccountId!, roleName).catch(toError);
  return getConsumerLabStatus();
}

export function cancelConsumerLabSetup(): ConsumerLabStatus {
  if (!state.status.running) return getConsumerLabStatus();
  state.cancelled = true;
  try {
    state.child?.kill();
  } catch {
    /* processo já terminou */
  }
  state.status.running = false;
  state.status.error = 'Setup cancelado pelo usuário.';
  state.accessToken = undefined;
  setPhase('error');
  return getConsumerLabStatus();
}

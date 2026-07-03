import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { ConsumerLabAccount, ConsumerLabStatus, McpServerEntry } from '@aiportal/shared';
import { dataRoot, ensureDir } from '../storage/paths';
import { setServerEnabled, upsertServer } from './mcpManager';

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
 * Portais SSO onde a conta pode morar. O setup começa pela Landing Zone; se a
 * conta não aparecer na lista, o usuário troca para o próximo portal pela UI
 * (cada portal exige um login próprio no browser, então não dá para "validar
 * nos dois" de uma vez sem forçar duas autenticações em todo mundo).
 * Cada portal tem a PRÓPRIA região de SSO — a Landing Zone vive em us-east-1,
 * o CTPRO em sa-east-1; registrar/listar na região errada falha o login.
 */
interface SsoPortal {
  label: string;
  session: string;
  startUrl: string;
  ssoRegion: string;
}
const SSO_PORTALS: SsoPortal[] = [
  {
    label: 'Landing Zone (itaulzprod)',
    session: 'itau-sso',
    startUrl: 'https://itaulzprod.awsapps.com/start',
    ssoRegion: 'us-east-1',
  },
  {
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
  const merged = state.status.log + text;
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
  opts: { cwd?: string; timeoutMs?: number; quiet?: boolean; logAs?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (state.cancelled) {
      reject(new Error('Setup cancelado.'));
      return;
    }
    const useShell = process.platform === 'win32';
    appendLog(`\n$ ${opts.logAs ?? [command, ...args].join(' ')}\n`);
    const child = spawn(command, useShell ? args.map(quoteArg) : args, {
      cwd: opts.cwd,
      env: process.env,
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

  let uv = await versionOf('uv');
  if (!uv && process.platform === 'darwin') {
    appendLog('uv não encontrado — tentando instalar via brew…\n');
    await run('brew', ['install', 'uv', '--quiet'], { timeoutMs: 300_000 });
    uv = await versionOf('uv');
  }
  if (!uv && process.platform !== 'win32') {
    appendLog('uv não encontrado — tentando o instalador oficial…\n');
    await run('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'], { timeoutMs: 300_000 });
    process.env.PATH = `${path.join(os.homedir(), '.local', 'bin')}:${path.join(os.homedir(), '.cargo', 'bin')}:${process.env.PATH ?? ''}`;
    uv = await versionOf('uv');
  }
  if (uv) appendLog(`✓ ${uv}\n`);
  else
    problems.push(
      process.platform === 'win32'
        ? 'uv não encontrado. Instale-o (ex: pip install uv) e tente de novo.'
        : 'Falha ao instalar o uv automaticamente. Rode manualmente: brew install uv',
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

async function setupRepository(): Promise<string> {
  setPhase('repo');
  const parent = path.join(dataRoot(), 'mcp');
  ensureDir(parent);
  const repoPath = path.join(parent, REPO_DIR_NAME);
  if (fs.existsSync(path.join(repoPath, '.git'))) {
    appendLog('Repositório já existe — atualizando…\n');
    const pull = await run('git', ['pull', '--ff-only'], { cwd: repoPath, timeoutMs: 120_000 });
    if (pull.code !== 0) appendLog('⚠ Não foi possível atualizar (seguindo com a versão local).\n');
  } else {
    const clone = await run('git', ['clone', REPO_URL, repoPath], { timeoutMs: 300_000 });
    if (clone.code !== 0)
      fail('Falha ao clonar o repositório. Verifique seu acesso ao GitHub corporativo (SSO Itaú).');
  }
  state.status.repoPath = repoPath;
  return repoPath;
}

async function installDependencies(repoPath: string): Promise<void> {
  setPhase('deps');
  const sync = await run('uv', ['sync', '--native-tls'], { cwd: repoPath, timeoutMs: 900_000 });
  if (sync.code !== 0)
    fail('Falha ao instalar dependências. Tente manualmente: uv sync --native-tls (na pasta do repositório).');
}

async function ssoLogin(): Promise<void> {
  const portal = currentPortal();
  setPhase('sso-login');
  appendLog(`\nO browser vai abrir para o login SSO — ${portal.label}. Autentique-se e volte aqui.\n`);
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
    const login = await run('aws', ['sso', 'login', '--profile', LEGACY_TMP_PROFILE], { timeoutMs: 600_000 });
    if (login.code !== 0) fail('Falha no login SSO. Verifique sua conexão e tente novamente.');
  } else {
    // sempre reescreve o bloco: um bloco antigo com região/URL erradas não
    // pode sobreviver só porque o header já existe no ~/.aws/config
    upsertConfigBlock(`sso-session ${portal.session}`, {
      sso_start_url: portal.startUrl,
      sso_region: portal.ssoRegion,
      sso_registration_scopes: 'sso:account:access',
    });
    const login = await run('aws', ['sso', 'login', '--sso-session', portal.session], { timeoutMs: 600_000 });
    if (login.code !== 0) fail('Falha no login SSO. Verifique sua conexão e tente novamente.');
  }

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
    { timeoutMs: 60_000, quiet: true, logAs: 'aws sso list-accounts (token omitido)' },
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
    { timeoutMs: 60_000, quiet: true, logAs: `aws sso list-account-roles --account-id ${accountId} (token omitido)` },
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
  return { ...state.status, accounts: state.status.accounts, roles: state.status.roles };
}

/** Dispara o setup do zero (idempotente enquanto estiver rodando). */
export function startConsumerLabSetup(): ConsumerLabStatus {
  if (state.status.running) return getConsumerLabStatus();
  state = { status: { ...emptyStatus(), running: true }, portalIndex: 0 };
  void (async () => {
    try {
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

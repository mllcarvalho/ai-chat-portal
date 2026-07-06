import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { IuclickStatus, McpServerEntry } from '@aiportal/shared';
import {
  IUCLICK_SERVER_NAME,
  hasIuclickCredentials,
  saveIuclickCredentials,
} from '../storage/iuclickStore';
import { readMcpJson, setServerEnabled, stopServer, upsertServer } from './mcpManager';
import { netProcessEnv, resolveShellEnv } from './netEnv';
import { captureIuclickCredentials } from './iuclickAuth';

/**
 * Setup guiado do MCP IUClick (ServiceNow Itaú) — porta da doc interna
 * "[MCP][ALL] Guia de Uso: Service Now MCP Server" para dentro do portal:
 * pré-requisitos (Node >= 18, npx), registry privado do Itaú no ~/.npmrc,
 * download/validação do pacote no Artifactory e registro do servidor stdio
 * (npx -y @ai-stack-fn7/mcp-servers service-now --stdio) no mcp.json.
 * Mesmo padrão do ConsumerLab: processo em background + log acumulado +
 * polling via GET — mas sem fases awaiting-*, o fluxo corre de ponta a ponta.
 *
 * Cookie/X-UserToken (capturados do browser em itau.service-now.com) são
 * opcionais: quando informados vão para o SecretStorage e entram como env na
 * subida do servidor; sem eles a autenticação é feita pela tool `login` do
 * próprio MCP durante a sessão de chat.
 */

export { IUCLICK_SERVER_NAME };

const NPM_SCOPE = '@ai-stack-fn7';
const REGISTRY_URL =
  'https://artifactory.prod.aws.cloud.ihf/artifactory/api/npm/itau-fn7-npm-release/';
const PACKAGE_NAME = '@ai-stack-fn7/mcp-servers';
const LOG_LIMIT = 8000;

const PHASE_LABELS: Record<IuclickStatus['phase'], string> = {
  idle: 'Aguardando início',
  prereqs: 'Verificando pré-requisitos (Node.js >= 18, npx)…',
  registry: `Configurando o registry privado do Itaú (${NPM_SCOPE}) no ~/.npmrc…`,
  package: `Baixando o pacote ${PACKAGE_NAME} do Artifactory…`,
  register: 'Registrando e ligando o servidor MCP…',
  done: 'Setup concluído — servidor ligado',
  error: 'Falha no setup',
};

interface SetupState {
  status: IuclickStatus;
  child?: ChildProcess;
  cancelled?: boolean;
}

let state: SetupState = { status: emptyStatus() };

function emptyStatus(): IuclickStatus {
  return { running: false, phase: 'idle', phaseLabel: PHASE_LABELS.idle, log: '' };
}

function setPhase(phase: IuclickStatus['phase']): void {
  state.status.phase = phase;
  state.status.phaseLabel = PHASE_LABELS[phase];
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
  opts: { timeoutMs?: number; quiet?: boolean; logAs?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (state.cancelled) {
      reject(new Error('Setup cancelado.'));
      return;
    }
    const useShell = process.platform === 'win32';
    appendLog(`\n$ ${opts.logAs ?? [command, ...args].join(' ')}\n`);
    const child = spawn(command, useShell ? args.map(quoteArg) : args, {
      // npm precisa do proxy/CA corporativos para alcançar o Artifactory
      env: { ...process.env, ...netProcessEnv() },
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

// --- Passos do setup ---------------------------------------------------------

async function checkPrerequisites(): Promise<void> {
  setPhase('prereqs');
  const problems: string[] = [];

  // o PATH da GUI é mínimo; o portal já resolve o do shell/registro, mas se
  // ainda faltar node/npx a dica é reabrir o VS Code pelo terminal onde eles
  // funcionam (`code .`) — daí o PATH completo é herdado
  const pathHint =
    ' Se você usa nvm/Volta/fnm ou instalou o Node há pouco, feche o VS Code e reabra pelo terminal com `code .` (onde o `npx` funciona) e tente de novo.';

  const node = await versionOf('node');
  const major = Number(node?.match(/v(\d+)/)?.[1] ?? 0);
  if (node && major >= 18) appendLog(`✓ Node.js ${node}\n`);
  else if (node) problems.push(`Node.js ${node} é antigo — o MCP exige v18 ou superior (nodejs.org).`);
  else problems.push(`Node.js não encontrado no PATH.${pathHint}`);

  const npx = await versionOf('npx');
  if (npx) appendLog(`✓ npx ${npx}\n`);
  else if (node) problems.push(`npx não encontrado no PATH (vem junto com o Node.js/npm).${pathHint}`);

  if (problems.length) fail(problems.join('\n'));
}

/**
 * Garante a linha `@ai-stack-fn7:registry=…` no ~/.npmrc global (idempotente:
 * substitui uma linha antiga do mesmo scope, preserva o resto do arquivo).
 */
function configureRegistry(): void {
  setPhase('registry');
  const npmrcPath = path.join(os.homedir(), '.npmrc');
  const line = `${NPM_SCOPE}:registry=${REGISTRY_URL}`;
  let content = '';
  try {
    content = fs.readFileSync(npmrcPath, 'utf8');
  } catch {
    // sem ~/.npmrc ainda
  }
  const lines = content.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trim().startsWith(`${NPM_SCOPE}:registry=`));
  if (idx >= 0 && lines[idx].trim() === line) {
    appendLog(`✓ Registry do scope ${NPM_SCOPE} já configurado no ~/.npmrc\n`);
    return;
  }
  if (idx >= 0) lines[idx] = line;
  else lines.push(...(content && !content.endsWith('\n') ? [''] : []), line);
  fs.writeFileSync(npmrcPath, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
  appendLog(`✓ Registry gravado no ~/.npmrc: ${line}\n`);
}

/**
 * Valida o acesso ao pacote no Artifactory e pré-aquece o cache do npx
 * (~/.npm/_npx) — assim a subida real do servidor não estoura o timeout e
 * qualquer problema de rede/registry aparece aqui, com log visível.
 */
async function fetchPackage(): Promise<void> {
  setPhase('package');
  const view = await run('npm', ['view', PACKAGE_NAME, 'version'], { timeoutMs: 120_000 });
  if (view.code !== 0)
    fail(
      `Não foi possível resolver o pacote ${PACKAGE_NAME} no Artifactory. ` +
        'Confira VPN/proxy corporativo e o acesso ao registry do Itaú.',
    );
  const version = view.output.trim().split('\n').pop()?.trim();
  appendLog(`✓ Pacote disponível: ${PACKAGE_NAME}@${version}\n`);

  // npm exec instala no mesmo cache que o npx usa e sai na hora (node -v)
  const warm = await run(
    'npm',
    ['exec', '--yes', '--package', PACKAGE_NAME, '--', 'node', '-v'],
    { timeoutMs: 300_000, logAs: `npm exec --yes --package ${PACKAGE_NAME} (pré-download)` },
  );
  if (warm.code !== 0)
    fail(
      `Falha ao baixar o ${PACKAGE_NAME}. Se o erro persistir, limpe o cache do npx ` +
        '(rm -rf ~/.npm/_npx) e tente de novo.',
    );
  appendLog('✓ Pacote baixado no cache do npx\n');
}

async function registerServer(): Promise<void> {
  setPhase('register');
  // Opção B da doc: sem env no mcp.json — Cookie/X-UserToken ficam no
  // SecretStorage e o mcpManager injeta na hora do spawn
  const entry: McpServerEntry = {
    type: 'stdio',
    command: 'npx',
    args: ['-y', PACKAGE_NAME, 'service-now', '--stdio'],
  };
  upsertServer(IUCLICK_SERVER_NAME, entry);
  const info = await setServerEnabled(IUCLICK_SERVER_NAME, true);
  if (info.status === 'error')
    fail(`Servidor registrado, mas falhou ao iniciar: ${info.error ?? 'erro desconhecido'}`);
  appendLog(`✓ Servidor "${IUCLICK_SERVER_NAME}" ligado · ${info.toolCount} ferramenta(s).\n`);
  state.status.running = false;
  setPhase('done');
}

function toError(err: unknown): void {
  state.status.running = false;
  state.status.error = err instanceof Error ? err.message : String(err);
  setPhase('error');
}

// --- API usada pelas rotas ----------------------------------------------------

export async function getIuclickStatus(): Promise<IuclickStatus> {
  return {
    ...state.status,
    hasCredentials: await hasIuclickCredentials(),
    installed: !!readMcpJson()[IUCLICK_SERVER_NAME],
  };
}

/**
 * Dispara o setup do zero (idempotente enquanto estiver rodando). Cookie e
 * X-UserToken são opcionais, mas vêm juntos: com só um dos dois o MCP não
 * autentica e o erro ficaria para depois, sem contexto.
 */
export async function startIuclickSetup(cookies?: string, token?: string): Promise<IuclickStatus> {
  if (state.status.running) return getIuclickStatus();
  const cleanCookies = cookies?.trim() ?? '';
  const cleanToken = token?.trim() ?? '';
  if (!!cleanCookies !== !!cleanToken)
    throw new Error('Informe Cookie e X-UserToken juntos (ou deixe ambos vazios para usar a tool login).');

  state = { status: { ...emptyStatus(), running: true } };
  void (async () => {
    try {
      await resolveShellEnv();
      if (cleanCookies && cleanToken) {
        await saveIuclickCredentials(cleanCookies, cleanToken);
        appendLog('✓ Cookie e X-UserToken guardados no SecretStorage (não vão para o mcp.json)\n');
      }
      await checkPrerequisites();
      configureRegistry();
      await fetchPackage();
      await registerServer();
    } catch (err) {
      toError(err);
    }
  })();
  return getIuclickStatus();
}

/**
 * Reautenticação sem refazer o setup: a sessão do ServiceNow expira com
 * frequência e o resto (registry, pacote, mcp.json) continua válido — só as
 * credenciais mudam. Salva no SecretStorage e religa o servidor para o env
 * novo entrar. Usada pelo botão "Só atualizar credenciais" e pelo bookmarklet
 * de captura (via /api/capture).
 */
export async function reauthIuclick(
  cookies: string,
  userToken: string,
): Promise<{ message: string }> {
  const cleanCookies = cookies.trim();
  const cleanToken = userToken.trim();
  if (!cleanCookies || !cleanToken) throw new Error('Informe Cookie e X-UserToken');
  await saveIuclickCredentials(cleanCookies, cleanToken);
  // JSESSIONID HttpOnly não aparece no document.cookie do bookmarklet — salva
  // mesmo assim, mas avisa que a captura manual pode ser necessária
  const warn = /JSESSIONID=/i.test(cleanCookies)
    ? ''
    : ' Atenção: os cookies vieram sem JSESSIONID (HttpOnly?) — se o MCP não autenticar, capture pelo DevTools.';
  if (!readMcpJson()[IUCLICK_SERVER_NAME]) {
    return { message: `Credenciais guardadas — agora rode o setup do IUClick no portal.${warn}` };
  }
  await stopServer(IUCLICK_SERVER_NAME);
  const info = await setServerEnabled(IUCLICK_SERVER_NAME, true);
  if (info.status === 'error')
    throw new Error(`Credenciais salvas, mas o servidor falhou ao religar: ${info.error ?? 'erro desconhecido'}`);
  return {
    message: `Credenciais atualizadas — IUClick religado com ${info.toolCount} ferramenta(s).${warn}`,
  };
}

/**
 * Detecção 100% automática: lê os cookies (inclusive o JSESSIONID HttpOnly) do
 * navegador, VALIDA a sessão e pega o X-UserToken numa página autenticada
 * (captureIuclickCredentials cuida disso — rejeita a tela de login e usa o par
 * cookie+token consistente), depois instala/religa o MCP. Sem tocar no DevTools.
 */
export async function autoDetectIuclick(): Promise<{ message: string }> {
  const cap = await captureIuclickCredentials();
  // servidor ainda não instalado: detecta E instala numa tacada só (o setup
  // roda em background com as credenciais; a UI acompanha pelo polling)
  if (!readMcpJson()[IUCLICK_SERVER_NAME]) {
    await startIuclickSetup(cap.cookies, cap.token);
    return { message: `Credenciais detectadas e validadas (${cap.browser}/${cap.profile}). Instalando o servidor…` };
  }
  const result = await reauthIuclick(cap.cookies, cap.token);
  return { message: `${result.message} — via ${cap.browser}/${cap.profile}.` };
}

export async function cancelIuclickSetup(): Promise<IuclickStatus> {
  if (!state.status.running) return getIuclickStatus();
  state.cancelled = true;
  try {
    state.child?.kill();
  } catch {
    // processo já terminou
  }
  state.status.running = false;
  state.status.error = 'Setup cancelado pelo usuário.';
  setPhase('error');
  return getIuclickStatus();
}

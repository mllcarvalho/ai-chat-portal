import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { DiagnosticCheck, DiagnosticsReport } from '@aiportal/shared';
import {
  OFFICE_IMPORTS,
  OFFICE_LIBS,
  findHealthyPython,
  getEnvStatus,
  portalVenvDir,
  portalVenvPython,
} from './envCheck';
import { netProcessEnv, netStatus, requestInitFor, resolveShellEnv } from './netEnv';

/**
 * Diagnóstico do ambiente da máquina — roda em background quando o portal
 * abre no browser e sob demanda na página "Diagnóstico". Verifica o que os
 * setups de MCP vão precisar (git, python, uv, AWS CLI), se o git está
 * configurado para a rede corporativa (proxy + CA) e se o GitHub está
 * alcançável — para o usuário descobrir o que falta ANTES de um setup falhar
 * no meio (ex.: clone do ConsumerLab com 502 do proxy).
 *
 * `fail` = interrompe (banner no portal); `warn` = só aparece na página
 * (limita um recurso específico, não bloqueia o uso geral).
 */

const REPO_TESTE = 'https://github.com/git/git';

let report: DiagnosticsReport = { running: false, checks: [], problemCount: 0 };
let running = false;

/** Esconde a senha de URLs de proxy (http://user:senha@host) para exibição. */
function maskProxy(url: string): string {
  return url.replace(/(\/\/[^:/@]+:)[^@]*@/, '$1****@');
}

interface CmdResult {
  code: number | null;
  output: string;
}

/** Executa um binário com o env de rede corporativo; nunca rejeita. */
function cmd(
  command: string,
  args: string[],
  timeoutMs = 30_000,
  extraEnv: Record<string, string> = {},
): Promise<CmdResult> {
  // com shell no Windows o Node só concatena — caminhos com espaço
  // (C:\Users\Nome Sobrenome\...) precisam de aspas manuais
  const useShell = process.platform === 'win32';
  const q = (s: string) => (useShell && /\s/.test(s) ? `"${s}"` : s);
  return new Promise((resolve) => {
    execFile(
      q(command),
      args.map(q),
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        // PATHEXT no Windows (aws.cmd etc.) só resolve com shell
        shell: useShell,
        env: { ...process.env, ...netProcessEnv(), ...extraEnv },
      },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`.trim();
        if (!err) {
          resolve({ code: 0, output });
          return;
        }
        const code = typeof (err as NodeJS.ErrnoException).code === 'number' ? ((err as NodeJS.ErrnoException).code as unknown as number) : null;
        resolve({ code: code ?? 1, output: output || err.message });
      },
    );
  });
}

/** Primeira linha da saída de `cmd --version` (ou undefined se falhou). */
async function versionOf(command: string, args = ['--version']): Promise<string | undefined> {
  const r = await cmd(command, args, 20_000);
  if (r.code !== 0) return undefined;
  const line = r.output.split('\n')[0]?.trim();
  return line || undefined;
}

function update(check: DiagnosticCheck): void {
  const i = report.checks.findIndex((c) => c.id === check.id);
  if (i >= 0) report.checks[i] = check;
  else report.checks.push(check);
}

// --- Checks -------------------------------------------------------------------

async function checkNode(): Promise<void> {
  const v = await versionOf('node');
  update(
    v
      ? { id: 'node', label: 'Node.js', status: 'ok', detail: v }
      : {
          id: 'node',
          label: 'Node.js',
          status: 'fail',
          hint: 'Node.js não encontrado no PATH — servidores MCP via npx e a instalação do BMAD não funcionam. Instale o Node.js (LTS) e reabra o VS Code.',
        },
  );
}

async function checkGit(): Promise<void> {
  const v = await versionOf('git');
  update(
    v
      ? { id: 'git', label: 'Git', status: 'ok', detail: v }
      : {
          id: 'git',
          label: 'Git',
          status: 'fail',
          hint: 'Git não encontrado — o setup do ConsumerLab (clone do repositório) não funciona. Instale via Central de Software.',
        },
  );
}

async function checkPython(): Promise<void> {
  for (const py of ['python3', 'python', 'py']) {
    const v = await versionOf(py);
    // o stub da Microsoft Store falha no --version, então não passa aqui
    const m = v?.match(/Python (\d+)\.(\d+)/);
    if (m && Number(m[1]) >= 3 && Number(m[2]) >= 9) {
      update({ id: 'python', label: 'Python', status: 'ok', detail: v });
      return;
    }
  }
  update({
    id: 'python',
    label: 'Python',
    status: 'warn',
    hint: 'Python >= 3.11 não encontrado — necessário para o MCP ConsumerLab. Instale via Central de Software.',
  });
}

async function checkUv(): Promise<void> {
  const v = await versionOf('uv');
  update(
    v
      ? { id: 'uv', label: 'uv (gerenciador Python)', status: 'ok', detail: v }
      : {
          id: 'uv',
          label: 'uv (gerenciador Python)',
          status: 'warn',
          hint: 'uv não encontrado — necessário para o MCP ConsumerLab.',
          fixId: 'install-uv',
          fixLabel: 'Instalar uv',
        },
  );
}

async function checkAws(): Promise<void> {
  const v = await versionOf('aws');
  update(
    v
      ? { id: 'aws', label: 'AWS CLI', status: 'ok', detail: v }
      : {
          id: 'aws',
          label: 'AWS CLI',
          status: 'warn',
          hint: 'AWS CLI não encontrada — necessária para o login SSO do MCP ConsumerLab. Instale via Central de Software (versão >= 2.0).',
        },
  );
}

/**
 * Venv compartilhado do portal com as bibliotecas de geração de documentos
 * (PPT/Excel/Word/PDF). Sem ele a geração ainda funciona quando há uv (baixa
 * as bibliotecas sob demanda), mas o passo opcional deixa tudo pronto de uma
 * vez — evita espera/falha de download na primeira geração e cobre máquinas
 * sem uv.
 */
async function checkOffice(): Promise<void> {
  const id = 'office';
  const officeLabel = 'Geração de documentos (PPT, Excel, Word, PDF)';
  const vpy = portalVenvPython();
  if (fs.existsSync(vpy)) {
    const r = await cmd(vpy, ['-c', `import ${OFFICE_IMPORTS}`], 20_000);
    if (r.code === 0) {
      update({
        id,
        label: officeLabel,
        status: 'ok',
        detail: 'bibliotecas instaladas no ambiente Python do portal',
      });
      return;
    }
  }
  const uvOk = !!(await versionOf('uv'));
  update({
    id,
    label: officeLabel,
    status: 'warn',
    detail: uvOk
      ? 'o uv baixa as bibliotecas sob demanda na primeira geração — instalar agora é opcional'
      : undefined,
    hint:
      'Passo opcional: instala python-pptx, openpyxl, python-docx, reportlab e pandas num ' +
      'ambiente Python exclusivo do portal (~300 MB), para o chat gerar apresentações, ' +
      'planilhas, documentos e PDFs sem depender de download na hora.',
    fixId: 'office-libs',
    fixLabel: 'Instalar bibliotecas',
  });
}

function checkCaEnv(): void {
  const env = netProcessEnv();
  const ca = env.NODE_EXTRA_CA_CERTS;
  if (!ca) {
    update({
      id: 'ca-env',
      label: 'Certificado corporativo (CA)',
      status: 'warn',
      hint: 'Nenhuma CA interna configurada — conexões HTTPS interceptadas pela rede podem falhar. Rode o script de bootstrap ou informe o PEM em Configurações → Rede.',
    });
    return;
  }
  let readable = false;
  try {
    fs.accessSync(ca);
    readable = true;
  } catch {
    readable = false;
  }
  update(
    readable
      ? { id: 'ca-env', label: 'Certificado corporativo (CA)', status: 'ok', detail: ca }
      : {
          id: 'ca-env',
          label: 'Certificado corporativo (CA)',
          status: 'fail',
          detail: ca,
          hint: 'O arquivo da CA está configurado mas NÃO existe no disco — corrija o caminho em Configurações → Rede ou rode o bootstrap de novo.',
        },
  );
}

function checkProxyEnv(): void {
  const env = netProcessEnv();
  const proxy = env.HTTPS_PROXY;
  update(
    proxy
      ? { id: 'proxy-env', label: 'Proxy corporativo', status: 'ok', detail: maskProxy(proxy) }
      : {
          id: 'proxy-env',
          label: 'Proxy corporativo',
          status: 'warn',
          hint: 'Sem proxy configurado — ok fora da rede corporativa. Na rede Itaú, faça o login RACF do portal (grava o proxy) ou informe em Configurações → Rede.',
        },
  );
}

/**
 * O git NÃO lê NODE_EXTRA_CA_CERTS nem a config do portal — usa a própria
 * configuração (http.proxy / http.sslCAInfo). Aqui comparamos o que o git tem
 * com o que o ambiente diz que deveria ter; a correção aplica os dois.
 */
async function checkGitNetwork(): Promise<void> {
  const id = 'git-network';
  const label = 'Git configurado para a rede';
  if (!(await versionOf('git'))) {
    update({ id, label, status: 'warn', hint: 'Instale o Git primeiro.' });
    return;
  }
  const env = netProcessEnv();
  const wantProxy = env.HTTPS_PROXY;
  const wantCa = env.AWS_CA_BUNDLE ?? env.NODE_EXTRA_CA_CERTS;
  // chave ausente = exit code 1 — tratar como "não configurado", não como valor
  const gp = await cmd('git', ['config', '--global', '--get', 'http.proxy']);
  const gitProxy = gp.code === 0 ? gp.output.trim() : '';
  const gc = await cmd('git', ['config', '--global', '--get', 'http.sslCAInfo']);
  const gitCa = gc.code === 0 ? gc.output.trim() : '';

  const pending: string[] = [];
  if (wantProxy && gitProxy !== wantProxy) pending.push('proxy');
  if (wantCa && !gitCa) pending.push('CA');
  if (!wantProxy && !wantCa) {
    update({ id, label, status: 'ok', detail: 'Sem proxy/CA corporativos para aplicar.' });
    return;
  }
  if (!pending.length) {
    update({
      id,
      label,
      status: 'ok',
      detail: [gitProxy && `proxy: ${maskProxy(gitProxy)}`, gitCa && `CA: ${gitCa}`]
        .filter(Boolean)
        .join(' · '),
    });
    return;
  }
  update({
    id,
    label,
    status: 'warn',
    detail: gitProxy ? `proxy atual: ${maskProxy(gitProxy)}` : 'git sem proxy/CA próprios',
    hint: `O git não está usando ${pending.join(' e ')} da rede corporativa — clones (ex.: setup do ConsumerLab) podem falhar.`,
    fixId: 'git-network',
    fixLabel: 'Configurar git',
  });
}

const label = 'Conectividade com o GitHub';

/**
 * O git alcançou o servidor mas o proxy/HTTP quebrou o protocolo? Esses erros
 * significam que a rede FUNCIONA — é um problema de protocolo (clássico: proxy
 * corporativo + HTTP/2), não de conectividade. Por isso forçamos HTTP/1.1 no
 * teste e tratamos esses casos como "alcançou".
 */
function gitReachedButProtocol(output: string): boolean {
  return /expected flush|protocol error|RPC failed|early EOF|unexpected disconnect|The requested URL returned error: 4\d\d/i.test(
    output,
  );
}

/**
 * Testa alcançar o GitHub de verdade. Primário: `fetch` ao endpoint git-over-
 * HTTPS pelo MESMO caminho de rede do portal (proxy + CA via undici) — é o que
 * reflete se o portal e os clones vão funcionar; se vier resposta que não é o
 * protocolo do git (página HTML, 407 etc.), é o proxy falando no lugar do
 * GitHub. Confirmação: `git ls-remote` forçando HTTP/1.1 (evita o "expected
 * flush after ref listing" de proxies que não suportam HTTP/2). Só reporta
 * falha se ambos indicarem rede indisponível.
 */
async function checkGithub(): Promise<void> {
  const refsUrl = `${REPO_TESTE}/info/refs?service=git-upload-pack`;
  // 1) fetch pelo dispatcher do portal (proxy/CA) — só é "alcançou de fato" se
  // a resposta for o protocolo do git, não qualquer 200 (proxies devolvem
  // página de bloqueio/auth com 200)
  let proxyPage: string | undefined;
  try {
    const res = await fetch(refsUrl, {
      ...requestInitFor(refsUrl, { 'User-Agent': 'git/2.40', Accept: '*/*' }),
      signal: AbortSignal.timeout(20_000),
    } as RequestInit);
    const type = res.headers.get('content-type') ?? '';
    if (res.status === 200 && type.includes('git-upload-pack-advertisement')) {
      update({ id: 'github', label, status: 'ok', detail: 'alcançável via HTTPS (proxy/CA OK)' });
      return;
    }
    const body = (await res.text().catch(() => '')).slice(0, 2048);
    if (res.status === 200 && body.includes('# service=git-upload-pack')) {
      // proxy trocou o content-type mas o protocolo passou inteiro
      update({ id: 'github', label, status: 'ok', detail: 'alcançável via HTTPS (proxy/CA OK)' });
      return;
    }
    const title = body.match(/<title[^>]*>\s*([^<]{1,120})/i)?.[1]?.trim();
    proxyPage = `o proxy respondeu HTTP ${res.status}${title ? ` ("${title}")` : ''} no lugar do protocolo do git`;
  } catch {
    // sem rede pelo fetch — tenta o git abaixo
  }

  // 2) git ls-remote forçando HTTP/1.1 (contorna o bug de HTTP/2 no proxy)
  const r = await cmd(
    'git',
    ['-c', 'http.version=HTTP/1.1', 'ls-remote', REPO_TESTE, 'HEAD'],
    30_000,
  );
  if (r.code === 0) {
    update({ id: 'github', label, status: 'ok', detail: 'git ls-remote OK' });
    return;
  }
  if (proxyPage || gitReachedButProtocol(r.output)) {
    // o teste do git já força HTTP/1.1, então sugerir http.version não ajuda
    // quem cai aqui — a causa é o proxy respondendo no lugar do GitHub
    update({
      id: 'github',
      label,
      status: 'warn',
      detail: proxyPage ?? (r.output.split('\n').filter(Boolean).pop() ?? '').slice(0, 200),
      hint: 'A resposta veio do proxy, não do GitHub — clones vão falhar. Verifique se está autenticado no proxy/VPN (ex.: Zscaler ativo) ou peça liberação de acesso git a github.com na rede.',
    });
    return;
  }
  const lastLine = r.output.split('\n').filter(Boolean).pop() ?? 'sem detalhes';
  update({
    id: 'github',
    label,
    status: 'fail',
    detail: lastLine.slice(0, 300),
    hint: `Não foi possível alcançar o github.com — verifique VPN/rede e o proxy. (${netStatus(REPO_TESTE)})`,
  });
}

/**
 * A renovação do token de sessão do Copilot (o de ~30 min usado contra
 * api.githubcopilot.com) passa por api.github.com — host diferente do
 * github.com testado acima. Quando a rede bloqueia este aqui, o chat funciona
 * por ~30 min e então começa a dar "token expired or invalid: 403" porque a
 * renovação nunca completa. Este check aponta essa causa na hora.
 */
async function checkGithubApi(): Promise<void> {
  const id = 'github-api';
  const apiLabel = 'Renovação da sessão do Copilot (api.github.com)';
  const url = 'https://api.github.com/';
  try {
    const res = await fetch(url, {
      ...requestInitFor(url, {
        'User-Agent': 'ai-chat-portal-diagnostics',
        Accept: 'application/vnd.github+json',
      }),
      signal: AbortSignal.timeout(15_000),
    } as RequestInit);
    const body = (await res.text().catch(() => '')).slice(0, 2048);
    // a API do GitHub responde JSON até para 403 de rate limit — qualquer JSON
    // prova que alcançamos o GitHub de verdade, e não uma página do proxy
    if (body.trimStart().startsWith('{')) {
      update({ id, label: apiLabel, status: 'ok', detail: 'alcançável via HTTPS (proxy/CA OK)' });
      return;
    }
    const title = body.match(/<title[^>]*>\s*([^<]{1,120})/i)?.[1]?.trim();
    update({
      id,
      label: apiLabel,
      status: 'warn',
      detail: `resposta HTTP ${res.status}${title ? ` ("${title}")` : ''} não veio do GitHub`,
      hint:
        'Sem api.github.com o Copilot não renova o token de sessão — o chat funciona por ~30 min ' +
        'e depois dá "token expired or invalid: 403". Peça liberação de api.github.com no proxy/rede.',
    });
  } catch (err) {
    update({
      id,
      label: apiLabel,
      status: 'warn',
      detail: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      hint:
        'Não foi possível alcançar api.github.com — a renovação da sessão do Copilot falha e o ' +
        'chat passa a dar 403 após ~30 min de uso. Verifique VPN/proxy.',
    });
  }
}

// --- Orquestração ---------------------------------------------------------------

const CHECK_SEED: Array<{ id: string; label: string }> = [
  { id: 'node', label: 'Node.js' },
  { id: 'git', label: 'Git' },
  { id: 'python', label: 'Python' },
  { id: 'uv', label: 'uv (gerenciador Python)' },
  { id: 'aws', label: 'AWS CLI' },
  { id: 'office', label: 'Geração de documentos (PPT, Excel, Word, PDF)' },
  { id: 'ca-env', label: 'Certificado corporativo (CA)' },
  { id: 'proxy-env', label: 'Proxy corporativo' },
  { id: 'git-network', label: 'Git configurado para a rede' },
  { id: 'github', label: 'Conectividade com o GitHub' },
  { id: 'github-api', label: 'Renovação da sessão do Copilot (api.github.com)' },
];

export function getDiagnosticsReport(): DiagnosticsReport {
  return { ...report, checks: [...report.checks] };
}

/** Dispara o diagnóstico em background (idempotente enquanto roda). */
export function startDiagnostics(): DiagnosticsReport {
  if (running) return getDiagnosticsReport();
  running = true;
  report = {
    running: true,
    startedAt: new Date().toISOString(),
    checks: CHECK_SEED.map((c) => ({ ...c, status: 'running' as const })),
    problemCount: 0,
  };
  void (async () => {
    try {
      // VS Code aberto pela GUI tem PATH mínimo — importa o PATH real primeiro
      await resolveShellEnv();
      checkCaEnv();
      checkProxyEnv();
      await Promise.all([
        checkNode(),
        checkGit(),
        checkPython(),
        checkUv(),
        checkAws(),
        checkOffice(),
      ]);
      await checkGitNetwork();
      await Promise.all([checkGithub(), checkGithubApi()]);
    } catch (err) {
      // diagnóstico nunca deve "quebrar": marca o que faltou como fail
      for (const c of report.checks) {
        if (c.status === 'running') {
          update({ ...c, status: 'fail', hint: `Falha inesperada: ${(err as Error).message}` });
        }
      }
    } finally {
      report.problemCount = report.checks.filter((c) => c.status === 'fail').length;
      report.finishedAt = new Date().toISOString();
      report.running = false;
      running = false;
    }
  })();
  return getDiagnosticsReport();
}

/**
 * Texto pronto para o usuário colar num chat de suporte: versões, ambiente,
 * rede (mascarada) e o resultado dos checks — substitui a foto da tela.
 */
export function buildSupportReport(version: string, buildId?: number): string {
  const env = getEnvStatus();
  const net = netProcessEnv();
  const lines = [
    'BMAD Product Studio — relatório de suporte',
    `Gerado em: ${new Date().toISOString()}`,
    `Portal: v${version}${buildId ? ` (build ${buildId})` : ''} · VS Code ${vscode.version} · ${process.platform} ${os.release()} ${process.arch}`,
    `Ambiente: node ${env.node ?? 'não encontrado'} · shell ${env.bash ?? 'não encontrado'} · python ${env.python ?? 'não encontrado'}`,
    `Proxy: ${net.HTTPS_PROXY ? maskProxy(net.HTTPS_PROXY) : 'não configurado'}`,
    `CA corporativa: ${net.NODE_EXTRA_CA_CERTS ?? 'não configurada'}`,
    '',
    report.finishedAt
      ? `Diagnóstico (${report.finishedAt}):`
      : 'Diagnóstico: ainda não executado.',
    ...report.checks.map(
      (c) =>
        `  [${c.status}] ${c.label}${c.detail ? ` — ${c.detail}` : ''}${c.hint ? `\n      ${c.hint}` : ''}`,
    ),
  ];
  return lines.join('\n');
}

/** Correções automáticas da página de Diagnóstico. Devolve mensagem de sucesso. */
export async function fixDiagnostic(fixId: string): Promise<string> {
  if (running) throw new Error('Aguarde o diagnóstico terminar antes de corrigir.');
  switch (fixId) {
    case 'install-uv': {
      await resolveShellEnv();
      // import tardio: consumerLabSetup puxa mcpManager/vscode, que este
      // módulo não precisa para os checks — só para esta correção
      const { ensureUv } = await import('./consumerLabSetup');
      const version = await ensureUv();
      if (!version)
        throw new Error(
          process.platform === 'win32'
            ? 'Falha ao instalar o uv. Rode no Git Bash: curl -LsSf https://astral.sh/uv/install.sh | sh — e reabra o VS Code. (Evite o PowerShell: costuma ser bloqueado pelo antivírus corporativo.)'
            : 'Falha ao instalar o uv. Rode: brew install uv (ou curl -LsSf https://astral.sh/uv/install.sh | sh) e reabra o VS Code.',
        );
      return `uv instalado: ${version}`;
    }
    case 'git-network': {
      await resolveShellEnv();
      const env = netProcessEnv();
      const proxy = env.HTTPS_PROXY;
      // bundle combinado (raízes + CA interna): http.sslCAInfo SUBSTITUI o
      // trust store do git, então o arquivo precisa ter as duas coisas
      const ca = env.AWS_CA_BUNDLE ?? env.NODE_EXTRA_CA_CERTS;
      if (!proxy && !ca)
        throw new Error(
          'Nenhum proxy/CA conhecido para aplicar — faça o login RACF do portal ou informe em Configurações → Rede.',
        );
      const applied: string[] = [];
      if (proxy) {
        for (const key of ['http.proxy', 'https.proxy']) {
          const r = await cmd('git', ['config', '--global', key, proxy]);
          if (r.code !== 0) throw new Error(`git config ${key} falhou: ${r.output}`);
        }
        applied.push(`proxy ${maskProxy(proxy)}`);
      }
      if (ca) {
        const r = await cmd('git', ['config', '--global', 'http.sslCAInfo', ca]);
        if (r.code !== 0) throw new Error(`git config http.sslCAInfo falhou: ${r.output}`);
        applied.push('CA corporativa');
      }
      // proxies corporativos costumam quebrar o HTTP/2 do git ("expected flush
      // after ref listing") — HTTP/1.1 é o caminho compatível
      await cmd('git', ['config', '--global', 'http.version', 'HTTP/1.1']);
      applied.push('HTTP/1.1');
      return `Git configurado: ${applied.join(' + ')}.`;
    }
    case 'office-libs': {
      await resolveShellEnv();
      const tail = (s: string) => s.split('\n').filter(Boolean).slice(-4).join(' · ').slice(-400);
      const venv = portalVenvDir();
      const vpy = portalVenvPython();
      // pip e uv não leem NODE_EXTRA_CA_CERTS — a CA corporativa vai pelas
      // variáveis que eles entendem (senão o download falha com erro de TLS)
      const net = netProcessEnv();
      const bundle = net.AWS_CA_BUNDLE ?? net.NODE_EXTRA_CA_CERTS;
      const certEnv: Record<string, string> = bundle
        ? { PIP_CERT: bundle, SSL_CERT_FILE: bundle }
        : {};
      const uvOk = !!(await versionOf('uv'));
      if (!fs.existsSync(vpy)) {
        if (uvOk) {
          // sem direcionar, o uv pode eleger um Python quebrado (ex.: brew com
          // pyexpat quebrado) e o venv nasce quebrado — aponta o candidato
          // saudável quando há um; no Windows o "py" é launcher, não serve
          const py = process.platform === 'win32' ? null : await findHealthyPython();
          // --seed inclui o pip: o venv fica utilizável mesmo sem o uv depois
          const args = ['venv', '--seed', ...(py ? ['--python', py.cmd] : []), venv];
          const r = await cmd('uv', args, 300_000, certEnv);
          if (r.code !== 0) throw new Error(`Criação do ambiente (uv venv) falhou: ${tail(r.output)}`);
        } else {
          const py = await findHealthyPython();
          if (!py)
            throw new Error(
              'Nenhum Python utilizável encontrado (e o uv não está instalado) — instale o ' +
                'Python via Central de Software, reabra o VS Code e tente de novo.',
            );
          const r = await cmd(py.cmd, ['-m', 'venv', venv], 300_000);
          if (r.code !== 0)
            throw new Error(`Criação do ambiente (${py.cmd} -m venv) falhou: ${tail(r.output)}`);
        }
      }
      // uv pip é mais rápido e tolera venv sem pip; sem uv, o pip do venv
      const install = uvOk
        ? await cmd('uv', ['pip', 'install', '--python', vpy, ...OFFICE_LIBS], 600_000, certEnv)
        : await cmd(vpy, ['-m', 'pip', 'install', '-q', ...OFFICE_LIBS], 600_000, certEnv);
      if (install.code !== 0)
        throw new Error(`Instalação das bibliotecas falhou: ${tail(install.output)}`);
      const check = await cmd(vpy, ['-c', `import ${OFFICE_IMPORTS}`], 30_000);
      if (check.code !== 0)
        throw new Error(`Instalou, mas a validação falhou: ${tail(check.output)}`);
      return 'Pronto: python-pptx, openpyxl, python-docx, reportlab e pandas instalados no ambiente do portal.';
    }
    default:
      throw new Error(`Correção desconhecida: ${fixId}`);
  }
}

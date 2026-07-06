import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tls from 'node:tls';
import { Agent, ProxyAgent, type Dispatcher } from 'undici';
import type { NetworkConfig } from '@aiportal/shared';
import { getConfig } from '../storage/configStore';
import { GLOBAL_ROOT } from '../storage/paths';

/**
 * Rede corporativa para as chamadas dos proxies MCP.
 *
 * Quando o VS Code é aberto pela GUI (Dock/Finder), o host da extensão NÃO
 * herda o ambiente do shell de login — então variáveis como HTTPS_PROXY e
 * NODE_EXTRA_CA_CERTS, que o usuário tem no .zshrc e que o runner de mcp.json
 * do VS Code usa, ficam ausentes aqui. Além disso o `fetch` do Node ignora
 * HTTPS_PROXY. Resultado: conexões a hosts internos estouram timeout.
 *
 * Este módulo (1) importa essas variáveis do shell de login e (2) constrói um
 * Dispatcher undici (proxy + CA interna) para passar no `fetch`/transporte.
 */

const NET_VARS = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
];

let resolved = false;

/** Une dois PATHs preservando ordem e sem duplicar (o `a` tem prioridade). */
function mergePaths(a: string, b: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const p of [...a.split(path.delimiter), ...b.split(path.delimiter)]) {
    if (p && !seen.has(p)) {
      seen.add(p);
      parts.push(p);
    }
  }
  return parts.join(path.delimiter);
}

/**
 * Corrige o PATH (e importa proxy/CA ausentes) quando o VS Code é aberto pela
 * GUI: o host da extensão herda um PATH mínimo (sem nvm/homebrew/volta no Mac,
 * sem o PATH persistido do registro no Windows), então `npx`, `uv`, `git` etc.
 * spawnados pelo setup e pelos servidores stdio dão "não encontrado". Aqui
 * juntamos o PATH real ao atual. Best-effort — falha silenciosa mantém o PATH.
 */
export async function resolveShellEnv(): Promise<void> {
  if (resolved) return;
  resolved = true;
  try {
    if (process.platform === 'win32') await resolveWindowsEnv();
    else await resolvePosixEnv();
  } catch {
    // best-effort: sem o PATH resolvido seguimos com o atual
  }
}

/** macOS/Linux: importa PATH e vars de rede do shell de login (nvm/homebrew). */
async function resolvePosixEnv(): Promise<void> {
  const shell = process.env.SHELL || '/bin/zsh';
  const env = await new Promise<Record<string, string>>((resolve) => {
    // -lic: login + interativo carrega .zprofile e .zshrc, onde costumam estar
    // o `nvm use`/exports de PATH e as vars de rede
    execFile(shell, ['-lic', 'env'], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve({});
      const out: Record<string, string> = {};
      for (const line of stdout.split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
      }
      resolve(out);
    });
  });
  // PATH do shell na frente (é o que o terminal/mcp.json do VS Code usam)
  if (env.PATH) process.env.PATH = mergePaths(env.PATH, process.env.PATH ?? '');
  for (const v of NET_VARS) {
    const val = env[v] ?? env[v.toLowerCase()];
    if (val && !process.env[v]) process.env[v] = val;
  }
}

/**
 * Windows: o PATH persistido (User + Machine no registro) é onde os
 * instaladores do Node/Volta/nvm-windows gravam os diretórios — mas um VS Code
 * aberto antes disso, ou por atalho, fica com um PATH desatualizado. Lemos o
 * PATH persistido via PowerShell e juntamos ao atual; alguns diretórios comuns
 * entram como fallback quando nem o registro os tem ainda.
 */
async function resolveWindowsEnv(): Promise<void> {
  const names = ['PATH', ...NET_VARS];
  const script = names
    .map(
      (n) =>
        `Write-Output ('U:${n}=' + [Environment]::GetEnvironmentVariable('${n}','User'));` +
        `Write-Output ('M:${n}=' + [Environment]::GetEnvironmentVariable('${n}','Machine'))`,
    )
    .join(';');
  const out = await new Promise<Record<string, string>>((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 6000, maxBuffer: 1 << 20, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve({});
        const user: Record<string, string> = {};
        const machine: Record<string, string> = {};
        for (const line of stdout.split(/\r?\n/)) {
          const m = /^([UM]):([^=]+)=(.*)$/.exec(line);
          if (!m) continue;
          (m[1] === 'U' ? user : machine)[m[2]] = m[3];
        }
        // devolve já resolvido: PATH unido, net vars com User na frente
        const merged: Record<string, string> = {};
        const persistedPath = [machine.PATH, user.PATH].filter(Boolean).join(path.delimiter);
        if (persistedPath) merged.PATH = persistedPath;
        for (const v of NET_VARS) {
          const val = user[v] || machine[v];
          if (val) merged[v] = val;
        }
        resolve(merged);
      },
    );
  });
  if (out.PATH) process.env.PATH = mergePaths(process.env.PATH ?? '', out.PATH);
  for (const v of NET_VARS) {
    if (out[v] && !process.env[v]) process.env[v] = out[v];
  }
  // fallback: diretórios padrão do Node/npm/Volta que existam no disco
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Volta', 'bin'),
  ].filter((d): d is string => !!d && existsSafe(d));
  if (candidates.length) {
    process.env.PATH = mergePaths(process.env.PATH ?? '', candidates.join(path.delimiter));
  }
}

function existsSafe(dir: string): boolean {
  try {
    return fs.existsSync(dir);
  } catch {
    return false;
  }
}

/** Config de rede da interface (Configurações) — tem prioridade sobre o ambiente. */
function netConfig(): NetworkConfig {
  try {
    return getConfig().network ?? {};
  } catch {
    return {};
  }
}

/** cafile do ~/.npmrc, se o usuário tiver configurado a CA corporativa por lá. */
function npmrcCafile(): string | undefined {
  try {
    const content = fs.readFileSync(path.join(os.homedir(), '.npmrc'), 'utf8');
    const m = /^[ \t]*cafile[ \t]*=[ \t]*(.+?)[ \t]*$/m.exec(content);
    return m?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Caminho do PEM com a CA interna: config da UI vence; senão
 * NODE_EXTRA_CA_CERTS; por fim o cafile do ~/.npmrc (muita gente configura a
 * CA corporativa só ali) — assim os fetches do portal também a respeitam.
 */
function caPath(): string | undefined {
  return netConfig().extraCaCerts || process.env.NODE_EXTRA_CA_CERTS || npmrcCafile() || undefined;
}

function loadCa(): string[] | undefined {
  const file = caPath();
  if (!file) return undefined;
  try {
    const extra = fs.readFileSync(file, 'utf8');
    // mantém as CAs padrão do Node e acrescenta a interna
    return [...tls.rootCertificates, extra];
  } catch {
    return undefined;
  }
}

function noProxyList(): string[] {
  const raw = netConfig().noProxy || process.env.NO_PROXY || process.env.no_proxy || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function hostInNoProxy(host: string): boolean {
  return noProxyList().some((entry) => {
    if (entry === '*') return true;
    const suffix = entry.replace(/^\*?\./, '');
    return host === entry || host === suffix || host.endsWith(`.${suffix}`);
  });
}

function proxyFor(url: URL): string | undefined {
  if (hostInNoProxy(url.hostname)) return undefined;
  const fromConfig = netConfig().httpsProxy;
  if (fromConfig) return fromConfig;
  const https = process.env.HTTPS_PROXY || process.env.https_proxy;
  const http = process.env.HTTP_PROXY || process.env.http_proxy;
  const all = process.env.ALL_PROXY || process.env.all_proxy;
  return (url.protocol === 'https:' ? https : http) || all || undefined;
}

/**
 * Env de rede para PROCESSOS FILHOS (servidores MCP stdio e afins). O SDK MCP
 * spawna com um env mínimo (HOME/PATH/etc), então sem isto um servidor python
 * ou node fica sem proxy/CA e trava atrás da rede corporativa (ex: botocore →
 * STS). Inclui proxy (config da UI vence o ambiente) e, quando há CA interna,
 * um bundle COMBINADO (raízes padrão + interna) gravado em ~/AIChatPortal —
 * AWS_CA_BUNDLE/REQUESTS_CA_BUNDLE substituem o trust store no python, então
 * o arquivo precisa conter as duas coisas para não quebrar TLS não-interceptado.
 */
export function netProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const cfg = netConfig();
  const https = cfg.httpsProxy || process.env.HTTPS_PROXY || process.env.https_proxy;
  const http = cfg.httpProxy || cfg.httpsProxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const noProxy = cfg.noProxy || process.env.NO_PROXY || process.env.no_proxy;
  if (https) {
    env.HTTPS_PROXY = https;
    env.https_proxy = https;
  }
  if (http) {
    env.HTTP_PROXY = http;
    env.http_proxy = http;
  }
  if (noProxy) {
    env.NO_PROXY = noProxy;
    env.no_proxy = noProxy;
  }
  const internalCa = caPath();
  if (internalCa) {
    env.NODE_EXTRA_CA_CERTS = internalCa; // aditivo por natureza (node)
    const bundle = ensureCombinedCaBundle(internalCa);
    if (bundle) {
      env.AWS_CA_BUNDLE = bundle; // botocore/boto3
      env.REQUESTS_CA_BUNDLE = bundle; // requests/urllib3
    }
  }
  return env;
}

/** Grava (uma vez por mudança) o PEM combinado: raízes do Node + CA interna. */
function ensureCombinedCaBundle(internalCaFile: string): string | undefined {
  try {
    const internal = fs.readFileSync(internalCaFile, 'utf8');
    const combined = [...tls.rootCertificates, internal.trim()].join('\n') + '\n';
    const file = path.join(GLOBAL_ROOT, 'ca-bundle.pem');
    let current: string | undefined;
    try {
      current = fs.readFileSync(file, 'utf8');
    } catch {
      /* ainda não existe */
    }
    if (current !== combined) {
      fs.mkdirSync(GLOBAL_ROOT, { recursive: true });
      fs.writeFileSync(file, combined, 'utf8');
    }
    return file;
  } catch {
    return undefined;
  }
}

/**
 * Dispatcher undici para uma URL: ProxyAgent se houver proxy corporativo,
 * Agent com a CA interna se houver NODE_EXTRA_CA_CERTS, ou undefined se nada
 * disso for necessário (aí o fetch padrão serve).
 */
export function dispatcherFor(urlStr: string): Dispatcher | undefined {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return undefined;
  }
  const ca = loadCa();
  const proxy = proxyFor(url);
  try {
    if (proxy) {
      return new ProxyAgent({ uri: proxy, requestTls: ca ? { ca } : undefined });
    }
    if (ca) {
      return new Agent({ connect: { ca } });
    }
  } catch {
    // qualquer falha ao montar o dispatcher: segue sem ele
  }
  return undefined;
}

/** Monta um RequestInit com headers + dispatcher (quando aplicável). */
export function requestInitFor(urlStr: string, headers?: Record<string, string>): RequestInit {
  const dispatcher = dispatcherFor(urlStr);
  return {
    ...(headers ? { headers } : {}),
    ...(dispatcher ? { dispatcher } : {}),
  } as RequestInit;
}

/**
 * http.proxy do settings do VS Code — o VS Code injeta esse proxy no fetch de
 * TODAS as extensões, então um valor obsoleto ali derruba as chamadas do
 * portal mesmo com env/config certos. Require dinâmico para os testes fora do
 * VS Code não quebrarem.
 */
function vsCodeProxySetting(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscode = require('vscode') as typeof import('vscode');
    return vscode.workspace?.getConfiguration('http').get<string>('proxy') || undefined;
  } catch {
    return undefined;
  }
}

/** Resumo do que está configurado, para anexar a erros de timeout. */
export function netStatus(urlStr?: string): string {
  const proxyRaw = netConfig().httpsProxy
    ? `${netConfig().httpsProxy} (config)`
    : process.env.HTTPS_PROXY || process.env.https_proxy
      ? `${process.env.HTTPS_PROXY || process.env.https_proxy} (env)`
      : 'nenhum';
  const ca = caPath();
  let caStatus = 'nenhum';
  if (ca) {
    let readable = false;
    try {
      fs.accessSync(ca);
      readable = true;
    } catch {
      readable = false;
    }
    caStatus = `${ca} (${readable ? 'lido' : 'NÃO encontrado'})`;
  }
  let applied = 'sem dispatcher';
  if (urlStr) {
    try {
      const url = new URL(urlStr);
      applied = hostInNoProxy(url.hostname)
        ? 'host no NO_PROXY (conexão direta)'
        : dispatcherFor(urlStr)
          ? 'usando proxy/CA'
          : 'conexão direta';
    } catch {
      // ignora url inválida
    }
  }
  const vsProxy = vsCodeProxySetting();
  const vsPart = vsProxy ? `; http.proxy do VS Code=${vsProxy} (vale para o fetch da extensão)` : '';
  return `proxy=${proxyRaw}; CA=${caStatus}; ${applied}${vsPart}`;
}

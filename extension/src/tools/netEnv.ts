import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as tls from 'node:tls';
import { Agent, ProxyAgent, type Dispatcher } from 'undici';

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

/** Lê do shell de login as variáveis de rede ausentes (best-effort, macOS/Linux). */
export async function resolveShellEnv(): Promise<void> {
  if (resolved) return;
  resolved = true;
  if (process.platform === 'win32') return;
  // já temos algo de proxy/CA? então o ambiente provavelmente foi herdado
  if (NET_VARS.some((v) => process.env[v] || process.env[v.toLowerCase()])) return;
  const shell = process.env.SHELL || '/bin/zsh';
  const env = await new Promise<Record<string, string>>((resolve) => {
    // -lic: login + interativo carrega .zprofile e .zshrc, onde costumam estar essas vars
    execFile(
      shell,
      ['-lic', 'env'],
      { timeout: 4000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve({});
        const out: Record<string, string> = {};
        for (const line of stdout.split('\n')) {
          const i = line.indexOf('=');
          if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
        }
        resolve(out);
      },
    );
  });
  for (const v of NET_VARS) {
    const val = env[v] ?? env[v.toLowerCase()];
    if (val && !process.env[v]) process.env[v] = val;
  }
}

function loadCa(): string[] | undefined {
  const file = process.env.NODE_EXTRA_CA_CERTS;
  if (!file) return undefined;
  try {
    const extra = fs.readFileSync(file, 'utf8');
    // mantém as CAs padrão do Node e acrescenta a interna
    return [...tls.rootCertificates, extra];
  } catch {
    return undefined;
  }
}

function hostInNoProxy(host: string): boolean {
  const list = (process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.some((entry) => {
    if (entry === '*') return true;
    const suffix = entry.replace(/^\*?\./, '');
    return host === entry || host === suffix || host.endsWith(`.${suffix}`);
  });
}

function proxyFor(url: URL): string | undefined {
  if (hostInNoProxy(url.hostname)) return undefined;
  const https = process.env.HTTPS_PROXY || process.env.https_proxy;
  const http = process.env.HTTP_PROXY || process.env.http_proxy;
  const all = process.env.ALL_PROXY || process.env.all_proxy;
  return (url.protocol === 'https:' ? https : http) || all || undefined;
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

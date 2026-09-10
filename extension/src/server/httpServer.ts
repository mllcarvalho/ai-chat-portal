import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { Config, HealthInfo } from '@aiportal/shared';
import { CLIENT_HEADER, PORT_RANGE, TOKEN_HEADER } from '@aiportal/shared';
import { Router, sendError } from './router';
import { getConfig } from '../storage/configStore';
import { collabEnabled, identityForToken, lanAddresses } from '../storage/collabStore';
import { hostedPortalUrl } from '../storage/hostedPortal';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

export interface PortalServer {
  server: http.Server;
  port: number;
}

interface ServerOpts {
  config: Config;
  version: string;
  /** Identifica o build carregado; janelas com build mais novo assumem o portal. */
  buildId: number;
  /** Se esta janela tem o repo do portal aberto (preferida na eleição). */
  hasPortalRoot: boolean;
  /** Pasta com o build da web UI (extension/media). */
  mediaDir: string;
}

/** networkInterfaces a cada request seria desperdício — a lista mal muda. */
let lanCache: { at: number; addresses: string[] } | undefined;
function lanAddressesCached(): string[] {
  if (!lanCache || Date.now() - lanCache.at > 10_000) {
    lanCache = { at: Date.now(), addresses: lanAddresses() };
  }
  return lanCache.addresses;
}

function isAllowedOrigin(origin: string, config: Config, port: number): boolean {
  // qualquer origem local: o portal pode migrar de porta quando outra janela
  // assume (failover do web); o token continua protegendo a API
  if (/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return true;
  // modo colaboração: a SPA servida pelo IP da LAN é a nossa própria origem
  if (collabEnabled()) {
    const m = /^http:\/\/(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/.exec(origin);
    if (m && Number(m[2]) === port && lanAddressesCached().includes(m[1])) return true;
  }
  // portal hospedado: a UI vem do CloudFront/S3 da empresa e fala com esta
  // extensão em 127.0.0.1 (o Chrome exige o preflight de rede privada, já
  // respondido abaixo)
  if (hostedPortalUrl() === origin) return true;
  return (config.devOrigins ?? []).includes(origin);
}

/**
 * Anti DNS-rebinding: além do localhost, no modo colaboração o próprio IP da
 * máquina na LAN também é um Host legítimo (é por ele que o squad entra).
 * Um domínio de atacante apontado para este IP continua barrado: o header
 * Host viria com o domínio dele, que nunca casa com a lista.
 */
function isAllowedHost(host: string, port: number): boolean {
  if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) return true;
  if (!collabEnabled()) return false;
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/.exec(host);
  if (!m || Number(m[2]) !== port) return false;
  return lanAddressesCached().includes(m[1]);
}

/**
 * Rotas que só o HOST pode chamar: tudo que reconfigura a máquina dele (proxy,
 * MCPs, login RACF, correções de diagnóstico), expõe segredos (config com
 * senha de proxy embutida) ou espia a tela (contexto do editor). Convidados
 * usam o resto normalmente — o objetivo do modo colaboração é trabalhar junto,
 * não administrar a máquina do host.
 */
function isHostOnly(method: string, pathname: string): boolean {
  if (pathname === '/api/collab/me') return false;
  if (pathname.startsWith('/api/collab')) return true;
  if (pathname === '/api/shutdown') return true;
  if (pathname === '/api/config') return true;
  if (pathname.startsWith('/api/shared-libraries') && method !== 'GET') return true;
  if (pathname.startsWith('/api/login')) return true;
  if (pathname === '/api/diagnostics/fix') return true;
  if (pathname.startsWith('/api/mcp/') && method !== 'GET') return true;
  if (pathname === '/api/bmad/install') return true;
  if (pathname === '/api/editor/context') return true;
  if (pathname.startsWith('/api/share')) return true;
  return false;
}

async function serveStatic(
  res: http.ServerResponse,
  mediaDir: string,
  pathname: string,
): Promise<void> {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (!rel) rel = 'index.html';
  let file = path.resolve(mediaDir, rel);
  // proteção contra path traversal + SPA fallback
  if (path.relative(mediaDir, file).startsWith('..') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(mediaDir, 'index.html');
  }
  let data: Buffer;
  try {
    // leitura assíncrona: não bloqueia o event loop (que também serve os SSE do chat)
    data = await fs.promises.readFile(file);
  } catch {
    sendError(res, 404, 'Interface web não encontrada — rode o build do projeto (npm start)');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
  });
  res.end(data);
}

function makeHandler(router: Router, opts: ServerOpts, getPort: () => number) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const port = getPort();
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    // opts.config congela o objeto da ativação; patchConfig troca o objeto
    // cacheado — lê fresco para devOrigins/collab valerem sem reload
    const config = getConfig();

    // anti DNS-rebinding: só aceita Host local (ou o IP da LAN no modo colaboração)
    const host = req.headers.host ?? '';
    if (!isAllowedHost(host, port)) {
      sendError(res, 403, 'Host não permitido');
      return;
    }

    // o bookmarklet "Enviar para o portal" posta de páginas externas
    // (SharePoint, intranet…): a origem é liberada SÓ nestas rotas e a
    // autenticação é o token do portal dentro do corpo (validado na rota);
    // /bridge é a página-ponte que o bookmarklet abre quando a CSP do site
    // bloqueia o fetch direto
    const isCapture = url.pathname === '/api/capture' || url.pathname === '/api/capture/bridge';

    // identidade de quem chama: host (token do config) ou convidado (token
    // individual). Vale para o CORS abaixo e para as rotas.
    const token = req.headers[TOKEN_HEADER.toLowerCase()] ?? url.searchParams.get('token') ?? '';
    const auth = identityForToken(token);

    const origin = req.headers.origin;
    if (origin) {
      // o preflight (OPTIONS) não carrega token nem executa nada: responder os
      // headers de CORS aqui é inofensivo — a request de verdade ainda passa
      // pelo token. É o que permite a uma aba servida por OUTRO portal (ex.:
      // federação host↔convidado) falar com este, apresentando o token.
      const allowed =
        isCapture || isAllowedOrigin(origin, config, port) || req.method === 'OPTIONS' || !!auth;
      if (!allowed) {
        sendError(res, 403, 'Origem não permitida');
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      // o header do cliente (id da aba) só importa fora da mesma origem — que é
      // exatamente quando há preflight (portal hospedado, federação)
      res.setHeader('Access-Control-Allow-Headers', `Content-Type, ${TOKEN_HEADER}, ${CLIENT_HEADER}`);
      // Chrome/Edge exigem este header no preflight de sites públicos para
      // 127.0.0.1 (Private Network Access)
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      // health é aberto para o setup/onboarding poderem diagnosticar sem token
      if (url.pathname !== '/api/health' && !isCapture) {
        if (!auth) {
          sendError(res, 401, 'Token inválido ou ausente');
          return;
        }
        if (auth.role !== 'host' && isHostOnly(req.method ?? 'GET', url.pathname)) {
          sendError(res, 403, 'Somente o host do portal pode fazer isso');
          return;
        }
      }
      const handled = await router.dispatch(req, res, url.pathname, url.searchParams, auth);
      if (!handled) sendError(res, 404, 'Rota não encontrada');
      return;
    }

    await serveStatic(res, opts.mediaDir, url.pathname);
  };
}

interface PeerPortal {
  buildId: number;
  hasPortalRoot: boolean;
  version: string;
}

/** Consulta /api/health em uma porta; undefined se não há portal vivo ali. */
async function probePortal(port: number): Promise<PeerPortal | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return undefined;
    const health = (await res.json()) as HealthInfo;
    if (typeof health.version !== 'string') return undefined;
    return {
      buildId: health.buildId ?? 0,
      hasPortalRoot: health.hasPortalRoot ?? false,
      version: health.version,
    };
  } catch {
    return undefined;
  }
}

/**
 * Eleição entre janelas: cede para o peer se ele roda um build mais novo, ou
 * roda o mesmo build e tem o repo do portal (ou esta janela também não tem).
 * Builds antigos (sem buildId no health) perdem sempre.
 */
function shouldYieldTo(peer: PeerPortal, opts: ServerOpts): boolean {
  if (peer.buildId !== opts.buildId) return peer.buildId > opts.buildId;
  return peer.hasPortalRoot || !opts.hasPortalRoot;
}

/** Pede a um peer desatualizado que encerre o servidor dele (builds novos honram). */
async function requestPeerShutdown(port: number, token: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: token },
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function tryListen(
  server: http.Server,
  port: number,
  bindHost: string,
  attempts: number,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 300));
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => reject(err);
        server.once('error', onError);
        server.listen(port, bindHost, () => {
          server.removeListener('error', onError);
          resolve();
        });
      });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }
  }
  return false;
}

/**
 * Sobe o servidor em 127.0.0.1 tentando portas a partir da configurada.
 * Em cada porta ocupada por outro portal, decide pela eleição: cede (retorna
 * undefined) se o peer é tão bom ou melhor; senão pede o shutdown dele e
 * assume a porta (ou a próxima livre, se o peer roda um build sem /api/shutdown).
 */
export async function startServer(router: Router, opts: ServerOpts): Promise<PortalServer | undefined> {
  let port = opts.config.port;
  const handlerPort = { value: 0 };
  const server = http.createServer(makeHandler(router, opts, () => handlerPort.value));
  // modo colaboração: escuta em todas as interfaces para o squad entrar pela
  // LAN. O check de Host + os tokens individuais continuam protegendo tudo.
  const bindHost = collabEnabled() ? '0.0.0.0' : '127.0.0.1';

  for (let attempt = 0; attempt <= PORT_RANGE; attempt++, port++) {
    const peer = await probePortal(port);
    let evicting = false;
    if (peer) {
      if (shouldYieldTo(peer, opts)) {
        console.log(`[ai-chat-portal] portal já ativo em outra janela (porta ${port})`);
        return undefined;
      }
      evicting = await requestPeerShutdown(port, opts.config.token);
      console.log(
        `[ai-chat-portal] portal desatualizado na porta ${port}; ` +
          (evicting ? 'assumindo o lugar dele' : 'sem /api/shutdown, usando outra porta'),
      );
      if (!evicting) continue;
    }
    if (await tryListen(server, port, bindHost, evicting ? 8 : 1)) {
      handlerPort.value = port;
      console.log(
        `[ai-chat-portal] servidor em http://127.0.0.1:${port}` +
          (bindHost === '0.0.0.0' ? ' (modo colaboração: também na rede local)' : ''),
      );
      return { server, port };
    }
    // a porta foi tomada entre o probe e o listen (outra janela ativando junto):
    // se quem ganhou a corrida é um portal tão bom quanto, cede
    const racer = await probePortal(port);
    if (racer && shouldYieldTo(racer, opts)) {
      console.log(`[ai-chat-portal] portal já ativo em outra janela (porta ${port})`);
      return undefined;
    }
  }
  console.error('[ai-chat-portal] nenhuma porta livre encontrada');
  return undefined;
}

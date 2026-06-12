import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { Config, HealthInfo } from '@aiportal/shared';
import { PORT_RANGE, TOKEN_HEADER } from '@aiportal/shared';
import { Router, sendError } from './router';

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

function isAllowedOrigin(origin: string, config: Config): boolean {
  // qualquer origem local: o portal pode migrar de porta quando outra janela
  // assume (failover do web); o token continua protegendo a API
  if (/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return true;
  return (config.devOrigins ?? []).includes(origin);
}

function serveStatic(res: http.ServerResponse, mediaDir: string, pathname: string): void {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (!rel) rel = 'index.html';
  let file = path.resolve(mediaDir, rel);
  // proteção contra path traversal + SPA fallback
  if (path.relative(mediaDir, file).startsWith('..') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(mediaDir, 'index.html');
  }
  if (!fs.existsSync(file)) {
    sendError(res, 404, 'Interface web não encontrada — rode o build do projeto (npm start)');
    return;
  }
  const data = fs.readFileSync(file);
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

    // anti DNS-rebinding: só aceita Host local
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      sendError(res, 403, 'Host não permitido');
      return;
    }

    const origin = req.headers.origin;
    if (origin) {
      if (!isAllowedOrigin(origin, opts.config)) {
        sendError(res, 403, 'Origem não permitida');
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', `Content-Type, ${TOKEN_HEADER}`);
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      // health é aberto para o setup/onboarding poderem diagnosticar sem token
      if (url.pathname !== '/api/health') {
        const token =
          req.headers[TOKEN_HEADER.toLowerCase()] ?? url.searchParams.get('token') ?? '';
        if (token !== opts.config.token) {
          sendError(res, 401, 'Token inválido ou ausente');
          return;
        }
      }
      const handled = await router.dispatch(req, res, url.pathname, url.searchParams);
      if (!handled) sendError(res, 404, 'Rota não encontrada');
      return;
    }

    serveStatic(res, opts.mediaDir, url.pathname);
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

async function tryListen(server: http.Server, port: number, attempts: number): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 300));
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => reject(err);
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
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
    if (await tryListen(server, port, evicting ? 8 : 1)) {
      handlerPort.value = port;
      console.log(`[ai-chat-portal] servidor em http://127.0.0.1:${port}`);
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

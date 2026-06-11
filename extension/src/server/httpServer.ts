import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { Config, HealthInfo } from '@aiportal/shared';
import { PORT_RANGE, TOKEN_HEADER } from '@aiportal/shared';
import { Router, sendError } from './router';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
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
  /** Pasta com o build da web UI (extension/media). */
  mediaDir: string;
}

function isAllowedOrigin(origin: string, port: number, config: Config): boolean {
  if (origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`) return true;
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
      if (!isAllowedOrigin(origin, port, opts.config)) {
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

async function portalAlreadyRunning(port: number, version: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const health = (await res.json()) as HealthInfo;
    return health.version === version;
  } catch {
    return false;
  }
}

/**
 * Sobe o servidor em 127.0.0.1 tentando portas a partir da configurada.
 * Retorna undefined se outra janela do VS Code já está servindo o portal.
 */
export async function startServer(router: Router, opts: ServerOpts): Promise<PortalServer | undefined> {
  let port = opts.config.port;
  const handlerPort = { value: 0 };
  const server = http.createServer(makeHandler(router, opts, () => handlerPort.value));

  for (let attempt = 0; attempt <= PORT_RANGE; attempt++, port++) {
    if (await portalAlreadyRunning(port, opts.version)) {
      console.log(`[ai-chat-portal] portal já ativo em outra janela (porta ${port})`);
      return undefined;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => reject(err);
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', onError);
          resolve();
        });
      });
      handlerPort.value = port;
      console.log(`[ai-chat-portal] servidor em http://127.0.0.1:${port}`);
      return { server, port };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }
  }
  console.error('[ai-chat-portal] nenhuma porta livre encontrada');
  return undefined;
}

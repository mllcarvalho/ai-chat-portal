import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 10 * 1024 * 1024) throw new Error('Payload muito grande');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  return JSON.parse(raw);
}

export class Router {
  private routes: Route[] = [];

  private add(method: string, path: string, handler: Handler): void {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler });
  }

  get(path: string, handler: Handler): void {
    this.add('GET', path, handler);
  }
  post(path: string, handler: Handler): void {
    this.add('POST', path, handler);
  }
  patch(path: string, handler: Handler): void {
    this.add('PATCH', path, handler);
  }
  put(path: string, handler: Handler): void {
    this.add('PUT', path, handler);
  }
  delete(path: string, handler: Handler): void {
    this.add('DELETE', path, handler);
  }

  /** Retorna false se nenhuma rota casa (chamador decide 404 ou estático). */
  async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    query: URLSearchParams,
  ): Promise<boolean> {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== req.method || route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const pattern = route.parts[i];
        if (pattern.startsWith(':')) {
          params[pattern.slice(1)] = decodeURIComponent(parts[i]);
        } else if (pattern !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      let body: unknown;
      if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
        try {
          body = await readBody(req);
        } catch {
          sendError(res, 400, 'Corpo da requisição inválido (JSON esperado)');
          return true;
        }
      }
      try {
        await route.handler({ req, res, params, query, body });
      } catch (err) {
        console.error(`[ai-chat-portal] erro em ${req.method} ${pathname}:`, err);
        if (!res.headersSent) {
          sendError(res, 500, err instanceof Error ? err.message : 'Erro interno');
        } else {
          res.end();
        }
      }
      return true;
    }
    return false;
  }
}

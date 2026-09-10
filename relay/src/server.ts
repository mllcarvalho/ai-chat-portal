import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { HostToRelayMessage, RelayToHostMessage } from '@aiportal/shared';
import {
  RELAY_FORWARDED_REQUEST_HEADERS,
  RELAY_MAX_BODY_BYTES,
  RELAY_PREFIX,
  RELAY_ROOM_ID_LENGTH,
} from '@aiportal/shared';

/**
 * Relay do portal hospedado. Um processo Node pequeno que só encaminha bytes:
 *
 *   convidado ──HTTPS──► relay ──WebSocket──► aba do host ──► extensão (127.0.0.1)
 *
 * - Salas em memória: id da sala → WebSocket da aba do host. O id é o
 *   sha256 da chave que só o host tem; o relay confere o hash e pronto —
 *   sem registro, sem banco, sem disco.
 * - Cada request de convidado vira um envelope na sala; a resposta volta em
 *   pedaços e é escrita no response conforme chega (SSE passa sem buffer).
 * - Ping de WebSocket a cada 20s: mantém a conexão viva pelo CloudFront/ALB
 *   e detecta aba morta. O browser responde ping sem JavaScript.
 * - Se a task reiniciar, os hosts reconectam e as salas se refazem.
 *
 * Variáveis de ambiente:
 *   PORT                 porta HTTP (default 8787)
 *   RELAY_STATIC_DIR     opcional: serve a UI (web/dist) daqui — bom para teste
 *                        local e para um deploy de um processo só
 *   RELAY_CORS_ORIGINS   opcional: origens extras (dev com Vite em :5173)
 */

const PORT = Number(process.env.PORT ?? 8787);
const STATIC_DIR = process.env.RELAY_STATIC_DIR ? path.resolve(process.env.RELAY_STATIC_DIR) : undefined;
const CORS_ORIGINS = (process.env.RELAY_CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const PING_MS = 20_000;
const HEALTH_PATH = `${RELAY_PREFIX}/health`;

interface Pending {
  res: http.ServerResponse;
  headersSent: boolean;
}

interface Room {
  ws: WebSocket;
  alive: boolean;
  pending: Map<string, Pending>;
  since: string;
}

const rooms = new Map<string, Room>();

const log = (msg: string) => console.log(`[relay] ${new Date().toISOString()} ${msg}`);

// ---------------------------------------------------------------------------
// Salas
// ---------------------------------------------------------------------------

function roomIdFromKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, RELAY_ROOM_ID_LENGTH);
}

function validRoomId(id: string): boolean {
  return new RegExp(`^[a-f0-9]{${RELAY_ROOM_ID_LENGTH}}$`).test(id);
}

function keyMatchesRoom(key: string, roomId: string): boolean {
  const expected = Buffer.from(roomIdFromKey(key));
  const given = Buffer.from(roomId);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function sendToHost(room: Room, msg: RelayToHostMessage): void {
  if (room.ws.readyState === room.ws.OPEN) room.ws.send(JSON.stringify(msg));
}

/** Falha tudo que estava pendente numa sala (host caiu/foi substituído). */
function failPending(room: Room, reason: string): void {
  for (const [id, p] of room.pending) {
    if (!p.headersSent) sendJson(p.res, 502, { error: reason });
    else p.res.destroy();
    room.pending.delete(id);
  }
}

function attachHost(roomId: string, ws: WebSocket): void {
  const previous = rooms.get(roomId);
  if (previous) {
    // outra aba do host assumiu (ou reconectou antes do close chegar):
    // a antiga sai e leva os requests dela — o convidado retenta
    failPending(previous, 'A aba do host reconectou — tente de novo');
    previous.ws.close(4000, 'replaced');
  }
  const room: Room = { ws, alive: true, pending: new Map(), since: new Date().toISOString() };
  rooms.set(roomId, room);
  log(`sala ${roomId.slice(0, 8)}… host conectado${previous ? ' (substituiu a aba anterior)' : ''}`);

  ws.on('pong', () => {
    room.alive = true;
  });
  ws.on('message', (raw) => {
    let msg: HostToRelayMessage;
    try {
      msg = JSON.parse(raw.toString()) as HostToRelayMessage;
    } catch {
      return;
    }
    const p = room.pending.get(msg.id);
    if (!p) return;
    switch (msg.t) {
      case 'head':
        p.res.writeHead(msg.status, {
          ...msg.headers,
          // streaming: nada no caminho pode segurar os pedaços
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        });
        p.res.flushHeaders();
        p.headersSent = true;
        break;
      case 'chunk':
        p.res.write(Buffer.from(msg.data, 'base64'));
        break;
      case 'end':
        // sai do mapa ANTES de encerrar: o 'close' do response não pode virar abort
        room.pending.delete(msg.id);
        p.res.end();
        break;
      case 'err':
        room.pending.delete(msg.id);
        if (!p.headersSent) sendJson(p.res, 502, { error: `A aba do host não conseguiu responder: ${msg.message}` });
        else p.res.destroy();
        break;
    }
  });
  ws.on('close', () => {
    failPending(room, 'A aba do host desconectou');
    if (rooms.get(roomId) === room) {
      rooms.delete(roomId);
      log(`sala ${roomId.slice(0, 8)}… host saiu`);
    }
  });
  ws.on('error', () => ws.terminate());
}

// ping: aba que não responde em um ciclo é considerada morta
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.alive) {
      room.ws.terminate();
      continue;
    }
    room.alive = false;
    room.ws.ping();
  }
}, PING_MS).unref();

// ---------------------------------------------------------------------------
// HTTP: requests dos convidados
// ---------------------------------------------------------------------------

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > RELAY_MAX_BODY_BYTES) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on('error', reject);
  });
}

async function forward(req: http.IncomingMessage, res: http.ServerResponse, roomId: string, apiPath: string): Promise<void> {
  const room = rooms.get(roomId);
  if (!room) {
    sendJson(res, 503, {
      error: 'O portal do host está fora do ar — ele precisa estar com o VS Code e uma aba do portal abertos.',
    });
    return;
  }
  let body: Buffer | undefined;
  try {
    body = await readBody(req);
  } catch (err) {
    sendJson(res, (err as Error).message === 'too large' ? 413 : 400, { error: 'Corpo da requisição inválido' });
    return;
  }
  const headers: Record<string, string> = {};
  for (const name of RELAY_FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  const id = crypto.randomUUID();
  const pending: Pending = { res, headersSent: false };
  room.pending.set(id, pending);
  // o convidado fechou (mudou de tela, cancelou a geração): avisa a ponte
  // para abortar o fetch local — senão o Copilot seguiria gerando à toa
  res.on('close', () => {
    if (room.pending.delete(id)) sendToHost(room, { t: 'abort', id });
  });
  sendToHost(room, {
    t: 'req',
    id,
    method: req.method ?? 'GET',
    path: apiPath,
    headers,
    ...(body ? { body: body.toString('base64') } : {}),
  });
}

// ---------------------------------------------------------------------------
// Estático (opcional): a UI servida pelo próprio relay
// ---------------------------------------------------------------------------

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
};

async function serveStatic(res: http.ServerResponse, dir: string, pathname: string): Promise<void> {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (!rel) rel = 'index.html';
  let file = path.resolve(dir, rel);
  if (path.relative(dir, file).startsWith('..') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(dir, 'index.html'); // SPA fallback
  }
  let data: Buffer;
  try {
    data = await fs.promises.readFile(file);
  } catch {
    sendJson(res, 404, { error: 'Interface web não encontrada' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
  });
  res.end(data);
}

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------

const roomRoute = new RegExp(`^${RELAY_PREFIX}/([a-f0-9]+)(/api/.*)$`);

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://relay');
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Portal-Token, X-Portal-Client');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  if (url.pathname === HEALTH_PATH) {
    sendJson(res, 200, { ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) });
    return;
  }
  const m = roomRoute.exec(url.pathname);
  if (m) {
    if (!validRoomId(m[1])) {
      sendJson(res, 404, { error: 'Sala inválida' });
      return;
    }
    void forward(req, res, m[1], `${m[2]}${url.search}`);
    return;
  }
  if (url.pathname.startsWith(RELAY_PREFIX)) {
    sendJson(res, 404, { error: 'Rota não encontrada' });
    return;
  }
  if (STATIC_DIR) {
    void serveStatic(res, STATIC_DIR, url.pathname);
    return;
  }
  sendJson(res, 404, { error: 'Rota não encontrada' });
});

const wss = new WebSocketServer({ noServer: true });
const hostRoute = new RegExp(`^${RELAY_PREFIX}/([a-f0-9]+)/host$`);

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://relay');
  const m = hostRoute.exec(url.pathname);
  const key = url.searchParams.get('key') ?? '';
  if (!m || !validRoomId(m[1]) || !key || !keyMatchesRoom(key, m[1])) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const roomId = m[1];
  wss.handleUpgrade(req, socket, head, (ws) => attachHost(roomId, ws));
});

server.listen(PORT, () => {
  log(`escutando em :${PORT}${STATIC_DIR ? ` (servindo UI de ${STATIC_DIR})` : ''}`);
});

const shutdown = () => {
  log('encerrando');
  for (const room of rooms.values()) room.ws.close(1001, 'shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

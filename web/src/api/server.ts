import { relayApiBase } from '@aiportal/shared';

/**
 * Para onde a UI manda a API. Três situações:
 *
 * - **Servida pela extensão** (npx, uso local, convidado pelo IP da LAN): base
 *   vazia — as chamadas são relativas, como sempre foram. É o padrão e nada
 *   muda para quem instala hoje.
 * - **Portal hospedado, uso solo**: a página vem do CloudFront/S3 da empresa
 *   e chegou com `?server=http://127.0.0.1:4717`; a base é a extensão local.
 *   Uma página HTTPS pode chamar loopback (é origem confiável para o browser).
 * - **Portal hospedado, convidado**: a página chegou com `?room=<sala>`; a
 *   base é a rota do relay na mesma origem, que encaminha para a aba do host.
 *
 * Fica em localStorage: um reload (ou a URL limpa) continua sabendo o servidor.
 */

const SERVER_KEY = 'aiportal.server';
const ROOM_KEY = 'aiportal.room';

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function write(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // sem storage: vale só nesta página
  }
}

/** Normaliza uma origem de servidor: só http(s), sem barra final, sem path. */
export function normalizeServer(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Aponta a UI para a extensão local (portal hospedado, uso solo). Limpa a sala. */
export function setServer(origin: string): void {
  write(SERVER_KEY, origin);
  write(ROOM_KEY, '');
}

/** Aponta a UI para uma sala do relay (portal hospedado, convidado). Limpa o servidor. */
export function setRoom(roomId: string): void {
  write(ROOM_KEY, roomId);
  write(SERVER_KEY, '');
}

export function getServer(): string {
  return read(SERVER_KEY);
}

export function getRoom(): string {
  return read(ROOM_KEY);
}

/** Base da API ('' = mesma origem da página). */
export function getApiBase(): string {
  const room = getRoom();
  if (room) return relayApiBase(location.origin, room);
  return getServer();
}

/** Prefixa um caminho /api/... com a base atual. */
export function apiUrl(path: string): string {
  return `${getApiBase()}${path}`;
}

/** A UI está sendo servida por um portal hospedado (não pela extensão). */
export function isHosted(): boolean {
  return !!getServer() || !!getRoom();
}

/** Esta aba entrou como convidado pelo relay. */
export function viaRelay(): boolean {
  return !!getRoom();
}

/**
 * Lê `?server=` e `?room=` da URL de entrada (o VS Code/instalador abre com
 * `server`, o link de convite hospedado vem com `room`) e persiste. Retorna
 * os parâmetros consumidos para a chamada limpar a URL.
 */
export function consumeServerParams(params: URLSearchParams): string[] {
  const consumed: string[] = [];
  const server = params.get('server');
  if (server) {
    const origin = normalizeServer(server);
    if (origin) setServer(origin);
    consumed.push('server');
  }
  const room = params.get('room');
  if (room && /^[a-f0-9]{16,64}$/i.test(room)) {
    setRoom(room);
    consumed.push('room');
  }
  return consumed;
}

import type { HostToRelayMessage, RelayToHostMessage } from '@aiportal/shared';
import { RELAY_FORWARDED_RESPONSE_HEADERS, relayHostSocketUrl } from '@aiportal/shared';
import { getServer, isHosted, viaRelay } from './server';

/**
 * A PONTE do portal hospedado, lado HOST. A aba do host (servida pelo
 * CloudFront) mantém um WebSocket com o relay; cada request de convidado chega
 * como envelope, é repetido contra a extensão local (127.0.0.1) com os headers
 * de quem chamou — o token do convidado incluso, para a extensão decidir o
 * papel — e a resposta volta em pedaços, streaming incluso (SSE do chat e do
 * canal de eventos passam por aqui).
 *
 * Só UMA aba do host faz a ponte: as outras esperam num Web Lock e assumem se
 * ela fechar. Heartbeat é responsabilidade do relay (ping de WebSocket, que o
 * browser responde sem JavaScript — abas em segundo plano têm timers
 * estrangulados, mas continuam respondendo ping).
 */

export type BridgeState = 'off' | 'waiting' | 'connecting' | 'connected';

const LOCK_NAME = 'aiportal.relay-bridge';
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 15000];

interface Room {
  roomId: string;
  key: string;
}

let desired: Room | undefined;
let state: BridgeState = 'off';
let generation = 0;
let socket: WebSocket | undefined;
let releaseLock: (() => void) | undefined;
const inflight = new Map<string, AbortController>();
const listeners = new Set<(state: BridgeState) => void>();

function setState(next: BridgeState): void {
  if (state === next) return;
  state = next;
  for (const cb of listeners) cb(state);
}

export function bridgeState(): BridgeState {
  return state;
}

export function onBridgeState(cb: (state: BridgeState) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Liga/desliga a ponte conforme o status da colaboração. Só faz algo quando a
 * UI está num portal hospedado E esta aba é a do host (não um convidado pelo
 * relay). Idempotente: o store chama a cada status carregado.
 */
export function syncRelayBridge(relay: Room | undefined): void {
  if (!relay || !isHosted() || viaRelay()) {
    stop();
    return;
  }
  if (desired && desired.roomId === relay.roomId && desired.key === relay.key) return;
  stop();
  desired = relay;
  const gen = ++generation;
  void runWithLock(gen);
}

function stop(): void {
  desired = undefined;
  generation++;
  for (const controller of inflight.values()) controller.abort();
  inflight.clear();
  socket?.close();
  socket = undefined;
  releaseLock?.();
  releaseLock = undefined;
  setState('off');
}

async function runWithLock(gen: number): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) {
    // browser sem Web Locks: cada aba faz a ponte; o relay fica com a última
    await loop(gen);
    return;
  }
  setState('waiting');
  const controller = new AbortController();
  try {
    await locks.request(LOCK_NAME, { signal: controller.signal }, async () => {
      if (gen !== generation) return;
      await new Promise<void>((resolve) => {
        releaseLock = resolve;
        void loop(gen).finally(resolve);
      });
    });
  } catch {
    // abortado antes de pegar o lock (a ponte foi desligada enquanto esperava)
  }
}

async function loop(gen: number): Promise<void> {
  let attempt = 0;
  while (gen === generation && desired) {
    const before = Date.now();
    setState('connecting');
    try {
      await connectOnce(desired, gen);
    } catch {
      // queda: reconecta abaixo
    }
    if (gen !== generation) break;
    setState('connecting');
    if (Date.now() - before > 30_000) attempt = 0;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt++, RECONNECT_DELAYS_MS.length - 1)];
    await new Promise((r) => setTimeout(r, delay));
  }
}

function connectOnce(room: Room, gen: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayHostSocketUrl(location.origin, room.roomId, room.key));
    socket = ws;
    ws.onopen = () => {
      if (gen !== generation) {
        ws.close();
        return;
      }
      setState('connected');
    };
    ws.onmessage = (ev) => {
      let msg: RelayToHostMessage;
      try {
        msg = JSON.parse(String(ev.data)) as RelayToHostMessage;
      } catch {
        return;
      }
      if (msg.t === 'req') void forward(ws, msg);
      else if (msg.t === 'abort') {
        inflight.get(msg.id)?.abort();
        inflight.delete(msg.id);
      }
    };
    ws.onerror = () => reject(new Error('WebSocket do relay falhou'));
    ws.onclose = () => {
      for (const controller of inflight.values()) controller.abort();
      inflight.clear();
      if (socket === ws) socket = undefined;
      resolve();
    };
  });
}

function send(ws: WebSocket, msg: HostToRelayMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Repete um request do convidado contra a extensão local e devolve a resposta em pedaços. */
async function forward(ws: WebSocket, req: Extract<RelayToHostMessage, { t: 'req' }>): Promise<void> {
  const controller = new AbortController();
  inflight.set(req.id, controller);
  try {
    const res = await fetch(`${getServer()}${req.path}`, {
      method: req.method,
      headers: req.headers,
      body: req.body !== undefined ? fromBase64(req.body) : undefined,
      signal: controller.signal,
    });
    const headers: Record<string, string> = {};
    for (const name of RELAY_FORWARDED_RESPONSE_HEADERS) {
      const value = res.headers.get(name);
      if (value) headers[name] = value;
    }
    send(ws, { t: 'head', id: req.id, status: res.status, headers });
    if (res.body) {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.length) send(ws, { t: 'chunk', id: req.id, data: toBase64(value) });
      }
    }
    send(ws, { t: 'end', id: req.id });
  } catch (err) {
    if (!controller.signal.aborted) {
      send(ws, { t: 'err', id: req.id, message: (err as Error).message });
    }
  } finally {
    inflight.delete(req.id);
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // em fatias: String.fromCharCode(...bytes) estoura a pilha em pedaços grandes
  for (let i = 0; i < bytes.length; i += 0x2000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  }
  return btoa(binary);
}

function fromBase64(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

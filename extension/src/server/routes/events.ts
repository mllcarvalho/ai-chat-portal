import type { CollabIdentity, CollabPeer, PortalEventName, PortalEvents } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import { SseStream } from '../sse';
import { onBus } from '../../events/bus';
import { releaseExecutorClient } from '../../chat/executors';

/**
 * Canal global de eventos (SSE): cada aba conectada vira um "peer" com
 * presença (quem está online e olhando o quê). É por aqui que as outras abas
 * — e as outras pessoas, no modo colaboração — ficam sabendo de sessão que
 * mudou, geração que começou, operação no quadro etc.
 */

interface EventClient {
  clientId: string;
  identity: CollabIdentity;
  sse: SseStream;
  viewing?: CollabPeer['viewing'];
  /** A aba ligou o portal local dela: pode executar gerações na licença própria. */
  canExecute?: boolean;
  connectedAt: string;
}

const clients = new Map<string, EventClient>();

function toPeer(client: EventClient): CollabPeer {
  return {
    clientId: client.clientId,
    name: client.identity.name,
    role: client.identity.role,
    color: client.identity.color,
    viewing: client.viewing,
    ...(client.canExecute ? { canExecute: true } : {}),
    connectedAt: client.connectedAt,
  };
}

export function peersSnapshot(): CollabPeer[] {
  return [...clients.values()].map(toPeer);
}

/** Ids de convidados com ao menos uma aba conectada agora. */
export function onlineGuestIds(): Set<string> {
  const ids = new Set<string>();
  for (const client of clients.values()) {
    if (client.identity.guestId) ids.add(client.identity.guestId);
  }
  return ids;
}

export function broadcastEvent<E extends PortalEventName>(event: E, data: PortalEvents[E]): void {
  for (const client of clients.values()) client.sse.send(event, data);
}

/** Envia um evento SÓ para uma aba (federação: payload não vaza para as demais). Retorna false se ela não está conectada. */
export function sendToClient<E extends PortalEventName>(
  clientId: string,
  event: E,
  data: PortalEvents[E],
): boolean {
  const client = clients.get(clientId);
  if (!client || client.sse.closed) return false;
  client.sse.send(event, data);
  return true;
}

/** Presença muda em rajadas (reload abre/fecha rápido) — coalesce num tick só. */
let peersTimer: NodeJS.Timeout | undefined;
function broadcastPeersSoon(): void {
  if (peersTimer) return;
  peersTimer = setTimeout(() => {
    peersTimer = undefined;
    broadcastEvent('peers', { peers: peersSnapshot() });
  }, 120);
}

export function registerEventRoutes(router: Router): void {
  // tudo que o resto do portal emite no bus vai para todos os clientes
  onBus((event, data) => broadcastEvent(event, data));

  router.get('/api/events', ({ res, query, auth }) => {
    if (!auth) {
      sendError(res, 401, 'Token inválido ou ausente');
      return;
    }
    const clientId = query.get('clientId') ?? '';
    if (!clientId || clientId.length > 64) {
      sendError(res, 400, 'clientId é obrigatório');
      return;
    }
    // a mesma aba reconectou (rede caiu): derruba a conexão antiga em silêncio
    clients.get(clientId)?.sse.close();
    const client: EventClient = {
      clientId,
      identity: auth,
      sse: new SseStream(res),
      connectedAt: new Date().toISOString(),
    };
    clients.set(clientId, client);
    client.sse.send('hello', { clientId, identity: auth, peers: peersSnapshot() });
    broadcastPeersSoon();
    client.sse.onClose(() => {
      if (clients.get(clientId) === client) clients.delete(clientId);
      releaseExecutorClient(clientId);
      broadcastPeersSoon();
    });
  });

  // a aba conta o que está olhando (conversa aberta, quadro) — vira presença
  router.post('/api/events/viewing', ({ res, body }) => {
    const { clientId, sessionId, projectId, board } = (body ?? {}) as {
      clientId?: string;
      sessionId?: string;
      projectId?: string;
      board?: boolean;
    };
    const client = clientId ? clients.get(clientId) : undefined;
    if (!client) {
      // conexão já caiu (aba fechando): não é erro para a UI tratar
      sendJson(res, 200, { ok: false });
      return;
    }
    client.viewing =
      sessionId || projectId || board
        ? {
            ...(sessionId ? { sessionId } : {}),
            ...(projectId ? { projectId } : {}),
            ...(board ? { board: true } : {}),
          }
        : undefined;
    broadcastPeersSoon();
    sendJson(res, 200, { ok: true });
  });

  // a aba anuncia que ligou o portal local dela (pode executar na licença própria)
  router.post('/api/events/capability', ({ res, body }) => {
    const { clientId, canExecute } = (body ?? {}) as { clientId?: string; canExecute?: boolean };
    const client = clientId ? clients.get(clientId) : undefined;
    if (!client) {
      sendJson(res, 200, { ok: false });
      return;
    }
    client.canExecute = canExecute === true;
    broadcastPeersSoon();
    sendJson(res, 200, { ok: true });
  });

  // cursor sobre o quadro: efêmero, só repassa (não persiste, não bufferiza)
  router.post('/api/events/cursor', ({ res, body }) => {
    const { clientId, projectId, x, y, active } = (body ?? {}) as {
      clientId?: string;
      projectId?: string;
      x?: number;
      y?: number;
      active?: boolean;
    };
    const client = clientId ? clients.get(clientId) : undefined;
    if (!client || !projectId || typeof x !== 'number' || typeof y !== 'number') {
      sendJson(res, 200, { ok: false });
      return;
    }
    const event: PortalEvents['board_cursor'] = {
      projectId,
      clientId: client.clientId,
      name: client.identity.name,
      color: client.identity.color,
      x,
      y,
      active: active !== false,
    };
    // não devolve para quem mandou: o cursor local já está na tela da pessoa
    for (const other of clients.values()) {
      if (other.clientId !== client.clientId) other.sse.send('board_cursor', event);
    }
    sendJson(res, 200, { ok: true });
  });
}

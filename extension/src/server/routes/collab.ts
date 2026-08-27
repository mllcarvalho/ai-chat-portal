import * as os from 'node:os';
import type { CollabGuestInfo, CollabStatus } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import {
  addGuest,
  collabConfig,
  hostDisplayName,
  lanAddresses,
  revokeGuest,
  setCollabEnabled,
  setHostName,
} from '../../storage/collabStore';
import { onlineGuestIds, peersSnapshot } from './events';
import { executorFor, setExecutor } from '../../chat/executors';
import type { RouteDeps } from './index';

/**
 * Gestão do modo colaboração. Todas as rotas aqui são host-only (garantido no
 * httpServer), EXCETO /api/collab/me — é como qualquer cliente descobre quem é.
 */
export function registerCollabRoutes(router: Router, deps: RouteDeps): void {
  router.get('/api/collab/me', ({ res, auth }) => {
    if (!auth) {
      sendError(res, 401, 'Token inválido ou ausente');
      return;
    }
    sendJson(res, 200, auth);
  });

  const buildStatus = (): CollabStatus => {
    const collab = collabConfig();
    const port = deps.getPort();
    const lanUrls = collab.enabled ? lanAddresses().map((ip) => `http://${ip}:${port}`) : [];
    const online = onlineGuestIds();
    const guests: CollabGuestInfo[] = collab.guests.map((guest) => ({
      ...guest,
      joinUrls: guest.revoked ? [] : lanUrls.map((url) => `${url}/?token=${guest.token}`),
      online: online.has(guest.id),
    }));
    const host = os.hostname();
    return {
      enabled: collab.enabled,
      hostName: hostDisplayName(),
      lanUrls,
      ...(collab.enabled && host ? { mdnsUrl: `http://${host}:${port}` } : {}),
      port,
      guests,
      online: peersSnapshot(),
    };
  };

  router.get('/api/collab', ({ res }) => {
    sendJson(res, 200, buildStatus());
  });

  router.patch('/api/collab', ({ res, body }) => {
    const patch = (body ?? {}) as { enabled?: boolean; hostName?: string };
    if (typeof patch.hostName === 'string') setHostName(patch.hostName);
    let restarting = false;
    if (typeof patch.enabled === 'boolean' && patch.enabled !== collabConfig().enabled) {
      setCollabEnabled(patch.enabled);
      restarting = true;
      // responde primeiro, religa depois: o bind muda (127.0.0.1 ↔ 0.0.0.0) e
      // religar dentro do handler derrubaria esta própria resposta
      setTimeout(() => void deps.requestRestart(), 400);
    }
    sendJson(res, 200, { ...buildStatus(), restarting });
  });

  router.post('/api/collab/guests', ({ res, body }) => {
    const name = String(((body ?? {}) as { name?: string }).name ?? '').trim();
    if (!name || name.length > 60) {
      sendError(res, 400, 'Informe o nome de quem você quer convidar (até 60 caracteres)');
      return;
    }
    addGuest(name);
    sendJson(res, 201, buildStatus());
  });

  router.delete('/api/collab/guests/:id', ({ res, params, query }) => {
    const ok = revokeGuest(params.id, query.get('purge') === '1');
    if (!ok) {
      sendError(res, 404, 'Convite não encontrado');
      return;
    }
    sendJson(res, 200, buildStatus());
  });

  // executor de uma conversa (federação): quem roda a inferência. Qualquer
  // participante da sessão pode escolher; clientId vazio/null = volta ao host.
  router.get('/api/collab/executor', ({ res, query }) => {
    const sessionId = query.get('sessionId') ?? '';
    const chosen = sessionId ? executorFor(sessionId) : undefined;
    sendJson(res, 200, {
      executorClientId: chosen?.clientId ?? null,
      executorName: chosen?.name ?? null,
    });
  });

  router.post('/api/collab/executor', ({ res, body }) => {
    const { sessionId, executorClientId } = (body ?? {}) as {
      sessionId?: string;
      executorClientId?: string | null;
    };
    if (!sessionId) {
      sendError(res, 400, 'sessionId é obrigatório');
      return;
    }
    setExecutor(sessionId, executorClientId ?? null);
    sendJson(res, 200, { ok: true });
  });
}

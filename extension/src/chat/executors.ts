import type { CollabPeer } from '@aiportal/shared';
import { emitBus } from '../events/bus';
import { peersSnapshot } from '../server/routes/events';

/**
 * Executor de cada conversa (federação de licenças). Estado em memória (não
 * persiste): é amarrado a uma aba conectada AGORA. undefined = host executa,
 * que é o padrão de sempre.
 */
const bySession = new Map<string, { clientId: string; name: string }>();

/** Peer conectado que anunciou poder executar na própria licença. */
function findExecutorPeer(clientId: string): CollabPeer | undefined {
  return peersSnapshot().find((p) => p.clientId === clientId && p.canExecute);
}

export function setExecutor(sessionId: string, clientId: string | null, name?: string): void {
  if (!clientId) {
    bySession.delete(sessionId);
    emitBus('executor_changed', { sessionId, executorClientId: null, executorName: null });
    return;
  }
  const peer = findExecutorPeer(clientId);
  const finalName = name ?? peer?.name ?? 'convidado';
  bySession.set(sessionId, { clientId, name: finalName });
  emitBus('executor_changed', { sessionId, executorClientId: clientId, executorName: finalName });
}

/**
 * Executor VÁLIDO desta conversa: só vale se a aba dele continua conectada e
 * ainda anuncia que pode executar. Se saiu, limpa e devolve undefined (o host
 * assume) — sem deixar a conversa presa a um executor fantasma.
 */
export function activeExecutor(sessionId: string): { clientId: string; name: string } | undefined {
  const chosen = bySession.get(sessionId);
  if (!chosen) return undefined;
  if (!findExecutorPeer(chosen.clientId)) {
    bySession.delete(sessionId);
    emitBus('executor_changed', { sessionId, executorClientId: null, executorName: null });
    return undefined;
  }
  return chosen;
}

/** Uma aba saiu: solta as conversas que dependiam dela. */
export function releaseExecutorClient(clientId: string): void {
  for (const [sessionId, chosen] of bySession) {
    if (chosen.clientId === clientId) {
      bySession.delete(sessionId);
      emitBus('executor_changed', { sessionId, executorClientId: null, executorName: null });
    }
  }
}

export function executorFor(sessionId: string): { clientId: string; name: string } | undefined {
  return bySession.get(sessionId);
}

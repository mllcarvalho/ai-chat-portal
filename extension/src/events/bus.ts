import type { PortalEventName, PortalEvents } from '@aiportal/shared';

/**
 * Bus interno de eventos do portal: storage e chat EMITEM aqui, e o canal SSE
 * global (server/routes/events.ts) assina e repassa aos clientes conectados.
 * Módulo sem dependências de propósito — storage não pode importar o servidor
 * (ciclo), mas qualquer um pode importar o bus.
 */

type Listener = <E extends PortalEventName>(event: E, data: PortalEvents[E]) => void;

const listeners = new Set<Listener>();

export function onBus(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitBus<E extends PortalEventName>(event: E, data: PortalEvents[E]): void {
  for (const listener of listeners) {
    try {
      listener(event, data);
    } catch (err) {
      // um assinante quebrado não pode derrubar quem emitiu (ex.: saveSession)
      console.error('[ai-chat-portal] listener de evento falhou:', err);
    }
  }
}

import { TOKEN_HEADER } from '@aiportal/shared';
import { getToken } from './client';
import { apiUrl } from './server';

/**
 * Leitor do canal global de eventos (GET /api/events, SSE). Mesma mecânica do
 * sseChat (fetch + ReadableStream + watchdog de heartbeat), mas genérico: os
 * eventos vão crus para um handler único — quem interpreta é o collabStore.
 */

const IDLE_TIMEOUT_MS = 45_000;

export async function streamPortalEvents(
  clientId: string,
  onEvent: (event: string, data: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(apiUrl(`/api/events?clientId=${encodeURIComponent(clientId)}`), {
    headers: { [TOKEN_HEADER]: getToken() },
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Erro ${res.status} no canal de eventos`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const readWithIdleTimeout = async () => {
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          idleTimer = setTimeout(() => {
            void reader.cancel().catch(() => undefined);
            reject(new Error('Canal de eventos parou de responder'));
          }, IDLE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(idleTimer);
    }
  };

  const dispatch = (block: string) => {
    let event = '';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!event || !dataLines.length) return;
    try {
      onEvent(event, JSON.parse(dataLines.join('\n')));
    } catch {
      // dado malformado: ignora o evento, não o canal
    }
  };

  while (true) {
    const { done, value } = await readWithIdleTimeout();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (block.trim() && !block.startsWith(':')) dispatch(block);
    }
  }
}

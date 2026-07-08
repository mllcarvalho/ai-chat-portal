import type { ChatSseEventName, ChatSseEvents } from '@aiportal/shared';
import type { SseStream } from '../server/sse';

/** Janela para o cliente reconectar (reload/queda de rede) antes de cancelar a geração. */
const REATTACH_GRACE_MS = 120_000;

interface BufferedEvent {
  event: ChatSseEventName;
  data: unknown;
}

/**
 * Stream de chat que sobrevive à conexão HTTP: todo evento fica num buffer e
 * uma reconexão (POST /api/chat/attach) recebe o replay completo antes de
 * seguir ao vivo. Suporta VÁRIOS clientes ao mesmo tempo (duas abas, webview +
 * browser) — cada attach vira um sink extra, sem derrubar os demais. A geração
 * só é cancelada se TODOS os clientes sumirem e ninguém reconectar dentro do
 * período de graça — espelha o comportamento do Copilot Chat, que não perde a
 * resposta num reload.
 */
export class ChatStream {
  private buffer: BufferedEvent[] = [];
  private sinks = new Set<SseStream>();
  private closeCallbacks: Array<() => void> = [];
  private graceTimer?: NodeJS.Timeout;
  closed = false;
  /**
   * O done já saiu: a conexão ainda vive (esperando o usage_update), mas a
   * geração acabou — a sessão já pode aceitar um novo envio e um attach não
   * faz mais sentido.
   */
  generationDone = false;

  constructor(
    readonly sessionId: string,
    readonly requestId: string,
    initial: SseStream,
  ) {
    this.attach(initial);
  }

  send<E extends ChatSseEventName>(event: E, data: ChatSseEvents[E]): void {
    if (this.closed) return;
    if (event === 'done') this.generationDone = true;
    this.buffer.push({ event, data });
    for (const sink of this.sinks) sink.send(event, data);
  }

  /** Soma uma conexão HTTP ao stream e faz replay de tudo que já foi emitido para ela. */
  attach(sse: SseStream): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
    this.sinks.add(sse);
    for (const { event, data } of this.buffer) {
      sse.send(event, data as ChatSseEvents[ChatSseEventName]);
    }
    sse.onClose(() => {
      this.sinks.delete(sse);
      // o último cliente caiu no meio da geração: espera uma reconexão antes de desistir
      if (this.sinks.size || this.closed) return;
      this.graceTimer = setTimeout(() => {
        for (const cb of this.closeCallbacks) cb();
      }, REATTACH_GRACE_MS);
    });
  }

  /** Dispara só quando TODOS os clientes sumiram de vez (sem reconexão no período de graça). */
  onClose(cb: () => void): void {
    this.closeCallbacks.push(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    for (const sink of this.sinks) sink.close();
    this.sinks.clear();
    if (bySession.get(this.sessionId) === this) bySession.delete(this.sessionId);
  }
}

const bySession = new Map<string, ChatStream>();

export function registerStream(stream: ChatStream): void {
  bySession.set(stream.sessionId, stream);
}

/** Stream com geração em andamento na sessão (uma resposta por conversa), se houver. */
export function activeStream(sessionId: string): ChatStream | undefined {
  const stream = bySession.get(sessionId);
  return stream && !stream.closed && !stream.generationDone ? stream : undefined;
}

/** Sessões com geração em andamento — usado no boot da SPA para retomar todas. */
export function activeSessionIds(): string[] {
  return [...bySession.values()]
    .filter((s) => !s.closed && !s.generationDone)
    .map((s) => s.sessionId);
}

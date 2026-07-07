import type { ServerResponse } from 'node:http';
import type { ChatSseEventName, ChatSseEvents } from '@aiportal/shared';

const HEARTBEAT_MS = 15_000;

export class SseStream {
  private heartbeat: NodeJS.Timeout;
  private closeCallbacks: Array<() => void> = [];
  closed = false;

  constructor(private res: ServerResponse) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.socket?.setNoDelay(true);
    this.heartbeat = setInterval(() => this.write(': ping\n\n'), HEARTBEAT_MS);
    res.on('close', () => this.markClosed());
  }

  /** Há uma janela entre o socket morrer e o 'close' chegar: EPIPE aqui é fim de conexão. */
  private write(chunk: string): void {
    if (this.closed) return;
    try {
      this.res.write(chunk);
    } catch {
      this.markClosed();
    }
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const cb of this.closeCallbacks) cb();
  }

  send<E extends ChatSseEventName>(event: E, data: ChatSseEvents[E]): void {
    this.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** Chamado quando o cliente desconecta antes do fim (para cancelar a geração). */
  onClose(cb: () => void): void {
    this.closeCallbacks.push(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    try {
      this.res.end();
    } catch {
      // socket já morto
    }
  }
}

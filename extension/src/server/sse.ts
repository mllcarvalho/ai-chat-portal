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
    this.heartbeat = setInterval(() => {
      if (!this.closed) this.res.write(': ping\n\n');
    }, HEARTBEAT_MS);
    res.on('close', () => {
      if (this.closed) return;
      this.closed = true;
      clearInterval(this.heartbeat);
      for (const cb of this.closeCallbacks) cb();
    });
  }

  send<E extends ChatSseEventName>(event: E, data: ChatSseEvents[E]): void {
    if (this.closed) return;
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** Chamado quando o cliente desconecta antes do fim (para cancelar a geração). */
  onClose(cb: () => void): void {
    this.closeCallbacks.push(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.res.end();
  }
}

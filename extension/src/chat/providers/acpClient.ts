import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';

/**
 * Cliente do Agent Client Protocol (JSON-RPC 2.0 sobre stdio), o protocolo que
 * editores usam para dirigir agentes de terminal.
 *
 * O enquadramento é uma mensagem JSON por linha (ndjson) — confirmado no
 * tráfego real do `devin acp`, não no estilo Content-Length do LSP.
 *
 * A conversa é bidirecional: além de responder o que pedimos, o agente faz
 * requisições DE VOLTA (pedir permissão para uma ferramenta, ler/escrever
 * arquivo). Por isso `onRequest` é obrigatório — ignorar uma requisição do
 * agente trava o turno esperando resposta.
 */

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AcpClientOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Notificações do agente (sem id): session/update e afins. */
  onNotification: (method: string, params: unknown) => void;
  /** Requisições do agente (com id) — o retorno vira o `result` da resposta. */
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  /** Linha de stdout que não era JSON — útil para diagnosticar. */
  onRaw?: (line: string) => void;
}

export class AcpProcessError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export class AcpClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private stderr = '';
  private closed = false;
  /** Resolve quando o processo morre — para não pendurar em promessa órfã. */
  private readonly exited: Promise<void>;

  constructor(private readonly opts: AcpClientOptions) {
    try {
      this.child = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env });
    } catch (err) {
      throw new AcpProcessError(
        `Não foi possível iniciar "${opts.command}".`,
        err instanceof Error ? err.message : String(err),
        'ENOENT',
      );
    }

    this.child.stderr.on('data', (d: Buffer) => {
      this.stderr += d.toString();
      // stderr de agente é verboso; guarda só o fim, que é onde o erro aparece
      if (this.stderr.length > 16 * 1024) this.stderr = this.stderr.slice(-16 * 1024);
    });

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this.onLine(line));

    this.exited = new Promise<void>((resolve) => {
      const finish = (err?: Error): void => {
        if (this.closed) return;
        this.closed = true;
        rl.close();
        // quem estava esperando resposta não pode ficar pendurado
        const fail = err ?? new AcpProcessError('O agente encerrou.', this.stderr);
        for (const { reject } of this.pending.values()) reject(fail);
        this.pending.clear();
        resolve();
      };
      this.child.on('error', (err: NodeJS.ErrnoException) => {
        finish(
          new AcpProcessError(
            err.code === 'ENOENT'
              ? `O comando "${opts.command}" não foi encontrado no PATH.`
              : `Falha ao executar "${opts.command}".`,
            this.stderr || err.message,
            err.code,
          ),
        );
      });
      this.child.on('close', () => finish());
    });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith('{')) {
      this.opts.onRaw?.(trimmed);
      return;
    }
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      this.opts.onRaw?.(trimmed);
      return;
    }

    // resposta a algo que pedimos
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(Number(msg.id));
      if (!entry) return;
      this.pending.delete(Number(msg.id));
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
      return;
    }

    // requisição do agente: precisa de resposta, senão o turno trava
    if (msg.id !== undefined && msg.method) {
      void this.opts
        .onRequest(msg.method, msg.params)
        .then((result) => this.write({ jsonrpc: '2.0', id: msg.id, result: result ?? null }))
        .catch((err: unknown) =>
          this.write({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          }),
        );
      return;
    }

    if (msg.method) this.opts.onNotification(msg.method, msg.params);
  }

  private write(msg: JsonRpcMessage): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify(msg)}\n`);
    } catch {
      // processo morreu no meio da escrita; o close trata o desfecho
    }
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new AcpProcessError('O agente já encerrou.', this.stderr));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  get stderrTail(): string {
    return this.stderr;
  }

  /** Encerra o processo e espera ele sair de fato. */
  async dispose(): Promise<void> {
    if (!this.closed) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        /* já morreu */
      }
      const hard = setTimeout(() => {
        try {
          this.child.kill('SIGKILL');
        } catch {
          /* já morreu */
        }
      }, 3000);
      hard.unref?.();
    }
    await this.exited;
  }
}

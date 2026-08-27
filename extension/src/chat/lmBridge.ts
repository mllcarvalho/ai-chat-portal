import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { LmChunk, LmToolDef } from '@aiportal/shared';
import { serializeMessages } from './providers/lmWire';
import { sendToClient } from '../server/routes/events';

/**
 * Ponte da federação de licenças, lado HOST. Quando uma conversa tem um
 * executor (convidado que ligou o portal local dele), o loop do Copilot chama
 * `remoteSendRequest` no lugar de `vscode.lm`: a requisição vai para a aba do
 * executor (evento `lm_request`), que a roda no Copilot DELE e devolve os
 * pedaços por POST /api/lm/:jobId/chunk — que caem em `feedJob`.
 *
 * Nenhum servidor fala com o outro: a aba do executor é a ponte. Ferramentas,
 * arquivos, aprovações e histórico continuam 100% no host.
 */

interface Job {
  queue: LmChunk[];
  resolve?: (chunk: LmChunk | undefined) => void;
  done: boolean;
  credits?: number;
  modelId?: string;
  modelName?: string;
  targetClientId: string;
}

const jobs = new Map<string, Job>();

/** O executor (ou outra aba) empurra um pedaço do stream. Retorna false se o job sumiu. */
export function feedJob(jobId: string, chunk: LmChunk): boolean {
  const job = jobs.get(jobId);
  if (!job || job.done) return false;
  if (chunk.type === 'done') {
    job.credits = chunk.credits;
    job.modelId = chunk.modelId;
    job.modelName = chunk.modelName;
  }
  if (job.resolve) {
    const r = job.resolve;
    job.resolve = undefined;
    r(chunk);
  } else {
    job.queue.push(chunk);
  }
  return true;
}

export interface RemoteResponse {
  /** Stream de partes do modelo, no mesmo formato que o vscode.lm entrega. */
  stream: AsyncIterable<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>;
  /** Resolve quando a requisição termina: créditos e modelo reportados pelo executor. */
  meta: () => { credits?: number; modelId?: string; modelName?: string };
}

/**
 * Roda uma requisição de modelo na máquina do executor. Rejeita se o executor
 * some antes de responder (o chamador cai no host). O `token` cancela: avisa a
 * aba do executor para abortar o Copilot dele.
 */
export function remoteSendRequest(
  targetClientId: string,
  messages: vscode.LanguageModelChatMessage[],
  tools: LmToolDef[],
  modelId: string | undefined,
  token: vscode.CancellationToken,
): RemoteResponse {
  const jobId = crypto.randomUUID();
  const job: Job = { queue: [], done: false, targetClientId };
  jobs.set(jobId, job);

  // sem resposta em 25s = executor sumiu no meio do handshake → erro (fallback)
  const HANDSHAKE_TIMEOUT_MS = 25_000;
  let firstChunkSeen = false;

  const delivered = sendToClient(targetClientId, 'lm_request', {
    targetClientId,
    job: { jobId, messages: serializeMessages(messages), tools, ...(modelId ? { modelId } : {}) },
  });
  if (!delivered) {
    jobs.delete(jobId);
    throw new Error('O executor escolhido não está mais conectado.');
  }

  const cancelSub = token.onCancellationRequested(() => {
    sendToClient(targetClientId, 'lm_cancel', { targetClientId, jobId });
    feedJob(jobId, { type: 'error', message: 'Cancelado.', code: 'cancelled' });
  });

  const nextChunk = (): Promise<LmChunk | undefined> => {
    if (job.queue.length) return Promise.resolve(job.queue.shift());
    if (job.done) return Promise.resolve(undefined);
    return new Promise<LmChunk | undefined>((resolve) => {
      job.resolve = resolve;
      if (!firstChunkSeen) {
        const t = setTimeout(() => {
          if (!firstChunkSeen && job.resolve === resolve) {
            job.resolve = undefined;
            resolve({ type: 'error', message: 'O executor não respondeu a tempo.', code: 'timeout' });
          }
        }, HANDSHAKE_TIMEOUT_MS);
        // limpa o timer quando a promise resolver por outra via
        void Promise.resolve().then(() => t.unref?.());
      }
    });
  };

  async function* stream(): AsyncIterable<
    vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart
  > {
    try {
      while (true) {
        const chunk = await nextChunk();
        if (!chunk) break;
        firstChunkSeen = true;
        if (chunk.type === 'text') {
          yield new vscode.LanguageModelTextPart(chunk.value);
        } else if (chunk.type === 'tool_call') {
          yield new vscode.LanguageModelToolCallPart(chunk.callId, chunk.name, chunk.input as object);
        } else if (chunk.type === 'error') {
          throw new Error(chunk.message || 'Falha na execução remota.');
        } else if (chunk.type === 'done') {
          break;
        }
      }
    } finally {
      job.done = true;
      jobs.delete(jobId);
      cancelSub.dispose();
    }
  }

  return {
    stream: stream(),
    meta: () => ({ credits: job.credits, modelId: job.modelId, modelName: job.modelName }),
  };
}

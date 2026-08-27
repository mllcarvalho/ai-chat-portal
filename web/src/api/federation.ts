import type { LmChunk, LmRunRequest } from '@aiportal/shared';
import { TOKEN_HEADER } from '@aiportal/shared';
import { api } from './client';

/**
 * Federação de licenças, lado EXECUTOR (a aba do convidado que ligou o portal
 * local dele). Quando o host manda um `lm_request`, esta aba roda a inferência
 * no PRÓPRIO portal local (na licença dela) e relaia cada pedaço de volta ao
 * host. Nenhum servidor fala com o outro — o navegador é a ponte.
 */

const LOCAL_KEY = 'aiportal.localPortalUrl';

/** URL do portal local (do comando "Copiar URL do Portal"), com ?token=. */
export function getLocalPortal(): { base: string; token: string } | undefined {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LOCAL_KEY);
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const token = url.searchParams.get('token') ?? '';
    if (!token) return undefined;
    return { base: url.origin, token };
  } catch {
    return undefined;
  }
}

export function setLocalPortal(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    try {
      localStorage.removeItem(LOCAL_KEY);
    } catch {
      // sem storage
    }
    return true;
  }
  try {
    const url = new URL(trimmed);
    if (!url.searchParams.get('token')) return false;
    localStorage.setItem(LOCAL_KEY, trimmed);
    return true;
  } catch {
    return false;
  }
}

/** Testa se o portal local responde e tem Copilot (para o host confiar no executor). */
export async function pingLocalPortal(): Promise<{ ok: boolean; detail: string }> {
  const local = getLocalPortal();
  if (!local) return { ok: false, detail: 'Nenhuma URL de portal local configurada.' };
  try {
    const res = await fetch(`${local.base}/api/models`, {
      headers: { [TOKEN_HEADER]: local.token },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, detail: `Portal local respondeu ${res.status}.` };
    const models = (await res.json()) as unknown[];
    if (!Array.isArray(models) || !models.length) {
      return { ok: false, detail: 'Portal local sem modelos do Copilot disponíveis.' };
    }
    return { ok: true, detail: `${models.length} modelo(s) disponíveis na sua licença.` };
  } catch (err) {
    return { ok: false, detail: `Não alcancei o portal local: ${(err as Error).message}` };
  }
}

const activeJobs = new Map<string, AbortController>();

/** Cancela um job de execução remota em andamento (o host pediu). */
export function cancelJob(jobId: string): void {
  activeJobs.get(jobId)?.abort();
  activeJobs.delete(jobId);
}

/**
 * Executa um job vindo do host no portal local e relaia os pedaços de volta.
 * Nunca lança: qualquer falha vira um chunk de erro para o host (que então
 * mostra o erro — nunca cai silenciosamente no host, para a atribuição de
 * licença não mentir).
 */
export async function runFederatedJob(job: LmRunRequest): Promise<void> {
  const relay = (chunk: LmChunk) => void api.postLmChunk(job.jobId, chunk).catch(() => undefined);
  const local = getLocalPortal();
  if (!local) {
    relay({ type: 'error', message: 'Executor sem portal local configurado.', code: 'no_local' });
    return;
  }
  const controller = new AbortController();
  activeJobs.set(job.jobId, controller);
  try {
    const res = await fetch(`${local.base}/api/lm/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: local.token },
      body: JSON.stringify({ messages: job.messages, tools: job.tools, modelId: job.modelId }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      relay({ type: 'error', message: `Portal local respondeu ${res.status}.`, code: 'local_error' });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    while (!done) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim());
        if (!dataLines.length) continue;
        try {
          const chunk = JSON.parse(dataLines.join('\n')) as LmChunk;
          relay(chunk);
          if (chunk.type === 'done' || chunk.type === 'error') done = true;
        } catch {
          // bloco malformado: ignora
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') return; // host cancelou
    relay({ type: 'error', message: (err as Error).message, code: 'relay_error' });
  } finally {
    activeJobs.delete(job.jobId);
  }
}

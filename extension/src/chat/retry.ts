import * as vscode from 'vscode';

/** Retentativas por rodada quando o gateway do Copilot falha de forma transitória. */
export const MODEL_RETRIES = 2;
export const MODEL_RETRY_DELAY_MS = 1500;

export function isRateLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /\b429\b/.test(msg) || msg.includes('rate limit') || msg.includes('too many requests');
}

/**
 * Erros transitórios do gateway do Copilot (api.githubcopilot.com) que valem
 * retry: 5xx, 429, timeout e queda de conexão — típicos quando o backend do
 * modelo demora demais com um prompt grande. Erros de permissão/conteúdo não
 * entram: retry não muda o resultado.
 */
export function isTransientModelError(err: unknown): boolean {
  if (err instanceof vscode.LanguageModelError && err.code !== 'Unknown') return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    isRateLimitError(err) ||
    /\b(502|503|504)\b/.test(msg) ||
    msg.includes('bad gateway') ||
    msg.includes('gateway timeout') ||
    msg.includes('service unavailable') ||
    msg.includes('socket hang up') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('fetch failed') ||
    msg.includes('network error')
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deixa o stop do usuário valer na hora: rejeita no cancelamento (ou no
 * timeout) sem esperar a tool — o resultado tardio é descartado. A promise
 * original segue rodando em background, mas o loop não fica refém dela.
 */
export function raceCancellation<T>(
  promise: Promise<T>,
  token: vscode.CancellationToken,
  timeoutMs?: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          settle(() => reject(new Error(`A ferramenta excedeu ${timeoutMs / 1000}s e foi abandonada`)));
        }, timeoutMs)
      : undefined;
    const sub = token.onCancellationRequested(() => {
      settle(() => reject(new Error('Cancelado pelo usuário')));
    });
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      sub.dispose();
      fn();
    };
    promise.then(
      (value) => settle(() => resolve(value)),
      (err) => settle(() => reject(err)),
    );
  });
}

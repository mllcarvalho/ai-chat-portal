import * as vscode from 'vscode';

/** Retentativas por rodada quando o gateway do Copilot falha de forma transitória. */
export const MODEL_RETRIES = 2;
export const MODEL_RETRY_DELAY_MS = 1500;

/** O gateway pendurou sem erro e sem tokens — vale retry como um 504. */
export class ModelIdleTimeoutError extends Error {
  constructor(idleMs: number) {
    super(
      `O modelo ficou ${Math.round(idleMs / 1000)}s sem enviar progresso e a rodada foi abandonada. ` +
        'Tente de novo em instantes; se estava gerando um arquivo muito grande, peça o conteúdo em partes menores.',
    );
  }
}

export function isRateLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /\b429\b/.test(msg) || msg.includes('rate limit') || msg.includes('too many requests');
}

/**
 * Sessão do Copilot vencida: o Copilot Chat troca o login do GitHub por um
 * token de ~30 min e o renova sozinho, mas a renovação leva alguns segundos
 * (e passa por api.github.com, que a rede corporativa às vezes atrasa). Vale
 * retry com espera maior — reenviar na hora reusa o token vencido e falha.
 */
export function isTokenExpiredError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('token expired or invalid') ||
    (/\b(401|403)\b/.test(msg) && /token|auth/.test(msg))
  );
}

/** Espera antes do retry: renovação de sessão demora mais que blip de gateway. */
const TOKEN_RETRY_DELAY_MS = 4000;

export function retryDelayMs(err: unknown, attempt: number): number {
  return (isTokenExpiredError(err) ? TOKEN_RETRY_DELAY_MS : MODEL_RETRY_DELAY_MS) * (attempt + 1);
}

/**
 * Erros transitórios do gateway do Copilot (api.githubcopilot.com) que valem
 * retry: 5xx, 429, timeout e queda de conexão — típicos quando o backend do
 * modelo demora demais com um prompt grande. Erros de permissão/conteúdo não
 * entram: retry não muda o resultado.
 */
export function isTransientModelError(err: unknown): boolean {
  if (err instanceof ModelIdleTimeoutError) return true;
  if (isTokenExpiredError(err)) return true;
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

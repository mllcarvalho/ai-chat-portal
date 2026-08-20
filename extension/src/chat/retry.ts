import * as vscode from 'vscode';

/** Retentativas por rodada quando o gateway do Copilot falha de forma transitória. */
export const MODEL_RETRIES = 2;
export const MODEL_RETRY_DELAY_MS = 1500;

/**
 * Retentativas quando o silêncio do gateway estourou o teto. UMA só: a rodada
 * abandonada custou minutos e créditos, e repetir a mesma geração condenada
 * duas vezes só multiplica o prejuízo. A tentativa que sobra vai com a dica de
 * gravar em blocos (IDLE_RETRY_HINT), então é uma tentativa DIFERENTE.
 */
export const IDLE_RETRIES = 1;

/**
 * Instrução injetada na retentativa depois de um ModelIdleTimeoutError. Sem
 * ela o modelo repete exatamente a geração que estourou o tempo — o retry cego
 * queimava três rodadas para terminar no mesmo erro.
 */
export const IDLE_RETRY_HINT =
  '[portal] A tentativa anterior foi abandonada: a chamada de ferramenta ficou tempo demais sem ' +
  'retorno, sinal de conteúdo grande demais numa única chamada. Refaça AGORA em partes: cada ' +
  'chamada de portal_write_file leva no máximo ~120 linhas — a primeira cria o arquivo e as ' +
  'seguintes continuam com append: true. Não repita a geração inteira de uma vez só.';

/** Duração legível para mensagens de usuário (segundos até 2 min, depois minutos). */
function humanDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)} min`;
}

/** O gateway pendurou sem erro e sem tokens — vale retry como um 504. */
export class ModelIdleTimeoutError extends Error {
  constructor(idleMs: number) {
    super(
      `O modelo ficou ${humanDuration(idleMs)} sem enviar nada e a rodada foi abandonada — ` +
        'uma chamada de ferramenta muito grande (um arquivo inteiro, por exemplo) só chega no fim ' +
        'da geração. O portal já tentou de novo pedindo o conteúdo em partes. ' +
        'Peça o material por seções (ex.: "gere só a seção 1 agora") ou um arquivo menor.',
    );
  }
}

/**
 * O gateway do Copilot pode pendurar sem erro e sem tokens; como o heartbeat
 * mantém o SSE "vivo", sem este teto de progresso a resposta ficaria em
 * "digitando" para sempre. Vale entre um evento e o próximo, não para a
 * resposta inteira. IMPORTANTE: um tool call chega INTEIRO no fim da geração
 * — modelo escrevendo um portal_write_file com um HTML grande fica MINUTOS
 * sem emitir parte nenhuma, saudável; 120s matava essas gerações e 300s ainda
 * pegava as maiores. Com 10 min o silêncio esperado cabe; o usuário não fica
 * no escuro porque os avisos escalonados abaixo contam a história, e o "Parar"
 * continua valendo na hora (raceCancellation).
 */
export const MODEL_IDLE_TIMEOUT_MS = 600_000;

/**
 * Silêncios em que a UI avisa que a demora é esperada, em vez de deixar a
 * pessoa achando que travou. Escalonado: quanto mais tempo passa, mais
 * específico o aviso — e o último ainda cai bem antes do teto.
 */
export const MODEL_SLOW_NOTICE_STEPS_MS = [60_000, 180_000, 360_000];

/**
 * Corre a promise contra o teto de silêncio, avisando pelo caminho. `onSlow`
 * recebe quanto tempo já passou (um dos degraus acima) — quem chama decide o
 * que fazer com isso (o chat manda um notice ao vivo; o subagente ignora).
 */
export function withIdleTimeout<T>(
  promise: PromiseLike<T>,
  onSlow?: (elapsedMs: number) => void,
): Promise<T> {
  const timers: NodeJS.Timeout[] = [];
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      if (onSlow) {
        for (const step of MODEL_SLOW_NOTICE_STEPS_MS) {
          if (step < MODEL_IDLE_TIMEOUT_MS) timers.push(setTimeout(() => onSlow(step), step));
        }
      }
      timers.push(
        setTimeout(
          () => reject(new ModelIdleTimeoutError(MODEL_IDLE_TIMEOUT_MS)),
          MODEL_IDLE_TIMEOUT_MS,
        ),
      );
    }),
  ]).finally(() => {
    for (const timer of timers) clearTimeout(timer);
  }) as Promise<T>;
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

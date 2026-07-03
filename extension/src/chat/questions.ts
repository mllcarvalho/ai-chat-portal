import type * as vscode from 'vscode';

/**
 * Perguntas do portal_ask_user pendentes: o agentLoop emite o evento SSE
 * user_question e fica aguardando aqui até a UI responder via
 * POST /api/chat/:requestId/question (ou timeout/cancelamento).
 */

export type QuestionOutcome =
  | { kind: 'answered'; answer: string }
  | { kind: 'timeout' }
  | { kind: 'cancelled' };

/** Elicitações podem exigir reflexão — mais folga que a aprovação de comando. */
const QUESTION_TIMEOUT_MS = 10 * 60 * 1000;

const pending = new Map<string, (outcome: QuestionOutcome) => void>();

function key(requestId: string, callId: string): string {
  return `${requestId}:${callId}`;
}

export function waitForAnswer(
  requestId: string,
  callId: string,
  token: vscode.CancellationToken,
): Promise<QuestionOutcome> {
  return new Promise((resolve) => {
    const k = key(requestId, callId);
    const timer = setTimeout(() => settle({ kind: 'timeout' }), QUESTION_TIMEOUT_MS);
    const cancelListener = token.onCancellationRequested(() => settle({ kind: 'cancelled' }));
    const settle = (outcome: QuestionOutcome) => {
      if (!pending.delete(k)) return;
      clearTimeout(timer);
      cancelListener.dispose();
      resolve(outcome);
    };
    pending.set(k, settle);
  });
}

/** Resposta vinda da UI. false = não havia pergunta pendente (expirou/cancelou). */
export function resolveQuestion(requestId: string, callId: string, answer: string): boolean {
  const settle = pending.get(key(requestId, callId));
  if (!settle) return false;
  settle({ kind: 'answered', answer });
  return true;
}

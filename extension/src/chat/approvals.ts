import type * as vscode from 'vscode';

/**
 * Aprovações de comando pendentes: o agentLoop emite o evento SSE
 * approval_request e fica aguardando aqui até a UI responder via
 * POST /api/chat/:requestId/approval (ou timeout/cancelamento = negado).
 */

export type ApprovalVerdict = 'approved' | 'denied' | 'timeout';

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

const pending = new Map<string, (verdict: ApprovalVerdict) => void>();

function key(requestId: string, callId: string): string {
  return `${requestId}:${callId}`;
}

export function waitForApproval(
  requestId: string,
  callId: string,
  token: vscode.CancellationToken,
): Promise<ApprovalVerdict> {
  return new Promise((resolve) => {
    const k = key(requestId, callId);
    const timer = setTimeout(() => settle('timeout'), APPROVAL_TIMEOUT_MS);
    const cancelListener = token.onCancellationRequested(() => settle('denied'));
    const settle = (verdict: ApprovalVerdict) => {
      if (!pending.delete(k)) return;
      clearTimeout(timer);
      cancelListener.dispose();
      resolve(verdict);
    };
    pending.set(k, settle);
  });
}

/** Resposta vinda da UI. false = não havia aprovação pendente (expirou/cancelou). */
export function resolveApproval(requestId: string, callId: string, approved: boolean): boolean {
  const settle = pending.get(key(requestId, callId));
  if (!settle) return false;
  settle(approved ? 'approved' : 'denied');
  return true;
}

import * as vscode from 'vscode';

const active = new Map<string, vscode.CancellationTokenSource>();

export function registerRequest(requestId: string): vscode.CancellationTokenSource {
  const cts = new vscode.CancellationTokenSource();
  active.set(requestId, cts);
  return cts;
}

export function cancelRequest(requestId: string): boolean {
  const cts = active.get(requestId);
  if (!cts) return false;
  cts.cancel();
  return true;
}

export function releaseRequest(requestId: string): void {
  const cts = active.get(requestId);
  active.delete(requestId);
  cts?.dispose();
}

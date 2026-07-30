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

/**
 * Token da geração em andamento. A ponte MCP precisa dele: uma ferramenta
 * chamada de fora (pelo Claude Code ou pelo Devin) tem que morrer junto com o
 * "Parar" da conversa, igual às chamadas de dentro do loop do Copilot.
 */
export function tokenFor(requestId: string): vscode.CancellationToken | undefined {
  return active.get(requestId)?.token;
}

export function releaseRequest(requestId: string): void {
  const cts = active.get(requestId);
  active.delete(requestId);
  cts?.dispose();
}

/**
 * Cancela TODAS as gerações em andamento — usado quando esta janela cede o
 * portal para outra: sem isso a geração órfã seguia gastando créditos e ainda
 * gravava a resposta velha no session.json depois de a janela nova assumir.
 */
export function cancelAllRequests(): void {
  for (const cts of active.values()) cts.cancel();
}

import * as vscode from 'vscode';
import { withTimeout } from '../util';

/**
 * MCP oficial do GitHub (o mesmo que o Copilot usa no VS Code): servidor
 * remoto em api.githubcopilot.com/mcp/, autenticado com o token da conta
 * GitHub conectada no VS Code. O token é obtido a cada subida do servidor e
 * entra só no header Authorization da conexão — nunca é persistido no
 * mcp.json. Mesmo padrão de consentimento do copilot.ts: `silent` não abre
 * diálogo, então a 1ª vez pede autorização por notificação no VS Code.
 */

export const GITHUB_MCP_SERVER_NAME = 'github';
export const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/';

/** repo + read:org cobrem as tools principais (repos, issues, PRs, org). */
const GITHUB_MCP_SCOPES = ['repo', 'read:org'];

let consentPending = false;

function requestGithubConsent(): void {
  if (consentPending) return;
  consentPending = true;
  void vscode.window
    .showInformationMessage(
      'O BMAD Product Studio precisa de acesso à sua conta GitHub para conectar no servidor MCP do GitHub.',
      'Autorizar',
    )
    .then(async (choice) => {
      try {
        if (choice !== 'Autorizar') return;
        await vscode.authentication.getSession('github', GITHUB_MCP_SCOPES, { createIfNone: true });
      } catch {
        // usuário cancelou o diálogo do VS Code
      } finally {
        consentPending = false;
      }
    });
}

/** Header Authorization para o MCP remoto do GitHub — falha com instrução clara. */
export async function githubMcpHeaders(): Promise<Record<string, string>> {
  const session = await withTimeout(
    vscode.authentication.getSession('github', GITHUB_MCP_SCOPES, { silent: true }),
    5000,
    undefined,
  );
  if (!session) {
    requestGithubConsent();
    throw new Error(
      'Autorize o acesso à conta GitHub na notificação do VS Code (canto inferior direito) e ligue o servidor de novo.',
    );
  }
  return { Authorization: `Bearer ${session.accessToken}` };
}

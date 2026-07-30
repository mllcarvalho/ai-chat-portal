import * as path from 'node:path';
import type * as vscode from 'vscode';

/**
 * Referência ao ExtensionContext, guardada na ativação.
 *
 * As rotas recebem o contexto por injeção, mas providers de chat e o
 * lançamento do servidor MCP não são criados por rota — arrastar o contexto
 * por toda a cadeia só para duas consultas não compensa.
 */
let extensionContext: vscode.ExtensionContext | undefined;

export function setExtensionContext(context: vscode.ExtensionContext): void {
  extensionContext = context;
}

/** undefined = contexto ainda não registrado ou consentimento desconhecido. */
export function canSendRequest(model: vscode.LanguageModelChat): boolean | undefined {
  return extensionContext?.languageModelAccessInformation.canSendRequest(model);
}

/**
 * Caminho do servidor MCP do portal, empacotado no .vsix ao lado do bundle da
 * extensão. É o que as CLIs agênticas spawnam para enxergar as ferramentas do
 * portal. undefined antes da ativação.
 */
export function portalMcpServerPath(): string | undefined {
  if (!extensionContext) return undefined;
  return path.join(extensionContext.extensionPath, 'dist', 'portal-mcp-server.cjs');
}

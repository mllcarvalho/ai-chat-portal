import * as vscode from 'vscode';
import type { McpServerConfig } from '@aiportal/shared';
import { readJson } from './storage/jsonStore';
import { MCP_SERVERS_PATH } from './storage/paths';

const changeEmitter = new vscode.EventEmitter<void>();

/** Avisa o VS Code que a lista de servidores MCP do usuário mudou. */
export function notifyMcpServersChanged(): void {
  changeEmitter.fire();
}

/**
 * Permite que o usuário registre servidores MCP extras pela UI do portal;
 * o VS Code passa a gerenciá-los como qualquer outro MCP.
 */
export function registerMcpProvider(context: vscode.ExtensionContext): void {
  try {
    context.subscriptions.push(
      vscode.lm.registerMcpServerDefinitionProvider('aiChatPortal.userServers', {
        onDidChangeMcpServerDefinitions: changeEmitter.event,
        provideMcpServerDefinitions(): vscode.McpServerDefinition[] {
          const configs = readJson<McpServerConfig[]>(MCP_SERVERS_PATH) ?? [];
          return configs.map((c) =>
            c.type === 'http'
              ? new vscode.McpHttpServerDefinition(
                  c.label,
                  vscode.Uri.parse(c.url ?? ''),
                  c.headers ?? {},
                )
              : new vscode.McpStdioServerDefinition(
                  c.label,
                  c.command ?? '',
                  c.args ?? [],
                  c.env ?? {},
                ),
          );
        },
      }),
    );
  } catch (err) {
    console.warn('[ai-chat-portal] provider MCP indisponível nesta versão do VS Code:', err);
  }
}

import * as vscode from 'vscode';
import { withTimeout } from '../util';

let startedOnce = false;

/**
 * MCPs só aparecem em vscode.lm.tools com os servers iniciados; o chat do VS Code
 * inicia sozinho, a API programática não. O comando interno workbench.mcp.startServer
 * aceita '*' para iniciar todos — é interno, então tudo em try/catch + timeout.
 */
export async function refreshMcpServers(): Promise<void> {
  try {
    await withTimeout(
      vscode.commands.executeCommand('workbench.mcp.startServer', '*', {
        waitForLiveTools: true,
      }),
      20000,
      undefined,
    );
  } catch {
    try {
      await withTimeout(
        vscode.commands.executeCommand('workbench.mcp.startServer', '*'),
        10000,
        undefined,
      );
    } catch {
      // comando indisponível nesta versão — segue só com o que já está em lm.tools
    }
  }
  startedOnce = true;
}

export async function ensureMcpStarted(): Promise<void> {
  if (!startedOnce) await refreshMcpServers();
}

export function isMcpTool(tool: vscode.LanguageModelToolInformation): boolean {
  return (
    tool.name.startsWith('mcp_') ||
    tool.tags.some((tag) => tag === 'mcp' || tag.startsWith('mcp:') || tag.startsWith('mcp_'))
  );
}

export function listMcpTools(): readonly vscode.LanguageModelToolInformation[] {
  return vscode.lm.tools.filter(isMcpTool);
}

/** Label "humano" do servidor extraído do nome mcp_<server>_<tool>. */
export function mcpServerLabel(toolName: string): string | undefined {
  const match = /^mcp_([^_]+)_/.exec(toolName);
  return match?.[1];
}

export async function invokeMcpTool(
  name: string,
  input: object,
  token: vscode.CancellationToken,
): Promise<string> {
  const result = await vscode.lm.invokeTool(
    name,
    { input, toolInvocationToken: undefined },
    token,
  );
  const texts: string[] = [];
  for (const part of result.content) {
    if (part instanceof vscode.LanguageModelTextPart) texts.push(part.value);
  }
  return texts.join('\n');
}

import * as vscode from 'vscode';
import type { AgentPreset, Session, ToolInfo } from '@aiportal/shared';
import {
  BUILTIN_TOOLS,
  READONLY_BUILTIN_TOOL_NAMES,
} from './builtinTools';
import { listRunningTools } from './mcpManager';

function effectiveEnabled(session?: Session, agent?: AgentPreset): string[] | null {
  if (session?.enabledTools) return session.enabledTools;
  if (agent?.enabledTools) return agent.enabledTools;
  return null; // todas habilitadas
}

/**
 * Catálogo para a UI (toggles por sessão). Só ferramentas builtin: MCPs são
 * controlados por servidor (liga/desliga) na página de MCPs, não tool a tool.
 */
export function getToolCatalog(session?: Session, agent?: AgentPreset): ToolInfo[] {
  const enabled = effectiveEnabled(session, agent);
  const isEnabled = (name: string) => enabled === null || enabled.includes(name);
  const infos: ToolInfo[] = [];

  if (!session || session.projectId) {
    for (const tool of BUILTIN_TOOLS) {
      infos.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        source: 'builtin',
        serverLabel: 'Projeto',
        enabled: isEnabled(tool.name),
      });
    }
  }
  return infos;
}

/**
 * Ferramentas efetivamente enviadas ao modelo, conforme o modo da sessão:
 * ask = nenhuma; plan = só leitura do projeto; agent = builtins habilitadas +
 * todas as ferramentas dos servidores MCP ligados.
 */
export function getEnabledToolDefs(
  session: Session,
  agent?: AgentPreset,
): vscode.LanguageModelChatTool[] {
  if (session.mode === 'ask') return [];

  const defs: vscode.LanguageModelChatTool[] = [];
  const enabled = effectiveEnabled(session, agent);
  const isEnabled = (name: string) => enabled === null || enabled.includes(name);

  if (session.projectId) {
    for (const tool of BUILTIN_TOOLS) {
      if (session.mode === 'plan' && !READONLY_BUILTIN_TOOL_NAMES.includes(tool.name)) continue;
      if (!isEnabled(tool.name)) continue;
      defs.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
  }
  if (session.mode === 'agent') {
    for (const tool of listRunningTools()) {
      defs.push({
        name: tool.qualifiedName,
        description: `[MCP ${tool.serverName}] ${tool.description}`,
        inputSchema: (tool.inputSchema ?? undefined) as object | undefined,
      });
    }
  }
  return defs;
}

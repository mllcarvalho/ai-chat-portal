import * as vscode from 'vscode';
import type { AgentPreset, Session, ToolInfo } from '@aiportal/shared';
import {
  BMAD_TOOL_NAMES,
  BUILTIN_TOOLS,
  PROJECT_ONLY_TOOL_NAMES,
  READONLY_BUILTIN_TOOL_NAMES,
} from './builtinTools';
import { isBmadInstalled } from '../storage/paths';
import { shellAvailable } from './envCheck';
import { listRunningTools } from './mcpManager';

function effectiveEnabled(session?: Session, agent?: AgentPreset): string[] | null {
  if (session?.enabledTools) return session.enabledTools;
  if (agent?.enabledTools) return agent.enabledTools;
  return null; // todas habilitadas
}

/**
 * Disponibilidade de uma builtin no contexto dado. As de arquivo/comando valem
 * em qualquer conversa (projeto ou workspace da sessão); BMAD exige instalação;
 * run_command exige shell na máquina; as PROJECT_ONLY exigem projeto.
 */
function builtinAvailable(name: string, session?: Session): boolean {
  if (BMAD_TOOL_NAMES.includes(name)) return isBmadInstalled();
  if (name === 'portal_run_command') return shellAvailable();
  if (PROJECT_ONLY_TOOL_NAMES.includes(name)) return !session || !!session.projectId;
  return true;
}

function builtinLabel(name: string): string {
  if (BMAD_TOOL_NAMES.includes(name)) return 'BMAD';
  if (PROJECT_ONLY_TOOL_NAMES.includes(name)) return 'Projeto';
  if (name.endsWith('_file') || name.endsWith('_files') || name === 'portal_run_command') {
    return 'Workspace';
  }
  return 'Portal';
}

/**
 * Catálogo para a UI (toggles por sessão). Só ferramentas builtin: MCPs são
 * controlados por servidor (liga/desliga) na página de MCPs, não tool a tool.
 */
export function getToolCatalog(session?: Session, agent?: AgentPreset): ToolInfo[] {
  const enabled = effectiveEnabled(session, agent);
  const isEnabled = (name: string) => enabled === null || enabled.includes(name);
  const infos: ToolInfo[] = [];

  for (const tool of BUILTIN_TOOLS) {
    if (!builtinAvailable(tool.name, session)) continue;
    infos.push({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      source: 'builtin',
      serverLabel: builtinLabel(tool.name),
      enabled: isEnabled(tool.name),
    });
  }
  return infos;
}

/**
 * Ferramentas efetivamente enviadas ao modelo, conforme o modo da sessão:
 * ask = nenhuma; plan = só leitura; agent = builtins habilitadas +
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

  for (const tool of BUILTIN_TOOLS) {
    if (!builtinAvailable(tool.name, session)) continue;
    if (session.mode === 'plan' && !READONLY_BUILTIN_TOOL_NAMES.includes(tool.name)) continue;
    if (!isEnabled(tool.name)) continue;
    defs.push({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
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

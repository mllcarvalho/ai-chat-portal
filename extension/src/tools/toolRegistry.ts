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

/** Teto da API do Copilot: requests com mais de 128 tools são rejeitadas. */
const MAX_MODEL_TOOLS = 128;

/**
 * Ferramentas efetivamente enviadas ao modelo, conforme o modo da sessão:
 * ask = nenhuma; plan = só leitura; agent = builtins habilitadas + as
 * ferramentas dos servidores MCP ligados, até o teto de 128 da API.
 * MCPs entram por servidor inteiro (na ordem em que estão ligados): servidor
 * que não couber fica de fora e é reportado em droppedServers — meio servidor
 * se comporta pior que servidor desligado.
 */
export function getEnabledToolDefs(
  session: Session,
  agent?: AgentPreset,
): { defs: vscode.LanguageModelChatTool[]; droppedServers: string[] } {
  if (session.mode === 'ask') return { defs: [], droppedServers: [] };

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

  const droppedServers: string[] = [];
  if (session.mode === 'agent') {
    const byServer = new Map<string, ReturnType<typeof listRunningTools>>();
    for (const tool of listRunningTools()) {
      byServer.set(tool.serverName, [...(byServer.get(tool.serverName) ?? []), tool]);
    }
    for (const [server, tools] of byServer) {
      if (defs.length + tools.length > MAX_MODEL_TOOLS) {
        droppedServers.push(server);
        continue;
      }
      for (const tool of tools) {
        defs.push({
          name: tool.qualifiedName,
          description: `[MCP ${tool.serverName}] ${tool.description}`,
          inputSchema: (tool.inputSchema ?? undefined) as object | undefined,
        });
      }
    }
  }
  return { defs, droppedServers };
}

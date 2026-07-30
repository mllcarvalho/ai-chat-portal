import * as fs from 'node:fs';
import { readRuntime } from '../../authToken';
import { getConfig } from '../../storage/configStore';
import { portalMcpServerPath } from '../../extensionContext';

/**
 * Configuração do servidor MCP do portal para uma conversa.
 *
 * É o que faz o BMAD funcionar fora do Copilot: as CLIs agênticas sobem este
 * processo e passam a enxergar `bmad_read_file`, `portal_write_file`,
 * `portal_run_command` etc. com os mesmos nomes que o adaptador das personas
 * usa — sem precisar reescrever os assets do BMAD por motor.
 */

export interface PortalMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * undefined quando não dá para montar (extensão não ativada, servidor ainda
 * sem porta, ou bundle ausente num build parcial). O chamador segue sem as
 * ferramentas do portal em vez de derrubar a conversa.
 */
export function portalMcpServer(sessionId: string, scope?: 'subagent'): PortalMcpServer | undefined {
  const serverPath = portalMcpServerPath();
  if (!serverPath || !fs.existsSync(serverPath)) return undefined;
  const runtime = readRuntime();
  if (!runtime?.port) return undefined;
  const token = getConfig().token;
  if (!token) return undefined;
  return {
    // o mesmo node que roda a extensão: evita depender do PATH do usuário
    command: process.execPath,
    args: [serverPath],
    env: {
      PORTAL_URL: `http://127.0.0.1:${runtime.port}`,
      PORTAL_TOKEN: token,
      PORTAL_SESSION_ID: sessionId,
      ...(scope ? { PORTAL_TOOL_SCOPE: scope } : {}),
    },
  };
}

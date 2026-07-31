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
      /**
       * OBRIGATÓRIO — e não é detalhe: `process.execPath` aqui é o binário do
       * Electron do VS Code, que só executa um .js quando esta variável está
       * setada. Sem ela o processo abre o editor (ou não faz nada) e MORRE em
       * silêncio, sem falar JSON-RPC: o cliente conclui que o servidor não
       * existe e o agente fica com a lista de MCP VAZIA.
       *
       * O host da extensão já roda com ela, então quem herda o ambiente do
       * portal (Claude Code, que faz merge com o process.env dele) funcionava
       * por acidente. O Devin recebe o `env` do ACP como ambiente COMPLETO do
       * filho — nada é herdado —, então a variável precisa vir declarada.
       */
      ELECTRON_RUN_AS_NODE: '1',
      // idem: num ambiente substituído, o filho ficaria sem PATH/HOME
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      PORTAL_URL: `http://127.0.0.1:${runtime.port}`,
      PORTAL_TOKEN: token,
      PORTAL_SESSION_ID: sessionId,
      ...(scope ? { PORTAL_TOOL_SCOPE: scope } : {}),
    },
  };
}

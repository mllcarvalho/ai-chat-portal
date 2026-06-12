import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServerEntry } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import { getToolCatalog } from '../../tools/toolRegistry';
import {
  addServer,
  listServers,
  removeServer,
  setServerEnabled,
  startServer,
} from '../../tools/mcpManager';
import { getSession } from '../../storage/sessionStore';
import { getAgent } from '../../storage/agentStore';
import { getPortalRoot } from '../../storage/paths';

function proxyTemplate(name: string): string {
  return `/**
 * Servidor MCP "${name}" — proxy local do AI Product BMAD Chat.
 * Executado via: npx -y tsx mcps/${name}.ts (stdio)
 * Adicione suas ferramentas com server.registerTool(...).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: '${name}', version: '1.0.0' });

server.registerTool(
  'hello',
  {
    title: 'Hello',
    description: 'Ferramenta de exemplo — substitua pelas suas.',
    inputSchema: { name: z.string().describe('Quem cumprimentar') },
  },
  async ({ name }) => ({
    content: [{ type: 'text', text: \`Olá, \${name}! O servidor "${name}" está funcionando.\` }],
  }),
);

await server.connect(new StdioServerTransport());
`;
}

/** Cria mcps/<name>.ts a partir do template e devolve a entry para o mcp.json. */
function scaffoldProxy(name: string): McpServerEntry {
  const root = getPortalRoot();
  if (!root) throw new Error('Abra o repositório do portal no VS Code para criar proxies');
  const safe = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!safe) throw new Error('Nome inválido para o proxy');
  const dir = path.join(root, 'mcps');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safe}.ts`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, proxyTemplate(safe), 'utf8');
  return { type: 'stdio', command: 'npx', args: ['-y', 'tsx', `mcps/${safe}.ts`] };
}

export function registerToolRoutes(router: Router): void {
  router.get('/api/tools', ({ res, query }) => {
    const sessionId = query.get('sessionId');
    const session = sessionId ? getSession(sessionId) : undefined;
    const agent = session?.agentId ? getAgent(session.agentId) : undefined;
    sendJson(res, 200, getToolCatalog(session, agent));
  });

  router.get('/api/mcp/servers', ({ res }) => {
    sendJson(res, 200, listServers());
  });

  router.post('/api/mcp/servers', async ({ res, body }) => {
    const input = (body ?? {}) as {
      name?: string;
      type?: 'stdio' | 'http';
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
      createProxy?: boolean;
    };
    const name = input.name?.trim();
    if (!name) {
      sendError(res, 400, 'Informe o nome do servidor');
      return;
    }
    try {
      let entry: McpServerEntry;
      if (input.createProxy) {
        entry = scaffoldProxy(name);
      } else if (input.type === 'http') {
        if (!input.url?.trim()) throw new Error('Servidores http precisam de url');
        entry = { type: 'http', url: input.url.trim(), headers: input.headers ?? undefined };
      } else {
        if (!input.command?.trim()) throw new Error('Servidores stdio precisam de command');
        entry = {
          type: 'stdio',
          command: input.command.trim(),
          args: input.args?.length ? input.args : undefined,
          env: input.env && Object.keys(input.env).length ? input.env : undefined,
        };
      }
      addServer(name, entry);
      const info = await setServerEnabled(name, true);
      sendJson(res, 201, info);
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  router.post('/api/mcp/servers/:name/toggle', async ({ res, params, body }) => {
    const enabled = ((body ?? {}) as { enabled?: boolean }).enabled === true;
    try {
      sendJson(res, 200, await setServerEnabled(params.name, enabled));
    } catch (err) {
      sendError(res, 404, err instanceof Error ? err.message : String(err));
    }
  });

  router.post('/api/mcp/servers/:name/restart', async ({ res, params }) => {
    try {
      const name = params.name;
      sendJson(res, 200, await startServer(name));
    } catch (err) {
      sendError(res, 404, err instanceof Error ? err.message : String(err));
    }
  });

  router.delete('/api/mcp/servers/:name', async ({ res, params }) => {
    try {
      await removeServer(params.name);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendError(res, 404, err instanceof Error ? err.message : String(err));
    }
  });
}

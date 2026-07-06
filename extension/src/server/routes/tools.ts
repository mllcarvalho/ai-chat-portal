import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServerEntry } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import { getToolCatalog } from '../../tools/toolRegistry';
import {
  addServer,
  listServers,
  listServerTools,
  removeServer,
  saveProxyServer,
  setServerEnabled,
  startServer,
  testProxyConnection,
  upsertServer,
} from '../../tools/mcpManager';
import { GITHUB_MCP_SERVER_NAME, GITHUB_MCP_URL } from '../../tools/githubMcp';
import type { McpProxyConfig } from '@aiportal/shared';
import {
  cancelConsumerLabSetup,
  chooseConsumerLabAccount,
  chooseConsumerLabRole,
  getConsumerLabStatus,
  startConsumerLabSetup,
  switchConsumerLabSso,
} from '../../tools/consumerLabSetup';
import {
  autoDetectIuclick,
  cancelIuclickSetup,
  getIuclickStatus,
  reauthIuclick,
  startIuclickSetup,
} from '../../tools/iuclickSetup';
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

  // setup guiado do ConsumerLab (Itaú): dispara em background e a UI faz polling;
  // as fases awaiting-* pausam esperando o POST /choose com conta ou role
  router.get('/api/mcp/consumerlab', ({ res }) => {
    sendJson(res, 200, getConsumerLabStatus());
  });

  router.post('/api/mcp/consumerlab/setup', ({ res }) => {
    sendJson(res, 200, startConsumerLabSetup());
  });

  router.post('/api/mcp/consumerlab/choose', ({ res, body }) => {
    const input = (body ?? {}) as { accountId?: string; roleName?: string };
    try {
      if (input.accountId?.trim()) {
        sendJson(res, 200, chooseConsumerLabAccount(input.accountId.trim()));
      } else if (input.roleName?.trim()) {
        sendJson(res, 200, chooseConsumerLabRole(input.roleName.trim()));
      } else {
        sendError(res, 400, 'Informe accountId ou roleName');
      }
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  router.post('/api/mcp/consumerlab/switch-sso', ({ res }) => {
    try {
      sendJson(res, 200, switchConsumerLabSso());
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  router.post('/api/mcp/consumerlab/cancel', ({ res }) => {
    sendJson(res, 200, cancelConsumerLabSetup());
  });

  // setup guiado do IUClick (ServiceNow Itaú): registry + npx, sem escolhas no
  // meio — a UI só faz polling; Cookie/X-UserToken opcionais vão pro SecretStorage
  router.get('/api/mcp/iuclick', async ({ res }) => {
    sendJson(res, 200, await getIuclickStatus());
  });

  router.post('/api/mcp/iuclick/setup', async ({ res, body }) => {
    const input = (body ?? {}) as { cookies?: string; token?: string };
    try {
      sendJson(res, 200, await startIuclickSetup(input.cookies, input.token));
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  router.post('/api/mcp/iuclick/cancel', async ({ res }) => {
    sendJson(res, 200, await cancelIuclickSetup());
  });

  // detecção automática: lê os cookies do navegador e busca o X-UserToken,
  // sem o usuário mexer no DevTools (macOS/Windows; cai no plano B se falhar)
  router.post('/api/mcp/iuclick/autodetect', async ({ res }) => {
    try {
      sendJson(res, 200, { ok: true, ...(await autoDetectIuclick()) });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  // reautenticação sem refazer o setup: salva Cookie/X-UserToken e religa o
  // servidor (a sessão do ServiceNow expira; o resto do setup continua válido)
  router.post('/api/mcp/iuclick/credentials', async ({ res, body }) => {
    const input = (body ?? {}) as { cookies?: string; token?: string };
    try {
      sendJson(res, 200, { ok: true, ...(await reauthIuclick(input.cookies ?? '', input.token ?? '')) });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  // MCP oficial do GitHub (o mesmo do Copilot no VS Code): registro em um
  // clique — o Bearer da sessão GitHub entra na conexão, nunca no mcp.json.
  // Se a conta ainda não autorizou, o info volta com status error e a
  // instrução de autorizar pela notificação do VS Code.
  router.post('/api/mcp/github/setup', async ({ res }) => {
    try {
      upsertServer(GITHUB_MCP_SERVER_NAME, { type: 'http', url: GITHUB_MCP_URL });
      sendJson(res, 201, await setServerEnabled(GITHUB_MCP_SERVER_NAME, true));
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  // proxy OAuth2: o secret chega aqui (127.0.0.1) e nunca volta ao front
  const readProxyInput = (body: unknown): { config: McpProxyConfig; secret?: string } => {
    const input = (body ?? {}) as Partial<McpProxyConfig> & { clientSecret?: string };
    const config: McpProxyConfig = {
      name: (input.name ?? '').trim(),
      tokenUrl: (input.tokenUrl ?? '').trim(),
      gatewayUrl: (input.gatewayUrl ?? '').trim(),
      clientId: (input.clientId ?? '').trim(),
      scope: input.scope?.trim() || undefined,
    };
    return { config, secret: input.clientSecret };
  };

  router.post('/api/mcp/proxies', async ({ res, body }) => {
    const { config, secret } = readProxyInput(body);
    try {
      sendJson(res, 201, await saveProxyServer(config, secret));
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  router.post('/api/mcp/proxies/test', async ({ res, body }) => {
    const { config, secret } = readProxyInput(body);
    try {
      const tools = await testProxyConnection(config, secret);
      sendJson(res, 200, { ok: true, tools });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  router.get('/api/mcp/servers/:name/tools', ({ res, params }) => {
    try {
      sendJson(res, 200, listServerTools(params.name));
    } catch (err) {
      sendError(res, 404, err instanceof Error ? err.message : String(err));
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

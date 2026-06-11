import * as crypto from 'node:crypto';
import type { McpServerConfig } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import { ensureMcpStarted, refreshMcpServers } from '../../tools/mcp';
import { getToolCatalog } from '../../tools/toolRegistry';
import { getSession } from '../../storage/sessionStore';
import { getAgent } from '../../storage/agentStore';
import { readJson, writeJsonAtomic } from '../../storage/jsonStore';
import { MCP_SERVERS_PATH } from '../../storage/paths';
import { notifyMcpServersChanged } from '../../mcpProvider';

function readServers(): McpServerConfig[] {
  return readJson<McpServerConfig[]>(MCP_SERVERS_PATH) ?? [];
}

export function registerToolRoutes(router: Router): void {
  router.get('/api/tools', async ({ res, query }) => {
    await ensureMcpStarted();
    const sessionId = query.get('sessionId');
    const session = sessionId ? getSession(sessionId) : undefined;
    const agent = session?.agentId ? getAgent(session.agentId) : undefined;
    sendJson(res, 200, getToolCatalog(session, agent));
  });

  router.post('/api/tools/refresh', async ({ res }) => {
    await refreshMcpServers();
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/mcp/servers', ({ res }) => {
    sendJson(res, 200, readServers());
  });

  router.post('/api/mcp/servers', async ({ res, body }) => {
    const input = (body ?? {}) as Partial<McpServerConfig>;
    if (!input.label?.trim() || (input.type !== 'stdio' && input.type !== 'http')) {
      sendError(res, 400, 'label e type (stdio ou http) são obrigatórios');
      return;
    }
    if (input.type === 'stdio' && !input.command?.trim()) {
      sendError(res, 400, 'Servidores stdio precisam de command');
      return;
    }
    if (input.type === 'http' && !input.url?.trim()) {
      sendError(res, 400, 'Servidores http precisam de url');
      return;
    }
    const server: McpServerConfig = {
      id: crypto.randomUUID(),
      label: input.label.trim(),
      type: input.type,
      command: input.command?.trim(),
      args: input.args ?? [],
      env: input.env ?? {},
      url: input.url?.trim(),
      headers: input.headers ?? {},
    };
    writeJsonAtomic(MCP_SERVERS_PATH, [...readServers(), server]);
    notifyMcpServersChanged();
    await refreshMcpServers();
    sendJson(res, 201, server);
  });

  router.delete('/api/mcp/servers/:id', ({ res, params }) => {
    const servers = readServers();
    const next = servers.filter((s) => s.id !== params.id);
    if (next.length === servers.length) {
      sendError(res, 404, 'Servidor MCP não encontrado');
      return;
    }
    writeJsonAtomic(MCP_SERVERS_PATH, next);
    notifyMcpServersChanged();
    sendJson(res, 200, { ok: true });
  });
}

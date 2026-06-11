import type { AgentPreset } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import { createAgent, deleteAgent, listAgents, updateAgent } from '../../storage/agentStore';
import { listVsCodeAgents } from '../../storage/vscodeAgents';

export function registerAgentRoutes(router: Router): void {
  router.get('/api/agents', ({ res }) => {
    sendJson(res, 200, listAgents());
  });

  router.get('/api/vscode-agents', ({ res }) => {
    sendJson(res, 200, listVsCodeAgents());
  });

  router.post('/api/agents', ({ res, body }) => {
    const input = (body ?? {}) as Partial<AgentPreset>;
    if (!input.name?.trim()) {
      sendError(res, 400, 'Nome do agente é obrigatório');
      return;
    }
    const agent = createAgent({
      name: input.name.trim(),
      description: input.description,
      icon: input.icon,
      instructions: input.instructions ?? '',
      defaultModelId: input.defaultModelId,
      defaultMode: input.defaultMode,
      enabledTools: input.enabledTools ?? null,
    });
    sendJson(res, 201, agent);
  });

  router.patch('/api/agents/:id', ({ res, params, body }) => {
    const updated = updateAgent(params.id, (body ?? {}) as Partial<AgentPreset>);
    if (!updated) {
      sendError(res, 404, 'Agente não encontrado');
      return;
    }
    sendJson(res, 200, updated);
  });

  router.delete('/api/agents/:id', ({ res, params }) => {
    const ok = deleteAgent(params.id);
    sendJson(res, ok ? 200 : 404, { ok });
  });
}

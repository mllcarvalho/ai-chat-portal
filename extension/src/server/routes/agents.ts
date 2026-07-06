import { isBmadAsset, slugifyCommand, type AgentPreset } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import { createAgent, deleteAgent, getAgent, listAgents, updateAgent } from '../../storage/agentStore';
import { exportAgentZip, importAgentZip } from '../../storage/agentZip';
import { registerBmadAssets } from '../../storage/bmadStore';
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
      skillIds: input.skillIds,
      knowledgeBaseIds: input.knowledgeBaseIds,
      importedFrom: input.importedFrom,
    });
    sendJson(res, 201, agent);
  });

  router.get('/api/agents/:id/export', async ({ res, params }) => {
    const agent = getAgent(params.id);
    if (!agent) {
      sendError(res, 404, 'Agente não encontrado');
      return;
    }
    const buffer = await exportAgentZip(params.id);
    const name = `${slugifyCommand(agent.name) || 'agente'}.agent.zip`;
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': buffer.length,
      'Content-Disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    res.end(buffer);
  });

  router.post('/api/agents/import', async ({ res, body }) => {
    const input = (body ?? {}) as { zipBase64?: string };
    if (!input.zipBase64) {
      sendError(res, 400, 'Informe o conteúdo do zip (zipBase64)');
      return;
    }
    try {
      sendJson(res, 201, await importAgentZip(Buffer.from(input.zipBase64, 'base64')));
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  router.patch('/api/agents/:id', ({ res, params, body }) => {
    const patch = (body ?? {}) as Partial<AgentPreset>;
    const updated = updateAgent(params.id, patch);
    if (!updated) {
      sendError(res, 404, 'Agente não encontrado');
      return;
    }
    // habilitar/desabilitar persona BMAD muda o roster embutido no conteúdo da
    // skill bmad-party-mode — re-registra para a próxima ativação já refletir
    if (isBmadAsset(params.id) && patch.enabled !== undefined) {
      try {
        registerBmadAssets();
      } catch {
        // melhor-esforço; o registro da inicialização corrige depois
      }
    }
    sendJson(res, 200, updated);
  });

  router.delete('/api/agents/:id', ({ res, params }) => {
    const ok = deleteAgent(params.id);
    sendJson(res, ok ? 200 : 404, { ok });
  });
}

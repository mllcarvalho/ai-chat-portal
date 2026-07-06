import { Router, sendError, sendJson } from '../router';
import {
  createSkill,
  deleteSkill,
  deleteSkillAsset,
  getSkill,
  listAllSkills,
  listSkills,
  updateSkill,
  writeSkillAsset,
} from '../../storage/skillStore';

export function registerSkillRoutes(router: Router): void {
  // Sem projectId devolve o catálogo completo (globais + todos os projetos);
  // com projectId, apenas globais + as daquele projeto.
  router.get('/api/skills', ({ res, query }) => {
    const projectId = query.get('projectId') || undefined;
    sendJson(res, 200, projectId ? listSkills(projectId) : listAllSkills());
  });

  router.get('/api/skills/:id', ({ res, params }) => {
    const skill = getSkill(params.id);
    if (!skill) {
      sendError(res, 404, 'Skill não encontrada');
      return;
    }
    sendJson(res, 200, skill);
  });

  router.post('/api/skills', ({ res, body }) => {
    const input = (body ?? {}) as {
      scope?: 'global' | 'project';
      projectId?: string;
      name?: string;
      description?: string;
      command?: string;
      content?: string;
    };
    if (!input.name?.trim() || !input.scope) {
      sendError(res, 400, 'name e scope são obrigatórios');
      return;
    }
    if (input.scope === 'project' && !input.projectId) {
      sendError(res, 400, 'Skills de projeto precisam de projectId');
      return;
    }
    const skill = createSkill({
      scope: input.scope,
      projectId: input.projectId,
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      command: input.command?.trim().replace(/^\//, '') || undefined,
      content: input.content ?? '',
    });
    if (!skill) {
      sendError(res, 404, 'Projeto não encontrado');
      return;
    }
    sendJson(res, 201, skill);
  });

  router.patch('/api/skills/:id', ({ res, params, body }) => {
    const patch = (body ?? {}) as {
      name?: string;
      description?: string;
      command?: string;
      content?: string;
    };
    if (patch.command) patch.command = patch.command.trim().replace(/^\//, '');
    const updated = updateSkill(params.id, patch);
    if (!updated) {
      sendError(res, 404, 'Skill não encontrada');
      return;
    }
    sendJson(res, 200, updated);
  });

  router.delete('/api/skills/:id', ({ res, params }) => {
    const ok = deleteSkill(params.id);
    sendJson(res, ok ? 200 : 404, { ok });
  });

  // --- anexos da pasta da skill (referências, templates…) --------------------

  router.post('/api/skills/:id/files', ({ res, params, body }) => {
    const input = (body ?? {}) as { path?: string; contentBase64?: string };
    if (!input.path?.trim() || typeof input.contentBase64 !== 'string') {
      sendError(res, 400, 'path e contentBase64 são obrigatórios');
      return;
    }
    const ok = writeSkillAsset(params.id, input.path.trim(), Buffer.from(input.contentBase64, 'base64'));
    if (!ok) {
      sendError(res, 400, 'Skill não encontrada ou caminho inválido');
      return;
    }
    sendJson(res, 200, getSkill(params.id));
  });

  router.post('/api/skills/:id/files/delete', ({ res, params, body }) => {
    const input = (body ?? {}) as { path?: string };
    if (!input.path?.trim()) {
      sendError(res, 400, 'path é obrigatório');
      return;
    }
    const ok = deleteSkillAsset(params.id, input.path.trim());
    if (!ok) {
      sendError(res, 404, 'Anexo não encontrado');
      return;
    }
    sendJson(res, 200, getSkill(params.id));
  });
}

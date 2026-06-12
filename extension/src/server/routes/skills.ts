import { Router, sendError, sendJson } from '../router';
import {
  createSkill,
  deleteSkill,
  getSkill,
  listAllSkills,
  listSkills,
  updateSkill,
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
}

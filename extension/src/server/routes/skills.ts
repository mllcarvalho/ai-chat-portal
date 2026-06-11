import { Router, sendError, sendJson } from '../router';
import {
  createSkill,
  deleteSkill,
  getSkill,
  listSkills,
  updateSkill,
} from '../../storage/skillStore';

export function registerSkillRoutes(router: Router): void {
  router.get('/api/skills', ({ res, query }) => {
    sendJson(res, 200, listSkills(query.get('projectId') || undefined));
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
      kind?: 'instruction' | 'command';
      scope?: 'global' | 'project';
      projectId?: string;
      name?: string;
      description?: string;
      command?: string;
      content?: string;
    };
    if (!input.name?.trim() || !input.kind || !input.scope) {
      sendError(res, 400, 'name, kind e scope são obrigatórios');
      return;
    }
    if (input.kind === 'command' && !input.command?.trim()) {
      sendError(res, 400, 'Comandos slash precisam do campo command (nome sem a barra)');
      return;
    }
    if (input.scope === 'project' && !input.projectId) {
      sendError(res, 400, 'Skills de projeto precisam de projectId');
      return;
    }
    const skill = createSkill({
      kind: input.kind,
      scope: input.scope,
      projectId: input.projectId,
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      command: input.command?.trim().replace(/^\//, ''),
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

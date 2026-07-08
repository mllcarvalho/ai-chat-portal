import type { Project } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import {
  createProject,
  getProject,
  listProjects,
  patchProject,
  projectDir,
  unregisterProject,
} from '../../storage/projectStore';
import { registerFileRoutes } from './files';

export function registerProjectRoutes(router: Router): void {
  router.get('/api/projects', ({ res }) => {
    sendJson(res, 200, listProjects());
  });

  router.post('/api/projects', ({ res, body }) => {
    const { name } = (body ?? {}) as { name?: string };
    if (!name?.trim()) {
      sendError(res, 400, 'Nome do projeto é obrigatório');
      return;
    }
    sendJson(res, 201, createProject(name.trim()));
  });

  router.patch('/api/projects/:id', ({ res, params, body }) => {
    const patch = (body ?? {}) as Partial<
      Pick<Project, 'name' | 'instructions' | 'defaultAgentId'>
    >;
    const updated = patchProject(params.id, patch);
    if (!updated) {
      sendError(res, 404, 'Projeto não encontrado');
      return;
    }
    sendJson(res, 200, updated);
  });

  router.delete('/api/projects/:id', ({ res, params }) => {
    const { ok, trashed } = unregisterProject(params.id);
    sendJson(res, ok ? 200 : 404, {
      ok,
      note: trashed
        ? 'A pasta do projeto foi movida para a lixeira interna (.trash)'
        : 'A pasta do projeto permanece no disco',
    });
  });

  registerFileRoutes(
    router,
    '/api/projects/:id/files',
    (id) => {
      const project = getProject(id);
      return project ? projectDir(project) : undefined;
    },
    'Projeto não encontrado',
  );
}

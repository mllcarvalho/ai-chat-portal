import { Router, sendError, sendJson } from '../router';
import {
  createBase,
  deleteBase,
  deleteDoc,
  getBase,
  listBases,
  listDocs,
  patchBase,
  readDoc,
  writeDoc,
} from '../../storage/knowledgeStore';

export function registerKnowledgeRoutes(router: Router): void {
  router.get('/api/knowledge', ({ res, query }) => {
    sendJson(res, 200, listBases(query.get('projectId') ?? undefined));
  });

  router.post('/api/knowledge', ({ res, body }) => {
    const input = (body ?? {}) as {
      name?: string;
      description?: string;
      scope?: 'global' | 'project';
      projectId?: string;
    };
    if (!input.name?.trim()) {
      sendError(res, 400, 'Informe o nome da base');
      return;
    }
    if (input.scope === 'project' && !input.projectId) {
      sendError(res, 400, 'Bases de projeto precisam de projectId');
      return;
    }
    const base = createBase({
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      scope: input.scope === 'project' ? 'project' : 'global',
      projectId: input.projectId,
    });
    if (!base) {
      sendError(res, 404, 'Projeto não encontrado');
      return;
    }
    sendJson(res, 201, base);
  });

  router.patch('/api/knowledge/:id', ({ res, params, body }) => {
    const patch = (body ?? {}) as { name?: string; description?: string; enabled?: boolean };
    const base = patchBase(params.id, patch);
    if (!base) {
      sendError(res, 404, 'Base não encontrada');
      return;
    }
    sendJson(res, 200, base);
  });

  router.delete('/api/knowledge/:id', ({ res, params }) => {
    if (!deleteBase(params.id)) {
      sendError(res, 404, 'Base não encontrada');
      return;
    }
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/knowledge/:id/docs', ({ res, params }) => {
    if (!getBase(params.id)) {
      sendError(res, 404, 'Base não encontrada');
      return;
    }
    sendJson(res, 200, listDocs(params.id));
  });

  router.get('/api/knowledge/:id/docs/content', ({ res, params, query }) => {
    const name = query.get('name');
    if (!name) {
      sendError(res, 400, 'Informe o nome do documento');
      return;
    }
    const content = readDoc(params.id, name);
    if (content === undefined) {
      sendError(res, 404, 'Documento não encontrado');
      return;
    }
    sendJson(res, 200, { name, content });
  });

  router.put('/api/knowledge/:id/docs', ({ res, params, body }) => {
    const input = (body ?? {}) as { name?: string; content?: string };
    if (!input.name?.trim()) {
      sendError(res, 400, 'Informe o nome do documento (.md ou .txt)');
      return;
    }
    try {
      sendJson(res, 200, writeDoc(params.id, input.name.trim(), input.content ?? ''));
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  router.delete('/api/knowledge/:id/docs/:name', ({ res, params }) => {
    if (!deleteDoc(params.id, params.name)) {
      sendError(res, 404, 'Documento não encontrado');
      return;
    }
    sendJson(res, 200, { ok: true });
  });
}

import { slugifyCommand } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import { exportBaseZip, importBaseZip } from '../../storage/knowledgeZip';
import {
  addRemoteDoc,
  createBase,
  deleteBase,
  deleteDoc,
  getBase,
  listBases,
  listDocs,
  moveDoc,
  patchBase,
  readDoc,
  syncRemoteDocs,
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

  router.get('/api/knowledge/:id/export', async ({ res, params }) => {
    const base = getBase(params.id);
    if (!base) {
      sendError(res, 404, 'Base não encontrada');
      return;
    }
    const buffer = await exportBaseZip(params.id);
    const name = `${slugifyCommand(base.name) || 'base'}.zip`;
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': buffer.length,
      'Content-Disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    res.end(buffer);
  });

  router.post('/api/knowledge/import', async ({ res, body }) => {
    const input = (body ?? {}) as {
      zipBase64?: string;
      name?: string;
      scope?: 'global' | 'project';
      projectId?: string;
    };
    if (!input.zipBase64) {
      sendError(res, 400, 'Informe o conteúdo do zip (zipBase64)');
      return;
    }
    if (input.scope === 'project' && !input.projectId) {
      sendError(res, 400, 'Bases de projeto precisam de projectId');
      return;
    }
    try {
      const base = await importBaseZip(Buffer.from(input.zipBase64, 'base64'), {
        scope: input.scope === 'project' ? 'project' : 'global',
        projectId: input.projectId,
        fallbackName: input.name,
      });
      sendJson(res, 201, base);
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  router.post('/api/knowledge/:id/docs/remote', async ({ res, params, body }) => {
    const input = (body ?? {}) as { url?: string; name?: string };
    if (!input.url?.trim()) {
      sendError(res, 400, 'Informe a URL do documento');
      return;
    }
    if (!getBase(params.id)) {
      sendError(res, 404, 'Base não encontrada');
      return;
    }
    try {
      sendJson(res, 201, await addRemoteDoc(params.id, input.url.trim(), input.name));
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  router.post('/api/knowledge/:id/sync', async ({ res, params, body }) => {
    const input = (body ?? {}) as { name?: string };
    if (!getBase(params.id)) {
      sendError(res, 404, 'Base não encontrada');
      return;
    }
    sendJson(res, 200, await syncRemoteDocs(params.id, input.name));
  });

  router.post('/api/knowledge/:id/docs/move', ({ res, params, body }) => {
    const input = (body ?? {}) as { name?: string; toBaseId?: string };
    if (!input.name?.trim() || !input.toBaseId?.trim()) {
      sendError(res, 400, 'Informe o documento (name) e a base de destino (toBaseId)');
      return;
    }
    if (!getBase(params.id) || !getBase(input.toBaseId)) {
      sendError(res, 404, 'Base não encontrada');
      return;
    }
    try {
      sendJson(res, 200, moveDoc(params.id, input.name.trim(), input.toBaseId.trim()));
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

import { slugifyCommand } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import { requireLibrary } from '../../storage/sharedLibrary';
import { exportBaseZip, importBaseZip } from '../../storage/knowledgeZip';
import {
  addRemoteDoc,
  addSiteCollection,
  deleteCollection,
  syncCollection,
  createBase,
  deleteBase,
  deleteDoc,
  getBase,
  listBases,
  listDocs,
  moveBaseToScope,
  moveDoc,
  patchBase,
  readDoc,
  readDocRaw,
  syncRemoteDocs,
  writeBinaryDoc,
  writeDoc,
  ensureDocText,
  isBinaryDoc,
} from '../../storage/knowledgeStore';

export function registerKnowledgeRoutes(router: Router): void {
  router.get('/api/knowledge', ({ res, query }) => {
    sendJson(res, 200, listBases(query.get('projectId') ?? undefined));
  });

  router.post('/api/knowledge', ({ res, body }) => {
    const input = (body ?? {}) as {
      name?: string;
      description?: string;
      scope?: 'global' | 'project' | 'shared';
      projectId?: string;
      libraryId?: string;
    };
    if (!input.name?.trim()) {
      sendError(res, 400, 'Informe o nome da base');
      return;
    }
    if (input.scope === 'project' && !input.projectId) {
      sendError(res, 400, 'Bases de projeto precisam de projectId');
      return;
    }
    if (input.scope === 'shared') {
      try {
        requireLibrary(input.libraryId ?? '');
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err));
        return;
      }
    }
    const base = createBase({
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      scope:
        input.scope === 'project' ? 'project' : input.scope === 'shared' ? 'shared' : 'global',
      projectId: input.projectId,
      libraryId: input.libraryId,
    });
    if (!base) {
      sendError(res, 404, 'Projeto não encontrado');
      return;
    }
    sendJson(res, 201, base);
  });

  router.patch('/api/knowledge/:id', ({ res, params, body }) => {
    const patch = (body ?? {}) as {
      name?: string;
      description?: string;
      enabled?: boolean;
      scope?: 'global' | 'project' | 'shared';
      projectId?: string;
      libraryId?: string;
    };
    // troca de escopo move a pasta inteira (ex.: levar a base para a biblioteca
    // da equipe junto com o agente que a usa)
    if (patch.scope) {
      try {
        if (patch.scope === 'shared') requireLibrary(patch.libraryId ?? '');
        const moved = moveBaseToScope(params.id, {
          scope: patch.scope,
          projectId: patch.projectId,
          libraryId: patch.libraryId,
        });
        if (!moved) {
          sendError(res, 404, 'Base ou destino não encontrado');
          return;
        }
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err));
        return;
      }
    }
    const { scope: _scope, projectId: _projectId, libraryId: _libraryId, ...rest } = patch;
    const base = Object.keys(rest).length ? patchBase(params.id, rest) : getBase(params.id);
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

  router.get('/api/knowledge/:id/docs/content', async ({ res, params, query }) => {
    const name = query.get('name');
    if (!name) {
      sendError(res, 400, 'Informe o nome do documento');
      return;
    }
    // binário: devolve a conversão em texto (gerando-a se ainda não existir)
    const content = isBinaryDoc(name)
      ? await ensureDocText(params.id, name).catch(() => undefined)
      : readDoc(params.id, name);
    if (content === undefined) {
      sendError(res, 404, 'Documento não encontrado');
      return;
    }
    sendJson(res, 200, { name, content, binary: isBinaryDoc(name) });
  });

  // arquivo original de um documento binário — o que a UI baixa/abre
  router.get('/api/knowledge/:id/docs/raw', ({ res, params, query }) => {
    const name = query.get('name');
    if (!name) {
      sendError(res, 400, 'Informe o nome do documento');
      return;
    }
    const data = readDocRaw(params.id, name);
    if (!data) {
      sendError(res, 404, 'Documento não encontrado');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`,
      'Content-Length': data.length,
    });
    res.end(data);
  });

  router.put('/api/knowledge/:id/docs', async ({ res, params, body }) => {
    const input = (body ?? {}) as { name?: string; content?: string; contentBase64?: string };
    const name = input.name?.trim();
    if (!name) {
      sendError(res, 400, 'Informe o nome do documento');
      return;
    }
    try {
      // contentBase64 = arquivo original (PDF/Word/Excel/PPT) guardado como veio
      const doc = input.contentBase64
        ? await writeBinaryDoc(params.id, name, Buffer.from(input.contentBase64, 'base64'))
        : writeDoc(params.id, name, input.content ?? '');
      sendJson(res, 200, doc);
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
      scope?: 'global' | 'project' | 'shared';
      projectId?: string;
      libraryId?: string;
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
      if (input.scope === 'shared') requireLibrary(input.libraryId ?? '');
      const base = await importBaseZip(Buffer.from(input.zipBase64, 'base64'), {
        scope:
          input.scope === 'project' ? 'project' : input.scope === 'shared' ? 'shared' : 'global',
        projectId: input.projectId,
        libraryId: input.libraryId,
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

  /* ---------- coleções: varredura de um site inteiro para dentro da base ---------- */

  router.post('/api/knowledge/:id/collections', async ({ res, params, body }) => {
    const input = (body ?? {}) as { url?: string; maxPages?: number; depth?: number };
    if (!input.url?.trim()) {
      sendError(res, 400, 'Informe a URL inicial do site');
      return;
    }
    if (!getBase(params.id)) {
      sendError(res, 404, 'Base não encontrada');
      return;
    }
    try {
      sendJson(
        res,
        201,
        await addSiteCollection(params.id, input.url.trim(), {
          maxPages: input.maxPages,
          depth: input.depth,
        }),
      );
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  router.post('/api/knowledge/:id/collections/:collectionId/sync', async ({ res, params }) => {
    if (!getBase(params.id)) {
      sendError(res, 404, 'Base não encontrada');
      return;
    }
    try {
      sendJson(res, 200, await syncCollection(params.id, params.collectionId));
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  router.delete('/api/knowledge/:id/collections/:collectionId', ({ res, params, query }) => {
    const keepDocs = query.get('keepDocs') === 'true';
    if (!deleteCollection(params.id, params.collectionId, { keepDocs })) {
      sendError(res, 404, 'Site não encontrado nesta base');
      return;
    }
    sendJson(res, 200, { ok: true });
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

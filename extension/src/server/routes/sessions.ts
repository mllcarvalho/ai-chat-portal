import type { Session, SessionMode } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import { sessionWorkspaceDir } from '../../storage/paths';
import { getProject, projectDir } from '../../storage/projectStore';
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  saveSession,
} from '../../storage/sessionStore';
import { sessionExportFileName, sessionToMarkdown } from '../../storage/sessionMarkdown';
import { registerFileRoutes } from './files';

const MODES: SessionMode[] = ['ask', 'plan', 'agent'];

export function registerSessionRoutes(router: Router): void {
  router.get('/api/sessions', ({ res, query }) => {
    const projectId = query.get('projectId') || null;
    sendJson(res, 200, listSessions(projectId));
  });

  router.post('/api/sessions', ({ res, body }) => {
    const init = (body ?? {}) as {
      title?: string;
      projectId?: string | null;
      mode?: SessionMode;
      modelId?: string;
      agentId?: string;
    };
    if (init.mode && !MODES.includes(init.mode)) {
      sendError(res, 400, 'Modo inválido (use ask, plan ou agent)');
      return;
    }
    const session = createSession(init);
    if (!session) {
      sendError(res, 404, 'Projeto não encontrado');
      return;
    }
    sendJson(res, 201, session);
  });

  // download da conversa inteira como Markdown legível (?format=md)
  router.get('/api/sessions/:id/export', ({ res, params, query }) => {
    const format = query.get('format') || 'md';
    if (format !== 'md') {
      sendError(res, 400, 'Formato não suportado (use format=md)');
      return;
    }
    const session = getSession(params.id);
    if (!session) {
      sendError(res, 404, 'Sessão não encontrada');
      return;
    }
    const fileName = sessionExportFileName(session);
    const data = Buffer.from(sessionToMarkdown(session), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Length': data.length,
      'Content-Disposition': `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    });
    res.end(data);
  });

  router.get('/api/sessions/:id', ({ res, params }) => {
    const session = getSession(params.id);
    if (!session) {
      sendError(res, 404, 'Sessão não encontrada');
      return;
    }
    sendJson(res, 200, session);
  });

  router.patch('/api/sessions/:id', ({ res, params, body }) => {
    const session = getSession(params.id);
    if (!session) {
      sendError(res, 404, 'Sessão não encontrada');
      return;
    }
    const patch = (body ?? {}) as Partial<
      Pick<
        Session,
        'title' | 'modelId' | 'agentId' | 'activeSkillIds' | 'enabledTools' | 'mode' | 'contextFiles'
      >
    >;
    if (patch.mode && !MODES.includes(patch.mode)) {
      sendError(res, 400, 'Modo inválido (use ask, plan ou agent)');
      return;
    }
    if (patch.title !== undefined) session.title = String(patch.title) || session.title;
    if (patch.modelId !== undefined) session.modelId = patch.modelId || undefined;
    if (patch.agentId !== undefined) session.agentId = patch.agentId || undefined;
    if (patch.mode !== undefined) session.mode = patch.mode;
    if (patch.activeSkillIds !== undefined) {
      session.activeSkillIds = Array.isArray(patch.activeSkillIds) ? patch.activeSkillIds : [];
    }
    if (patch.enabledTools !== undefined) {
      session.enabledTools = Array.isArray(patch.enabledTools) ? patch.enabledTools : null;
    }
    if (patch.contextFiles !== undefined) {
      session.contextFiles = Array.isArray(patch.contextFiles)
        ? patch.contextFiles.filter((p): p is string => typeof p === 'string')
        : [];
    }
    saveSession(session);
    sendJson(res, 200, session);
  });

  router.delete('/api/sessions/:id', ({ res, params }) => {
    const ok = deleteSession(params.id);
    sendJson(res, ok ? 200 : 404, { ok });
  });

  // pasta de trabalho da conversa: a do projeto, ou o workspace da sessão avulsa
  registerFileRoutes(
    router,
    '/api/sessions/:id/files',
    (id) => {
      const session = getSession(id);
      if (!session) return undefined;
      if (!session.projectId) return sessionWorkspaceDir(id);
      const project = getProject(session.projectId);
      return project ? projectDir(project) : undefined;
    },
    'Sessão não encontrada',
  );
}

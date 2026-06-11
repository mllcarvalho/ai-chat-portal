import type { Session, SessionMode } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  saveSession,
} from '../../storage/sessionStore';

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
      Pick<Session, 'title' | 'modelId' | 'agentId' | 'activeSkillIds' | 'enabledTools' | 'mode'>
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
    saveSession(session);
    sendJson(res, 200, session);
  });

  router.delete('/api/sessions/:id', ({ res, params }) => {
    const ok = deleteSession(params.id);
    sendJson(res, ok ? 200 : 404, { ok });
  });
}

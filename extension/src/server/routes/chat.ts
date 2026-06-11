import * as crypto from 'node:crypto';
import type { ChatRequestBody } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import { SseStream } from '../sse';
import { runChat } from '../../chat/agentLoop';
import { cancelRequest } from '../../chat/activeRequests';
import { getSession } from '../../storage/sessionStore';

export function registerChatRoutes(router: Router): void {
  router.post('/api/chat', async ({ res, body }) => {
    const { sessionId, text, modelId } = (body ?? {}) as Partial<ChatRequestBody>;
    if (!sessionId || typeof text !== 'string' || !text.trim()) {
      sendError(res, 400, 'sessionId e text são obrigatórios');
      return;
    }
    const session = getSession(sessionId);
    if (!session) {
      sendError(res, 404, 'Sessão não encontrada');
      return;
    }
    const requestId = crypto.randomUUID();
    const sse = new SseStream(res);
    await runChat({ session, text: text.trim(), modelId, requestId, sse });
  });

  router.post('/api/chat/:requestId/cancel', ({ res, params }) => {
    const ok = cancelRequest(params.requestId);
    sendJson(res, ok ? 200 : 404, { ok });
  });
}

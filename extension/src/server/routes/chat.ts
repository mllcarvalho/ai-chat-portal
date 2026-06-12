import * as crypto from 'node:crypto';
import type { ChatAttachment, ChatRequestBody } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import { SseStream } from '../sse';
import { runChat } from '../../chat/agentLoop';
import { cancelRequest } from '../../chat/activeRequests';
import { resolveApproval } from '../../chat/approvals';
import { getSession } from '../../storage/sessionStore';

const MAX_ATTACHMENT_CHARS = 512 * 1024;

export function registerChatRoutes(router: Router): void {
  router.post('/api/chat', async ({ res, body }) => {
    const { sessionId, text, modelId, attachments } = (body ?? {}) as Partial<ChatRequestBody>;
    const validAttachments = (Array.isArray(attachments) ? attachments : []).filter(
      (a): a is ChatAttachment =>
        !!a && typeof a.name === 'string' && !!a.name.trim() && typeof a.content === 'string',
    );
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!sessionId || (!trimmed && !validAttachments.length)) {
      sendError(res, 400, 'sessionId e text (ou anexos) são obrigatórios');
      return;
    }
    if (validAttachments.some((a) => a.content.length > MAX_ATTACHMENT_CHARS)) {
      sendError(res, 400, 'Anexo grande demais (limite de 512 KB por arquivo)');
      return;
    }
    const session = getSession(sessionId);
    if (!session) {
      sendError(res, 404, 'Sessão não encontrada');
      return;
    }
    const requestId = crypto.randomUUID();
    const sse = new SseStream(res);
    await runChat({ session, text: trimmed, modelId, attachments: validAttachments, requestId, sse });
  });

  router.post('/api/chat/:requestId/cancel', ({ res, params }) => {
    const ok = cancelRequest(params.requestId);
    sendJson(res, ok ? 200 : 404, { ok });
  });

  // resposta da UI a um approval_request (comando do portal_run_command)
  router.post('/api/chat/:requestId/approval', ({ res, params, body }) => {
    const { callId, approved } = (body ?? {}) as { callId?: string; approved?: boolean };
    if (!callId || typeof approved !== 'boolean') {
      sendError(res, 400, 'callId e approved são obrigatórios');
      return;
    }
    const ok = resolveApproval(params.requestId, callId, approved);
    sendJson(res, ok ? 200 : 404, { ok });
  });
}

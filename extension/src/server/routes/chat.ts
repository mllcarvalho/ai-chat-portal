import * as crypto from 'node:crypto';
import type { ChatAttachment, ChatRequestBody } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import { SseStream } from '../sse';
import { runChat } from '../../chat/agentLoop';
import { cancelRequest } from '../../chat/activeRequests';
import { ChatStream, activeStream, registerStream } from '../../chat/streamHub';
import { resolveApproval } from '../../chat/approvals';
import { resolveQuestion } from '../../chat/questions';
import { getSession } from '../../storage/sessionStore';

const MAX_ATTACHMENT_CHARS = 512 * 1024;

export function registerChatRoutes(router: Router): void {
  router.post('/api/chat', async ({ res, body }) => {
    const { sessionId, text, attachments, retryFromMessageId } = (body ?? {}) as
      Partial<ChatRequestBody>;
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
    // uma resposta por conversa também do lado do servidor (o front já bloqueia)
    if (activeStream(sessionId)) {
      sendError(res, 409, 'Esta conversa já tem uma resposta em andamento');
      return;
    }
    const session = getSession(sessionId);
    if (!session) {
      sendError(res, 404, 'Sessão não encontrada');
      return;
    }
    const requestId = crypto.randomUUID();
    const stream = new ChatStream(sessionId, requestId, new SseStream(res));
    registerStream(stream);
    try {
      await runChat({
        session,
        text: trimmed,
        attachments: validAttachments,
        ...(typeof retryFromMessageId === 'string' && retryFromMessageId
          ? { retryFromMessageId }
          : {}),
        requestId,
        sse: stream,
      });
    } finally {
      stream.close();
    }
  });

  // há uma resposta em andamento nesta conversa? (usado no reload da página)
  router.get('/api/chat/active', ({ res, query }) => {
    const sessionId = query.get('sessionId') ?? '';
    const stream = sessionId ? activeStream(sessionId) : undefined;
    sendJson(res, 200, { requestId: stream?.requestId ?? null });
  });

  // reconecta a uma resposta em andamento: replay completo + eventos ao vivo
  router.post('/api/chat/attach', ({ res, body }) => {
    const { sessionId } = (body ?? {}) as { sessionId?: string };
    const stream = sessionId ? activeStream(sessionId) : undefined;
    if (!stream) {
      sendError(res, 404, 'Nenhuma resposta em andamento nesta conversa');
      return;
    }
    stream.attach(new SseStream(res));
  });

  router.post('/api/chat/:requestId/cancel', ({ res, params }) => {
    const ok = cancelRequest(params.requestId);
    sendJson(res, ok ? 200 : 404, { ok });
  });

  // stop antes do meta chegar na UI: cancela pela sessão
  router.post('/api/chat/cancel-by-session', ({ res, body }) => {
    const { sessionId } = (body ?? {}) as { sessionId?: string };
    const stream = sessionId ? activeStream(sessionId) : undefined;
    const ok = stream ? cancelRequest(stream.requestId) : false;
    sendJson(res, ok ? 200 : 404, { ok });
  });

  // resposta da UI a um user_question (pergunta do portal_ask_user)
  router.post('/api/chat/:requestId/question', ({ res, params, body }) => {
    const { callId, answer } = (body ?? {}) as { callId?: string; answer?: string };
    if (!callId || typeof answer !== 'string' || !answer.trim()) {
      sendError(res, 400, 'callId e answer são obrigatórios');
      return;
    }
    const ok = resolveQuestion(params.requestId, callId, answer.trim());
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

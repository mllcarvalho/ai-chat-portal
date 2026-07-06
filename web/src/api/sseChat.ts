import type { ChatRequestBody, ChatSseEventName, ChatSseEvents } from '@aiportal/shared';
import { TOKEN_HEADER } from '@aiportal/shared';
import { getToken } from './client';

export interface ChatStreamHandlers {
  onMeta: (data: ChatSseEvents['meta']) => void;
  /** Aviso não-fatal do servidor (ex.: MCPs fora do limite de tools). */
  onNotice: (data: ChatSseEvents['notice']) => void;
  onText: (data: ChatSseEvents['text']) => void;
  onToolCall: (data: ChatSseEvents['tool_call']) => void;
  onApprovalRequest: (data: ChatSseEvents['approval_request']) => void;
  onUserQuestion: (data: ChatSseEvents['user_question']) => void;
  onToolResult: (data: ChatSseEvents['tool_result']) => void;
  onDone: (data: ChatSseEvents['done']) => void;
  /** Chega depois do done: credits reais medidos na cota da licença. */
  onUsageUpdate: (data: ChatSseEvents['usage_update']) => void;
  onError: (data: ChatSseEvents['error']) => void;
}

/**
 * EventSource não suporta POST, então o stream SSE é lido manualmente
 * via fetch + ReadableStream.
 */
export async function streamChat(
  body: ChatRequestBody,
  handlers: ChatStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: getToken() },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let message = `Erro ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // sem corpo
    }
    handlers.onError({ code: 'internal', message });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (block: string) => {
    let event = '';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!event || !dataLines.length) return;
    let data: unknown;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    const name = event as ChatSseEventName;
    switch (name) {
      case 'meta':
        handlers.onMeta(data as ChatSseEvents['meta']);
        break;
      case 'notice':
        handlers.onNotice(data as ChatSseEvents['notice']);
        break;
      case 'text':
        handlers.onText(data as ChatSseEvents['text']);
        break;
      case 'tool_call':
        handlers.onToolCall(data as ChatSseEvents['tool_call']);
        break;
      case 'approval_request':
        handlers.onApprovalRequest(data as ChatSseEvents['approval_request']);
        break;
      case 'user_question':
        handlers.onUserQuestion(data as ChatSseEvents['user_question']);
        break;
      case 'tool_result':
        handlers.onToolResult(data as ChatSseEvents['tool_result']);
        break;
      case 'done':
        handlers.onDone(data as ChatSseEvents['done']);
        break;
      case 'usage_update':
        handlers.onUsageUpdate(data as ChatSseEvents['usage_update']);
        break;
      case 'error':
        handlers.onError(data as ChatSseEvents['error']);
        break;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (block.trim() && !block.startsWith(':')) dispatch(block);
    }
  }
}

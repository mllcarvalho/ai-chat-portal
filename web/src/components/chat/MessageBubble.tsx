import { memo } from 'react';
import type { ChatMessage, MessagePart } from '@aiportal/shared';
import { useCatalog } from '../../stores/catalogStore';
import { useChat } from '../../stores/chatStore';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';
import { Markdown } from '../common/Markdown';
import { ToolCallCard } from './ToolCallCard';

type ToolResultPart = Extract<MessagePart, { type: 'tool_result' }>;

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}k`;
}

export function formatCredits(n: number): string {
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

/** "0x", "1x", "0.33x" — credits descontados por requisição do modelo. */
export function formatMultiplier(multiplier: number): string {
  return `${Number(multiplier.toFixed(2))}x`;
}

/** "low" → "Low", "very_high" → "Very High" — faixa de preço do Copilot. */
export function formatPriceCategory(category: string): string {
  return category
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function messageText(message: ChatMessage): string {
  return message.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * memo: durante o streaming a lista inteira re-renderiza a cada token; as
 * mensagens já persistidas têm props estáveis e são puladas na reconciliação.
 */
export const MessageBubble = memo(function MessageBubble(props: {
  message: ChatMessage;
  streaming?: boolean;
  /** Última resposta da conversa (sem stream ativo): habilita o regenerar. */
  isLastAssistant?: boolean;
  /** Ações de editar/copiar/regenerar ficam ocultas enquanto a conversa gera. */
  actionsDisabled?: boolean;
}) {
  const { message, streaming, isLastAssistant, actionsDisabled } = props;
  const models = useCatalog((s) => s.models);
  const isUser = message.role === 'user';

  const copyMessage = () => {
    void navigator.clipboard.writeText(messageText(message)).then(
      () => useUi.getState().toast('Resposta copiada.', 'ok'),
      () => useUi.getState().toast('Não foi possível copiar.', 'error'),
    );
  };

  if (isUser) {
    const text = messageText(message);
    const attachments = message.parts.filter(
      (p): p is Extract<MessagePart, { type: 'attachment' }> => p.type === 'attachment',
    );
    return (
      <div className="msg msg--user">
        <span className="msg__role">Você</span>
        <div className="msg__body">
          {text}
          {attachments.length > 0 && (
            <div className="msg__attachments">
              {attachments.map((att) => (
                <span
                  className="attachment-chip"
                  key={att.name}
                  title={`${att.name} · ${(att.content.length / 1024).toFixed(1)} KB`}
                >
                  📎 {att.name}
                </span>
              ))}
            </div>
          )}
        </div>
        {!actionsDisabled && (
          <div className="msg__actions">
            <button
              className="msg__action"
              title="Editar e reenviar — a conversa é reescrita a partir daqui"
              onClick={() => useUi.getState().seedComposer(text, message.id)}
            >
              ✏️ editar
            </button>
          </div>
        )}
      </div>
    );
  }

  // casa tool_results com seus tool_calls pelo callId
  const resultsById = new Map<string, ToolResultPart>();
  for (const part of message.parts) {
    if (part.type === 'tool_result') resultsById.set(part.callId, part);
  }

  const rendered: JSX.Element[] = [];
  message.parts.forEach((part, i) => {
    const isLast = i === message.parts.length - 1;
    if (part.type === 'text') {
      rendered.push(
        <div key={i} className={streaming && isLast ? 'stream-caret' : undefined}>
          <Markdown text={part.text} />
        </div>,
      );
    } else if (part.type === 'tool_call') {
      rendered.push(
        <ToolCallCard
          key={part.callId}
          call={part}
          result={resultsById.get(part.callId)}
          running={!!streaming && !resultsById.has(part.callId)}
        />,
      );
    }
    // tool_result é renderizado dentro do card do respectivo tool_call
  });

  // o modelo está "pensando" quando não há atividade visível no fim do stream:
  // resposta ainda vazia, ou a última tool terminou e a próxima rodada (texto
  // ou nova tool) ainda não começou — sem isso a resposta parece travada,
  // principalmente com os cards técnicos ocultos
  const lastPart = message.parts[message.parts.length - 1];
  const modelThinking = streaming && (!lastPart || lastPart.type === 'tool_result');

  return (
    <div className="msg msg--assistant">
      <span className="msg__role">Assistente</span>
      <div className="msg__body">
        {rendered}
        {modelThinking && (
          <span className="thinking-row">
            <span className="thinking">
              <span />
              <span />
              <span />
            </span>
            <span className="thinking-row__label">pensando…</span>
          </span>
        )}
        {message.error && (
          <div className="msg__error">⚠ {message.error.message}</div>
        )}
        {!streaming && !actionsDisabled && (
          <div className="msg__actions">
            {messageText(message) && (
              <button className="msg__action" title="Copiar a resposta inteira" onClick={copyMessage}>
                ⧉ copiar
              </button>
            )}
            {isLastAssistant && (
              <button
                className="msg__action"
                title="Gerar esta resposta de novo"
                onClick={() => {
                  const sessionId = useSessions.getState().current?.id;
                  if (sessionId) useChat.getState().regenerate(sessionId);
                }}
              >
                ↻ regenerar
              </button>
            )}
          </div>
        )}
        {message.usage && (
          <div
            className="msg__usage"
            title="Tokens enviados ao modelo (entrada, somando todas as rodadas) e gerados (saída) · requisições ao Copilot nesta resposta · AI credits realmente descontados da licença nesta resposta (medidos na cota do Copilot)"
          >
            ↑ {formatTokens(message.usage.inputTokens)} · ↓ {formatTokens(message.usage.outputTokens)} tokens
            {' · '}
            {message.usage.requests} req
            {(() => {
              // mesmo fallback do servidor: sem modelId gravado, vale o primeiro da lista
              const model = models.find((m) => m.id === message.modelId) ?? models[0];
              // preferência: custo real medido na licença; senão, estimativa
              // pelo multiplicador (modelos antigos que ainda o expõem)
              const credits =
                message.usage.credits ??
                (model?.multiplier !== undefined
                  ? message.usage.requests * model.multiplier
                  : undefined);
              if (credits === undefined) return null;
              return (
                <>
                  {' · '}
                  {model?.name ?? 'modelo'} · {formatCredits(credits)}{' '}
                  {credits === 1 ? 'credit' : 'credits'}
                </>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
});

import type { ChatMessage, MessagePart } from '@aiportal/shared';
import { useCatalog } from '../../stores/catalogStore';
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

export function MessageBubble(props: { message: ChatMessage; streaming?: boolean }) {
  const { message, streaming } = props;
  const models = useCatalog((s) => s.models);
  const isUser = message.role === 'user';

  if (isUser) {
    const text = message.parts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('');
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

  return (
    <div className="msg msg--assistant">
      <span className="msg__role">Assistente</span>
      <div className="msg__body">
        {rendered}
        {streaming && message.parts.length === 0 && (
          <span className="thinking">
            <span />
            <span />
            <span />
          </span>
        )}
        {message.error && (
          <div className="msg__error">⚠ {message.error.message}</div>
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
}

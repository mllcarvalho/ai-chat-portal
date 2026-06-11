import type { ChatMessage, MessagePart } from '@aiportal/shared';
import { Markdown } from '../common/Markdown';
import { ToolCallCard } from './ToolCallCard';

type ToolResultPart = Extract<MessagePart, { type: 'tool_result' }>;

export function MessageBubble(props: { message: ChatMessage; streaming?: boolean }) {
  const { message, streaming } = props;
  const isUser = message.role === 'user';

  if (isUser) {
    const text = message.parts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('');
    return (
      <div className="msg msg--user">
        <span className="msg__role">Você</span>
        <div className="msg__body">{text}</div>
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
      </div>
    </div>
  );
}

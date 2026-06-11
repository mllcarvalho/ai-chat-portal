import { useEffect, useRef, useState } from 'react';
import { useSessions } from '../../stores/sessionsStore';
import { useChat } from '../../stores/chatStore';
import { ChatHeader } from './ChatHeader';
import { MessageBubble } from './MessageBubble';
import { Composer } from './Composer';

export function ChatView() {
  const session = useSessions((s) => s.current);
  const streamingParts = useChat((s) => s.streamingParts);
  const isStreaming = useChat((s) => s.isStreaming);
  const listRef = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  // auto-scroll só quando o usuário já estava no fim
  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedToBottom) el.scrollTop = el.scrollHeight;
  }, [session?.messages.length, streamingParts, pinnedToBottom]);

  if (!session) return null;

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setPinnedToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  return (
    <>
      <ChatHeader />
      <div className="message-list" ref={listRef} onScroll={onScroll}>
        <div className="message-list__inner">
          {session.messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {isStreaming && (
            <MessageBubble
              streaming
              message={{
                id: 'streaming',
                role: 'assistant',
                parts: streamingParts,
                createdAt: '',
              }}
            />
          )}
          {session.messages.length === 0 && !isStreaming && (
            <div className="empty-state" style={{ paddingTop: '12vh' }}>
              Envie uma mensagem para começar.
              <br />
              Dica: digite <strong>/</strong> para usar comandos das suas skills.
            </div>
          )}
        </div>
      </div>
      <div style={{ position: 'relative' }}>
        {!pinnedToBottom && (
          <button
            className="scroll-pill"
            onClick={() => {
              const el = listRef.current;
              if (el) el.scrollTop = el.scrollHeight;
              setPinnedToBottom(true);
            }}
          >
            ↓ ir para o fim
          </button>
        )}
        <Composer />
      </div>
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useSessions } from '../../stores/sessionsStore';
import { useChat } from '../../stores/chatStore';
import { ChatHeader } from './ChatHeader';
import { MessageBubble } from './MessageBubble';
import { Composer } from './Composer';
import { BmadActions } from './BmadActions';

export function ChatView() {
  const session = useSessions((s) => s.current);
  // stream DESTA sessão — outras conversas podem estar gerando em paralelo
  const stream = useChat((s) => (session ? s.streams[session.id] : undefined));
  const resume = useChat((s) => s.resume);
  const isStreaming = !!stream;
  const listRef = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  // auto-scroll só quando o usuário já estava no fim
  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedToBottom) el.scrollTop = el.scrollHeight;
  }, [session?.messages.length, stream?.parts, pinnedToBottom]);

  // resposta seguiu rodando no servidor (reload/reconexão)? reanexa o stream
  useEffect(() => {
    if (session) void resume(session.id);
  }, [session?.id, resume]);

  if (!session) return null;

  const lastAssistantId = [...session.messages]
    .reverse()
    .find((m) => m.role === 'assistant')?.id;

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
            <MessageBubble
              key={message.id}
              message={message}
              isLastAssistant={message.id === lastAssistantId && !isStreaming}
              actionsDisabled={isStreaming}
            />
          ))}
          {stream && (
            <MessageBubble
              streaming
              message={{
                id: 'streaming',
                role: 'assistant',
                parts: stream.parts,
                createdAt: '',
              }}
            />
          )}
          {session.messages.length === 0 && !isStreaming && (
            <div className="empty-state" style={{ paddingTop: '12vh' }}>
              Envie uma mensagem para começar — ou dispare uma ação BMAD pelos botões abaixo.
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
        <BmadActions />
        <Composer />
      </div>
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { useSessions } from '../../stores/sessionsStore';
import { useChat } from '../../stores/chatStore';
import { usePreview } from '../../stores/previewStore';
import { useUi } from '../../stores/uiStore';
import { ChatHeader } from './ChatHeader';
import { MessageBubble } from './MessageBubble';
import { Composer } from './Composer';
import { BmadActions } from './BmadActions';
import { PreviewPane } from '../panels/PreviewPane';
import { ProjectFilesDrawer } from '../panels/ProjectFilesDrawer';

export function ChatView() {
  const session = useSessions((s) => s.current);
  const previewEnabled = usePreview((s) => s.enabled);
  const panel = useUi((s) => s.panel);
  // stream DESTA sessão — outras conversas podem estar gerando em paralelo
  const stream = useChat((s) => (session ? s.streams[session.id] : undefined));
  const resume = useChat((s) => s.resume);
  const isStreaming = !!stream;
  const listRef = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  // auto-scroll só quando o usuário já estava no fim (sempre instantâneo:
  // rolagem animada dispara onScroll no meio do caminho e desliga o pin)
  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedToBottom) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
  }, [session?.messages.length, stream?.parts, pinnedToBottom]);

  // enviar uma mensagem sempre re-ancora no fim, mesmo se estava rolado para cima
  const lastMessage = session?.messages[session.messages.length - 1];
  useEffect(() => {
    if (lastMessage?.role === 'user') setPinnedToBottom(true);
  }, [lastMessage?.id, lastMessage?.role]);

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
      {/* split do modo preview: o header fica inteiro em cima; abaixo dele,
          chat à esquerda e abas de arquivos à direita */}
      <div className="chat-split">
        <div className="chat-split__main">
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
                <ArrowDown className="icon icon--sm" aria-hidden /> ir para o fim
              </button>
            )}
            <BmadActions />
            <Composer />
          </div>
        </div>
        {previewEnabled && <PreviewPane />}
        {/* drawer de arquivos abaixo do header: só o corpo do chat encolhe,
            os botões da barra superior ficam fixos no lugar */}
        {panel.kind === 'files' && <ProjectFilesDrawer />}
      </div>
    </>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSessions } from '../../stores/sessionsStore';
import { useChat } from '../../stores/chatStore';
import { useCatalog } from '../../stores/catalogStore';

export function Composer() {
  const session = useSessions((s) => s.current);
  const send = useChat((s) => s.send);
  const stop = useChat((s) => s.stop);
  const isStreaming = useChat((s) => s.isStreaming);
  const skills = useCatalog((s) => s.skills);
  const [text, setText] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const commandSkills = useMemo(
    () =>
      skills.filter(
        (s) =>
          s.kind === 'command' &&
          (s.scope === 'global' || s.projectId === session?.projectId),
      ),
    [skills, session?.projectId],
  );

  const slashQuery = useMemo(() => {
    const match = /^\/([\w-]*)$/.exec(text.split('\n')[0] ?? '');
    return text.startsWith('/') && match ? match[1] : undefined;
  }, [text]);

  const slashMatches = useMemo(
    () =>
      slashQuery === undefined
        ? []
        : commandSkills.filter((s) => s.command?.startsWith(slashQuery)),
    [slashQuery, commandSkills],
  );

  useEffect(() => setSlashIndex(0), [slashQuery]);

  // auto-grow do textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [session?.id]);

  if (!session) return null;

  const doSend = () => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    setText('');
    void send(trimmed);
  };

  const pickSlash = (command: string) => {
    setText(`/${command} `);
    textareaRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMatches.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        pickSlash(slashMatches[slashIndex].command!);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  };

  return (
    <div className="composer-wrap">
      {slashMatches.length > 0 && (
        <div className="slash-menu">
          {slashMatches.map((skill, i) => (
            <button
              key={skill.id}
              className={`slash-menu__item${i === slashIndex ? ' slash-menu__item--sel' : ''}`}
              onClick={() => pickSlash(skill.command!)}
            >
              <span className="slash-menu__cmd">/{skill.command}</span>
              <span className="slash-menu__desc">{skill.description || skill.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="composer">
        <textarea
          ref={textareaRef}
          rows={1}
          placeholder={
            session.mode === 'agent'
              ? 'Peça algo — o assistente pode usar ferramentas e gerar arquivos…'
              : session.mode === 'plan'
                ? 'Descreva o que você quer planejar…'
                : 'Faça uma pergunta…'
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {isStreaming ? (
          <button className="composer__send composer__send--stop" onClick={stop} title="Parar geração">
            ■
          </button>
        ) : (
          <button className="composer__send" onClick={doSend} disabled={!text.trim()} title="Enviar">
            ➤
          </button>
        )}
      </div>
      <div className="composer__hint">
        Enter envia · Shift+Enter quebra linha · "/" para comandos
      </div>
    </div>
  );
}

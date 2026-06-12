import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatAttachment } from '@aiportal/shared';
import { useSessions } from '../../stores/sessionsStore';
import { useChat } from '../../stores/chatStore';
import { useCatalog } from '../../stores/catalogStore';
import { useUi } from '../../stores/uiStore';
import {
  CONVERTIBLE_LABEL,
  extractDocumentText,
  isConvertibleDocument,
} from '../../lib/extractDocument';

/** Limite por arquivo anexado (o servidor recusa acima de 512 KB). */
const MAX_ATTACHMENT_BYTES = 512 * 1024;
/** Limite do arquivo original quando há conversão (Excel/Word/PDF). */
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

/** Heurística simples: arquivos binários costumam ter NUL nos primeiros bytes. */
function looksBinary(content: string): boolean {
  return content.slice(0, 4096).includes('\0');
}

export function Composer() {
  const session = useSessions((s) => s.current);
  const patchCurrent = useSessions((s) => s.patchCurrent);
  const send = useChat((s) => s.send);
  const stop = useChat((s) => s.stop);
  const isStreaming = useChat((s) => s.isStreaming);
  const skills = useCatalog((s) => s.skills);
  const loadSkills = useCatalog((s) => s.loadSkills);
  const composerSeed = useUi((s) => s.composerSeed);
  const clearComposerSeed = useUi((s) => s.clearComposerSeed);
  const openPanel = useUi((s) => s.openPanel);
  const toast = useUi((s) => s.toast);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  // texto vindo de fora (ex: comando escolhido no menu de skills do header)
  useEffect(() => {
    if (composerSeed === undefined) return;
    setText(composerSeed);
    clearComposerSeed();
    textareaRef.current?.focus();
  }, [composerSeed, clearComposerSeed]);

  // toda skill é invocável por /comando; valem as globais + as do projeto da sessão
  const commandSkills = useMemo(
    () =>
      skills.filter(
        (s) => !!s.command && (s.scope === 'global' || s.projectId === session?.projectId),
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

  // mantém o item selecionado visível quando o menu tem scroll
  useEffect(() => {
    slashMenuRef.current
      ?.querySelector('.slash-menu__item--sel')
      ?.scrollIntoView({ block: 'nearest' });
  }, [slashIndex, slashMatches.length]);

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

  const addFiles = async (files: FileList | File[]) => {
    const next: ChatAttachment[] = [];
    for (const file of Array.from(files)) {
      if (attachments.some((a) => a.name === file.name)) {
        toast(`"${file.name}" já está anexado.`, 'info');
        continue;
      }
      let content: string;
      if (isConvertibleDocument(file.name)) {
        if (file.size > MAX_SOURCE_BYTES) {
          toast(`"${file.name}" passa de 10 MB e não foi anexado.`, 'error');
          continue;
        }
        try {
          content = await extractDocumentText(file);
        } catch (err) {
          toast(`"${file.name}": ${(err as Error).message}`, 'error');
          continue;
        }
      } else {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          toast(`"${file.name}" passa de 512 KB e não foi anexado.`, 'error');
          continue;
        }
        content = await file.text();
        if (looksBinary(content)) {
          toast(`"${file.name}" parece binário — anexe texto ou ${CONVERTIBLE_LABEL}.`, 'error');
          continue;
        }
      }
      if (content.length > MAX_ATTACHMENT_BYTES) {
        toast(`"${file.name}" convertido passa de 512 KB de texto e não foi anexado.`, 'error');
        continue;
      }
      next.push({ name: file.name, content });
    }
    if (next.length) setAttachments((curr) => [...curr, ...next]);
  };

  const doSend = () => {
    const trimmed = text.trim();
    if ((!trimmed && !attachments.length) || isStreaming) return;
    setText('');
    setAttachments([]);
    void send(trimmed, attachments);
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
    <div
      className="composer-wrap"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragOver(false);
        void addFiles(e.dataTransfer.files);
      }}
    >
      {slashMatches.length > 0 && (
        <div className="slash-menu" ref={slashMenuRef}>
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
      {(session.contextFiles?.length ?? 0) > 0 && (
        <div className="composer__attachments">
          <span
            className="composer__context-label"
            title="Arquivos do projeto fixados no contexto desta conversa"
          >
            no contexto:
          </span>
          {session.contextFiles!.map((path) => (
            <span
              className="attachment-chip attachment-chip--pinned"
              key={path}
              title={`${path} — fixado no contexto · clique para abrir o painel de arquivos`}
              role="button"
              onClick={() => openPanel({ kind: 'files' })}
            >
              📌 {path.split('/').pop()}
              <button
                className="attachment-chip__remove"
                title="Remover do contexto"
                onClick={(e) => {
                  e.stopPropagation();
                  void patchCurrent({
                    contextFiles: session.contextFiles!.filter((p) => p !== path),
                  });
                }}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="composer__attachments">
          {attachments.map((att) => (
            <span className="attachment-chip" key={att.name} title={att.name}>
              📎 {att.name}
              <button
                className="attachment-chip__remove"
                title="Remover anexo"
                onClick={() => setAttachments((curr) => curr.filter((a) => a.name !== att.name))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className={`composer${dragOver ? ' composer--dragover' : ''}`}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          className="composer__attach"
          title="Anexar arquivos ao contexto: texto, Excel, Word ou PDF (ou arraste para cá)"
          onClick={() => fileInputRef.current?.click()}
          disabled={isStreaming}
        >
          📎
        </button>
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
          <button
            className="composer__send"
            onClick={doSend}
            disabled={!text.trim() && !attachments.length}
            title="Enviar"
          >
            ➤
          </button>
        )}
      </div>
      <div className="composer__hint">
        Enter envia · Shift+Enter quebra linha · "/" para comandos · 📎 anexa arquivos
      </div>
    </div>
  );
}

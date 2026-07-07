import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatAttachment, FileEntry } from '@aiportal/shared';
import { api } from '../../api/client';
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

/** Achata a árvore de arquivos da pasta de trabalho em caminhos de arquivo. */
function flattenFiles(entries: FileEntry[]): string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.type === 'file') paths.push(entry.path);
    if (entry.children) paths.push(...flattenFiles(entry.children));
  }
  return paths;
}

export function Composer() {
  const session = useSessions((s) => s.current);
  const patchCurrent = useSessions((s) => s.patchCurrent);
  const send = useChat((s) => s.send);
  const stop = useChat((s) => s.stop);
  // só o stream DESTA sessão bloqueia o envio — outras conversas rodam em paralelo
  const isStreaming = useChat((s) => (session ? !!s.streams[session.id] : false));
  const skills = useCatalog((s) => s.skills);
  const loadSkills = useCatalog((s) => s.loadSkills);
  const composerSeed = useUi((s) => s.composerSeed);
  const composerRetryFrom = useUi((s) => s.composerRetryFrom);
  const clearComposerSeed = useUi((s) => s.clearComposerSeed);
  const openPanel = useUi((s) => s.openPanel);
  const toast = useUi((s) => s.toast);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  /** Modo edição: reenvio substitui a conversa a partir desta mensagem. */
  const [editingId, setEditingId] = useState<string | undefined>();
  const [slashIndex, setSlashIndex] = useState(0);
  /** Posição do cursor no textarea — âncora do menu de #arquivo. */
  const [caret, setCaret] = useState(0);
  const [hashIndex, setHashIndex] = useState(0);
  /** Arquivos da pasta de trabalho, carregados quando o menu # abre. */
  const [workFiles, setWorkFiles] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  // texto vindo de fora (comando do menu de skills, ou editar mensagem)
  useEffect(() => {
    if (composerSeed === undefined) return;
    setText(composerSeed);
    setEditingId(composerRetryFrom);
    clearComposerSeed();
    textareaRef.current?.focus();
  }, [composerSeed, composerRetryFrom, clearComposerSeed]);

  // trocar de conversa cancela uma edição pendente
  useEffect(() => setEditingId(undefined), [session?.id]);

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

  // "#nome" na posição do cursor abre o menu de arquivos da pasta de trabalho
  // (referência de contexto no estilo #file do Copilot)
  const hashQuery = useMemo(() => {
    const before = text.slice(0, caret);
    const match = /(?:^|\s)#([\w./-]*)$/.exec(before);
    return match ? match[1] : undefined;
  }, [text, caret]);

  const hashOpen = hashQuery !== undefined;
  useEffect(() => {
    if (!hashOpen || !session) return;
    let alive = true;
    api
      .sessionFiles(session.id)
      .then((entries) => {
        if (alive) setWorkFiles(flattenFiles(entries));
      })
      .catch(() => setWorkFiles([]));
    return () => {
      alive = false;
    };
  }, [hashOpen, session?.id]);

  /** Esc fecha o menu # sem apagar o texto; digitar de novo reabre. */
  const [hashDismissed, setHashDismissed] = useState(false);
  useEffect(() => {
    setHashIndex(0);
    setHashDismissed(false);
  }, [hashQuery]);

  const hashMatches = useMemo(() => {
    if (hashQuery === undefined || hashDismissed) return [];
    const q = hashQuery.toLowerCase();
    const pinned = new Set(session?.contextFiles ?? []);
    return workFiles
      .filter((p) => !pinned.has(p) && p.toLowerCase().includes(q))
      .slice(0, 12);
  }, [hashQuery, hashDismissed, workFiles, session?.contextFiles]);

  // mantém o item selecionado visível quando o menu tem scroll
  useEffect(() => {
    slashMenuRef.current
      ?.querySelector('.slash-menu__item--sel')
      ?.scrollIntoView({ block: 'nearest' });
  }, [slashIndex, slashMatches.length, hashIndex, hashMatches.length]);

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
    setEditingId(undefined);
    void send(trimmed, attachments, editingId ? { retryFromMessageId: editingId } : undefined);
  };

  /** Anexa a seleção (ou arquivo) ativa do editor do VS Code, como o # do Copilot. */
  const addEditorContext = async () => {
    try {
      const ctx = await api.editorContext();
      if (!ctx.file) {
        toast('Nenhum editor de texto ativo na janela do VS Code.', 'info');
        return;
      }
      const name = ctx.file.startLine
        ? `${ctx.file.name}#L${ctx.file.startLine}-${ctx.file.endLine}`
        : ctx.file.name;
      if (attachments.some((a) => a.name === name)) {
        toast(`"${name}" já está anexado.`, 'info');
        return;
      }
      if (ctx.file.truncated) toast(`"${name}" passou de 512 KB e foi truncado.`, 'info');
      setAttachments((curr) => [...curr, { name, content: ctx.file!.content }]);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const pickSlash = (command: string) => {
    setText(`/${command} `);
    textareaRef.current?.focus();
  };

  /** Fixa o arquivo no contexto da conversa e remove o "#nome" do texto. */
  const pickHash = (path: string) => {
    const before = text.slice(0, caret).replace(/#[\w./-]*$/, '');
    const after = text.slice(caret);
    setText(before + after);
    setCaret(before.length);
    void patchCurrent({ contextFiles: [...(session.contextFiles ?? []), path] }).catch((err) => {
      toast((err as Error).message, 'error');
    });
    textareaRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (hashMatches.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHashIndex((i) => (i + 1) % hashMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHashIndex((i) => (i - 1 + hashMatches.length) % hashMatches.length);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        pickHash(hashMatches[hashIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setHashDismissed(true);
        return;
      }
    }
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
    if (e.key === 'Escape' && editingId) {
      e.preventDefault();
      setEditingId(undefined);
      return;
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
      {hashMatches.length > 0 && (
        <div className="slash-menu" ref={slashMenuRef}>
          {hashMatches.map((path, i) => (
            <button
              key={path}
              className={`slash-menu__item${i === hashIndex ? ' slash-menu__item--sel' : ''}`}
              onClick={() => pickHash(path)}
              title={`Fixar ${path} no contexto da conversa`}
            >
              <span className="slash-menu__cmd">📄 {path.split('/').pop()}</span>
              <span className="slash-menu__desc">{path}</span>
            </button>
          ))}
        </div>
      )}
      {editingId && (
        <div className="composer__attachments">
          <span
            className="attachment-chip attachment-chip--editing"
            title="Ao enviar, a conversa é reescrita a partir da mensagem editada — as respostas seguintes são descartadas"
          >
            ✏️ editando mensagem — Esc cancela
            <button
              className="attachment-chip__remove"
              title="Cancelar edição"
              onClick={() => setEditingId(undefined)}
            >
              ✕
            </button>
          </span>
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
        >
          📎
        </button>
        <button
          className="composer__attach"
          title="Anexar a seleção (ou o arquivo) ativa no editor do VS Code"
          onClick={() => void addEditorContext()}
        >
          {'</>'}
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
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
        />
        {isStreaming ? (
          <button
            className="composer__send composer__send--stop"
            onClick={() => session && stop(session.id)}
            title="Parar geração"
          >
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
        Enter envia · Shift+Enter quebra linha · "/" comandos · "#" referencia arquivo · 📎 anexa
      </div>
    </div>
  );
}

import { useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Drama,
  MessagesSquare,
  Play,
  Settings,
  Terminal,
  Undo2,
  X,
} from 'lucide-react';
import type { MessagePart } from '@aiportal/shared';
import { api } from '../../api/client';
import { useChat } from '../../stores/chatStore';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';
import { Markdown } from '../common/Markdown';

type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;
type ToolResultPart = Extract<MessagePart, { type: 'tool_result' }>;

/** Rótulos amigáveis das ferramentas builtin (MCPs/desconhecidas mantêm o nome cru). */
const TOOL_LABELS: Record<string, string> = {
  portal_write_file: 'Criando arquivo',
  portal_edit_file: 'Editando arquivo',
  portal_read_file: 'Lendo arquivo',
  portal_list_files: 'Listando arquivos',
  portal_search_files: 'Buscando nos arquivos',
  portal_delete_file: 'Excluindo arquivo',
  portal_move_file: 'Movendo arquivo',
  portal_run_command: 'Executando comando',
  portal_fetch_url: 'Consultando página',
  portal_web_search: 'Pesquisando na web',
  portal_spawn_subagent: 'Consultando subagente',
  portal_ask_user: 'Perguntando ao usuário',
  portal_load_skill: 'Carregando skill',
  portal_read_skill_file: 'Lendo anexo de skill',
  portal_search_knowledge: 'Buscando na base de conhecimento',
  portal_read_knowledge: 'Lendo base de conhecimento',
  portal_save_knowledge: 'Salvando na base de conhecimento',
  portal_create_skill: 'Criando skill',
  portal_create_agent: 'Criando agente',
  bmad_read_file: 'Lendo arquivo do BMAD',
  bmad_list_files: 'Listando arquivos do BMAD',
  bmad_write_custom: 'Gravando customização do BMAD',
};

/** Resumo humano do input principal (path, query, comando…) exibido no título do card. */
function inputSummary(call: ToolCallPart): string | undefined {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  switch (call.toolName) {
    case 'portal_move_file': {
      const from = str(input.from);
      const to = str(input.to);
      return from && to ? `${from} → ${to}` : (from ?? to);
    }
    case 'portal_run_command':
      return str(input.command);
    case 'portal_fetch_url':
      return str(input.url);
    case 'portal_web_search':
    case 'portal_search_files':
    case 'portal_search_knowledge':
      return str(input.query);
    case 'portal_read_knowledge': {
      const parts = [str(input.base), str(input.doc)].filter((v): v is string => !!v);
      return parts.length ? parts.join(' / ') : undefined;
    }
    case 'portal_save_knowledge':
      return str(input.base);
    case 'portal_load_skill': {
      const command = str(input.command);
      return command ? `/${command.replace(/^\//, '')}` : undefined;
    }
    case 'portal_create_skill':
    case 'portal_create_agent':
      return str(input.name);
    default:
      // a maioria das ferramentas de arquivo usa o campo path
      return str(input.path);
  }
}

/**
 * Marcador "[checkpoint:<id>]" que o backend anexa ao resultado das tools de
 * escrita — vira o botão "Reverter" e sai do texto exibido.
 */
const CHECKPOINT_RE = /\n?\[checkpoint:([a-z0-9-]+)\]\s*$/;

function parseCheckpoint(result?: ToolResultPart): { id?: string; content: string } {
  if (!result) return { content: '' };
  const match = CHECKPOINT_RE.exec(result.content);
  if (!match) return { content: result.content };
  return { id: match[1], content: result.content.replace(CHECKPOINT_RE, '') };
}

/**
 * Edição de arquivo como diff removido→adicionado (como o Copilot mostra
 * edições no VS Code), em vez do JSON cru com \n escapado.
 */
function EditDiff(props: { input: Record<string, unknown> }) {
  const find = typeof props.input.find === 'string' ? props.input.find : '';
  const replace = typeof props.input.replace === 'string' ? props.input.replace : '';
  if (!find && !replace) return null;
  return (
    <div className="tool-diff">
      {find.split('\n').map((line, i) => (
        <div key={`d${i}`} className="tool-diff__line tool-diff__line--del">
          <span className="tool-diff__sign">-</span>
          {line}
        </div>
      ))}
      {replace.split('\n').map((line, i) => (
        <div key={`a${i}`} className="tool-diff__line tool-diff__line--add">
          <span className="tool-diff__sign">+</span>
          {line}
        </div>
      ))}
    </div>
  );
}

/** Nome de exibição da persona de um subagente. */
function subagentLabel(input: Record<string, unknown>): string {
  if (typeof input.label === 'string' && input.label.trim()) return input.label.trim();
  if (typeof input.personaAgent === 'string' && input.personaAgent.trim()) {
    return input.personaAgent.trim();
  }
  if (typeof input.personaPath === 'string' && input.personaPath.trim()) {
    const base = input.personaPath.split('/').pop() ?? '';
    return base.replace(/\.(md|txt)$/i, '') || 'Subagente';
  }
  return 'Subagente';
}

/**
 * Resposta de subagente (portal_spawn_subagent) como um balão de persona:
 * conteúdo em markdown com o nome de quem "falou" — não como card técnico.
 * Sempre visível, mesmo com "ocultar detalhes técnicos" (é conteúdo, não log).
 */
function SubagentBubble(props: { call: ToolCallPart; result?: ToolResultPart; running: boolean }) {
  const { call, result, running } = props;
  const [taskOpen, setTaskOpen] = useState(false);
  const input = (call.input ?? {}) as Record<string, unknown>;
  const label = subagentLabel(input);
  const task = typeof input.task === 'string' ? input.task : '';

  return (
    <div className={`subagent-bubble${result && !result.ok ? ' subagent-bubble--error' : ''}`}>
      <div className="subagent-bubble__head">
        <span className="subagent-bubble__avatar"><Drama className="icon" aria-hidden /></span>
        <span className="subagent-bubble__name">{label}</span>
        {running ? (
          <span className="tool-card__status tool-card__status--running">
            <span className="spinner" /> trabalhando…
          </span>
        ) : result ? (
          result.ok ? (
            <span className="tool-card__status">
              <Check className="icon icon--sm" aria-hidden /> {(result.durationMs / 1000).toFixed(1)}s
            </span>
          ) : (
            <span className="tool-card__status tool-card__status--error">
              <X className="icon icon--sm" aria-hidden /> falhou
            </span>
          )
        ) : null}
        {task && (
          <button
            className="subagent-bubble__toggle"
            onClick={() => setTaskOpen((v) => !v)}
            title={taskOpen ? 'Ocultar a tarefa enviada' : 'Ver a tarefa enviada'}
          >
            {taskOpen ? (
              <ChevronDown className="icon icon--sm" aria-hidden />
            ) : (
              <ChevronRight className="icon icon--sm" aria-hidden />
            )}{' '}
            tarefa
          </button>
        )}
      </div>
      {taskOpen && task && <pre className="subagent-bubble__task">{task}</pre>}
      {result &&
        (result.ok ? (
          <div className="subagent-bubble__body">
            <Markdown text={result.content} />
          </div>
        ) : (
          <pre className="subagent-bubble__task">{result.content}</pre>
        ))}
    </div>
  );
}

export function ToolCallCard(props: {
  call: ToolCallPart;
  result?: ToolResultPart;
  running: boolean;
}) {
  const { call, result, running } = props;
  const [open, setOpen] = useState(false);
  const [freeAnswer, setFreeAnswer] = useState('');
  const [revertState, setRevertState] = useState<'idle' | 'reverting' | 'reverted' | 'error'>(
    'idle',
  );
  const [revertError, setRevertError] = useState('');
  // o card renderiza dentro da sessão aberta — pendências vêm do stream dela
  const sessionId = useSessions((s) => s.current?.id);
  const stream = useChat((s) => (sessionId ? s.streams[sessionId] : undefined));
  const pendingApproval = stream?.pendingApproval;
  const pendingQuestion = stream?.pendingQuestion;
  const doRespondApproval = useChat((s) => s.respondApproval);
  const doRespondQuestion = useChat((s) => s.respondQuestion);
  const respondApproval = (approved: boolean) =>
    sessionId && doRespondApproval(sessionId, approved);
  const respondQuestion = (answer: string) => sessionId && doRespondQuestion(sessionId, answer);
  const hideToolCards = useUi((s) => s.hideToolCards);
  const awaitingApproval = !result && pendingApproval?.callId === call.callId;
  const awaitingQuestion = !result && pendingQuestion?.callId === call.callId;

  if (call.toolName === 'portal_spawn_subagent') {
    return <SubagentBubble call={call} result={result} running={running} />;
  }

  // preferência "ocultar detalhes técnicos": some com os cards, MAS pedidos de
  // aprovação/perguntas aparecem sempre, e enquanto uma ferramenta roda fica
  // uma linha discreta para a resposta não parecer travada
  if (hideToolCards && !awaitingApproval && !awaitingQuestion) {
    if (!running) return null;
    return (
      <div className="tool-card tool-card--quiet">
        <span className="tool-card__status tool-card__status--running">
          <span className="spinner" /> trabalhando…
        </span>
      </div>
    );
  }

  const status = awaitingApproval ? (
    <span className="tool-card__status tool-card__status--approval">aguardando aprovação</span>
  ) : awaitingQuestion ? (
    <span className="tool-card__status tool-card__status--approval">aguardando resposta</span>
  ) : running ? (
    <span className="tool-card__status tool-card__status--running">
      <span className="spinner" /> executando…
    </span>
  ) : result ? (
    result.ok ? (
      <span className="tool-card__status">
        <Check className="icon icon--sm" aria-hidden /> {(result.durationMs / 1000).toFixed(1)}s
      </span>
    ) : (
      <span className="tool-card__status tool-card__status--error">
        <X className="icon icon--sm" aria-hidden /> falhou
      </span>
    )
  ) : (
    <span className="tool-card__status">—</span>
  );

  const icon =
    call.toolName === 'portal_run_command' ? (
      <Terminal className="icon" aria-hidden />
    ) : call.toolName === 'portal_ask_user' ? (
      <MessagesSquare className="icon" aria-hidden />
    ) : (
      <Settings className="icon" aria-hidden />
    );

  const summary = inputSummary(call);
  const checkpoint = parseCheckpoint(result);
  const doRevert = async () => {
    if (!checkpoint.id || revertState === 'reverting' || revertState === 'reverted') return;
    setRevertState('reverting');
    setRevertError('');
    try {
      await api.revertCheckpoint(checkpoint.id);
      setRevertState('reverted');
    } catch (err) {
      setRevertError(err instanceof Error ? err.message : String(err));
      setRevertState('error');
    }
  };

  return (
    <div className="tool-card">
      <button className="tool-card__head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-card__icon">
          {open ? (
            <ChevronDown className="icon icon--sm" aria-hidden />
          ) : (
            <ChevronRight className="icon icon--sm" aria-hidden />
          )}
        </span>
        <span className="tool-card__icon">{icon}</span>
        <span className="tool-card__name">{TOOL_LABELS[call.toolName] ?? call.toolName}</span>
        {summary && (
          <span className="tool-card__path" title={summary}>
            {summary}
          </span>
        )}
        {status}
      </button>
      {checkpoint.id && result?.ok && (
        <div className="tool-card__revert">
          <button
            className="btn btn--sm btn--ghost"
            disabled={revertState === 'reverting' || revertState === 'reverted'}
            onClick={doRevert}
            title="Restaura o estado do(s) arquivo(s) antes desta alteração"
          >
            {revertState === 'reverted' ? (
              <>
                <Check className="icon icon--sm" aria-hidden /> Revertido
              </>
            ) : (
              <>
                <Undo2 className="icon icon--sm" aria-hidden />{' '}
                {revertState === 'reverting' ? 'Revertendo…' : 'Reverter'}
              </>
            )}
          </button>
          {revertState === 'error' && (
            <span className="tool-card__revert-error" title={revertError}>
              {revertError}
            </span>
          )}
        </div>
      )}
      {awaitingApproval && (
        <div className="tool-card__approval">
          <pre className="tool-card__command">{pendingApproval.command}</pre>
          <div className="tool-card__approval-info" title={pendingApproval.cwd}>
            roda em: {pendingApproval.cwd}
          </div>
          <div className="tool-card__approval-actions">
            <button className="btn btn--sm btn--primary" onClick={() => respondApproval(true)}>
              <Play className="icon" aria-hidden /> Executar
            </button>
            <button className="btn btn--sm btn--ghost" onClick={() => respondApproval(false)}>
              Negar
            </button>
          </div>
        </div>
      )}
      {awaitingQuestion && (
        <div className="tool-card__approval question-card">
          <div className="question-card__text">{pendingQuestion.question}</div>
          {pendingQuestion.options.length > 0 && (
            <div className="question-card__options">
              {pendingQuestion.options.map((opt) => (
                <button key={opt} className="btn btn--sm" onClick={() => respondQuestion(opt)}>
                  {opt}
                </button>
              ))}
            </div>
          )}
          <div className="question-card__free">
            <input
              value={freeAnswer}
              onChange={(e) => setFreeAnswer(e.target.value)}
              placeholder={
                pendingQuestion.options.length ? 'ou digite outra resposta…' : 'Digite a resposta…'
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter' && freeAnswer.trim()) respondQuestion(freeAnswer);
              }}
            />
            <button
              className="btn btn--sm btn--primary"
              disabled={!freeAnswer.trim()}
              onClick={() => respondQuestion(freeAnswer)}
            >
              Responder
            </button>
          </div>
        </div>
      )}
      {open && (
        <div className="tool-card__detail">
          {call.toolName === 'portal_edit_file' ? (
            <>
              <h5>Edição</h5>
              <EditDiff input={(call.input ?? {}) as Record<string, unknown>} />
            </>
          ) : call.toolName === 'portal_write_file' &&
            typeof (call.input as Record<string, unknown> | undefined)?.content === 'string' ? (
            <>
              <h5>Conteúdo</h5>
              <pre>{(call.input as Record<string, string>).content}</pre>
            </>
          ) : (
            <>
              <h5>Entrada</h5>
              <pre>{JSON.stringify(call.input, null, 2)}</pre>
            </>
          )}
          {result && (
            <>
              <h5>{result.ok ? 'Resultado' : 'Erro'}</h5>
              <pre>{checkpoint.content}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

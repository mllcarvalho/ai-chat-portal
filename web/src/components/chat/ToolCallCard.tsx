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
  X,
} from 'lucide-react';
import type { MessagePart } from '@aiportal/shared';
import { useChat } from '../../stores/chatStore';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';
import { Markdown } from '../common/Markdown';

type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;
type ToolResultPart = Extract<MessagePart, { type: 'tool_result' }>;

/** Caminho do arquivo alvo, quando a tool opera em um arquivo. */
function inputPath(call: ToolCallPart): string | undefined {
  const input = (call.input ?? {}) as Record<string, unknown>;
  return typeof input.path === 'string' && input.path.trim() ? input.path.trim() : undefined;
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

  const path = inputPath(call);

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
        <span className="tool-card__name">{call.toolName}</span>
        {path && (
          <span className="tool-card__path" title={path}>
            {path}
          </span>
        )}
        {status}
      </button>
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
              <pre>{result.content}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

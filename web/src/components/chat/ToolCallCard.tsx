import { useState } from 'react';
import type { MessagePart } from '@aiportal/shared';
import { useChat } from '../../stores/chatStore';
import { useUi } from '../../stores/uiStore';

type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;
type ToolResultPart = Extract<MessagePart, { type: 'tool_result' }>;

export function ToolCallCard(props: {
  call: ToolCallPart;
  result?: ToolResultPart;
  running: boolean;
}) {
  const { call, result, running } = props;
  const [open, setOpen] = useState(false);
  const pendingApproval = useChat((s) => s.pendingApproval);
  const respondApproval = useChat((s) => s.respondApproval);
  const hideToolCards = useUi((s) => s.hideToolCards);
  const awaitingApproval = !result && pendingApproval?.callId === call.callId;

  // preferência "ocultar detalhes técnicos": some com os cards, MAS pedidos de
  // aprovação aparecem sempre, e enquanto uma ferramenta roda fica uma linha
  // discreta para a resposta não parecer travada
  if (hideToolCards && !awaitingApproval) {
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
  ) : running ? (
    <span className="tool-card__status tool-card__status--running">
      <span className="spinner" /> executando…
    </span>
  ) : result ? (
    result.ok ? (
      <span className="tool-card__status">✓ {(result.durationMs / 1000).toFixed(1)}s</span>
    ) : (
      <span className="tool-card__status tool-card__status--error">✕ falhou</span>
    )
  ) : (
    <span className="tool-card__status">—</span>
  );

  return (
    <div className="tool-card">
      <button className="tool-card__head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-card__icon">{open ? '▾' : '▸'}</span>
        <span className="tool-card__icon">{call.toolName === 'portal_run_command' ? '＞_' : '⚙'}</span>
        <span className="tool-card__name">{call.toolName}</span>
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
              ▶ Executar
            </button>
            <button className="btn btn--sm btn--ghost" onClick={() => respondApproval(false)}>
              Negar
            </button>
          </div>
        </div>
      )}
      {open && (
        <div className="tool-card__detail">
          <h5>Entrada</h5>
          <pre>{JSON.stringify(call.input, null, 2)}</pre>
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

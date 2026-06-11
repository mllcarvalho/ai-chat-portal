import { useState } from 'react';
import type { MessagePart } from '@aiportal/shared';

type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;
type ToolResultPart = Extract<MessagePart, { type: 'tool_result' }>;

export function ToolCallCard(props: {
  call: ToolCallPart;
  result?: ToolResultPart;
  running: boolean;
}) {
  const { call, result, running } = props;
  const [open, setOpen] = useState(false);

  const status = running ? (
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
        <span className="tool-card__icon">⚙</span>
        <span className="tool-card__name">{call.toolName}</span>
        {status}
      </button>
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

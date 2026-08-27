import { memo, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, History, Paperclip, Pencil, Play, RefreshCw, TriangleAlert } from 'lucide-react';
import type { ChatMessage, MessagePart } from '@aiportal/shared';
import { api } from '../../api/client';
import { useCatalog } from '../../stores/catalogStore';
import { useChat } from '../../stores/chatStore';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';
import { Markdown } from '../common/Markdown';
import { ToolCallCard } from './ToolCallCard';
import { copyText } from '../../lib/compat';

type ToolResultPart = Extract<MessagePart, { type: 'tool_result' }>;

/**
 * "pensando…" com o tempo decorrido: uma tool call grande (um arquivo inteiro)
 * chega de uma vez só no fim da geração, então a tela fica minutos parada. Ver
 * o cronômetro andando é a diferença entre "está trabalhando" e "travou".
 */
function ThinkingRow() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  const label =
    seconds < 10
      ? 'pensando…'
      : seconds < 60
        ? `pensando… (${seconds}s)`
        : `pensando… (${Math.floor(seconds / 60)}min${seconds % 60 ? ` ${seconds % 60}s` : ''})`;
  return (
    <span className="thinking-row">
      <span className="thinking">
        <span />
        <span />
        <span />
      </span>
      <span className="thinking-row__label">{label}</span>
    </span>
  );
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}k`;
}

export function formatCredits(n: number): string {
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

/** "0x", "1x", "0.33x" — credits descontados por requisição do modelo. */
export function formatMultiplier(multiplier: number): string {
  return `${Number(multiplier.toFixed(2))}x`;
}

/** "low" → "Low", "very_high" → "Very High" — faixa de preço do Copilot. */
export function formatPriceCategory(category: string): string {
  return category
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function messageText(message: ChatMessage): string {
  return message.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * memo: durante o streaming a lista inteira re-renderiza a cada token; as
 * mensagens já persistidas têm props estáveis e são puladas na reconciliação.
 */
export const MessageBubble = memo(function MessageBubble(props: {
  message: ChatMessage;
  streaming?: boolean;
  /** Última resposta da conversa (sem stream ativo): habilita o regenerar. */
  isLastAssistant?: boolean;
  /** Ações de editar/copiar/regenerar ficam ocultas enquanto a conversa gera. */
  actionsDisabled?: boolean;
}) {
  const { message, streaming, isLastAssistant, actionsDisabled } = props;
  const models = useCatalog((s) => s.models);
  const isUser = message.role === 'user';

  const copyMessage = () => {
    void copyText(messageText(message)).then(
      () => useUi.getState().toast('Resposta copiada.', 'ok'),
      () => useUi.getState().toast('Não foi possível copiar.', 'error'),
    );
  };

  if (isUser) {
    const text = messageText(message);
    const attachments = message.parts.filter(
      (p): p is Extract<MessagePart, { type: 'attachment' }> => p.type === 'attachment',
    );
    // sessão compartilhada: mensagem assinada por quem enviou (a própria
    // pessoa também vê o nome — todo mundo lê a mesma conversa igual)
    const author = message.author;
    return (
      <div className="msg msg--user">
        <span className="msg__role">
          {author ? (
            <>
              <span
                className="collab-dot"
                style={{ background: author.color ?? 'var(--accent)' }}
              />{' '}
              {author.name}
            </>
          ) : (
            'Você'
          )}
        </span>
        <div className="msg__body">
          {text}
          {attachments.length > 0 && (
            <div className="msg__attachments">
              {attachments.map((att) => (
                <span
                  className="attachment-chip"
                  key={att.name}
                  title={`${att.name} · ${(att.content.length / 1024).toFixed(1)} KB`}
                >
                  <Paperclip className="icon icon--sm" aria-hidden /> {att.name}
                </span>
              ))}
            </div>
          )}
        </div>
        {!actionsDisabled && (
          <div className="msg__actions">
            <button
              className="msg__action"
              title="Editar e reenviar — a conversa é reescrita a partir daqui"
              onClick={() => useUi.getState().seedComposer(text, message.id)}
            >
              <Pencil className="icon icon--sm" aria-hidden /> editar
            </button>
            <button
              className="msg__action"
              title="Desfaz todas as alterações de arquivos feitas desta mensagem em diante"
              onClick={() => {
                const sessionId = useSessions.getState().current?.id;
                if (!sessionId) return;
                void api.restoreFiles(sessionId, message.id).then(
                  ({ reverted, files }) => {
                    useUi.getState().toast(
                      reverted
                        ? `Arquivos restaurados (${files.length}): estado de antes desta mensagem.`
                        : 'Nenhuma alteração de arquivo para desfazer a partir daqui.',
                      reverted ? 'ok' : 'info',
                    );
                    if (reverted) useUi.getState().bumpFilesVersion();
                  },
                  (err: Error) => useUi.getState().toast(err.message, 'error'),
                );
              }}
            >
              <History className="icon icon--sm" aria-hidden /> restaurar arquivos
            </button>
          </div>
        )}
      </div>
    );
  }

  // casa tool_results com seus tool_calls pelo callId
  const resultsById = new Map<string, ToolResultPart>();
  for (const part of message.parts) {
    if (part.type === 'tool_result') resultsById.set(part.callId, part);
  }

  const rendered: JSX.Element[] = [];
  message.parts.forEach((part, i) => {
    const isLast = i === message.parts.length - 1;
    if (part.type === 'text') {
      rendered.push(
        <div key={i} className={streaming && isLast ? 'stream-caret' : undefined}>
          <Markdown text={part.text} />
        </div>,
      );
    } else if (part.type === 'tool_call') {
      rendered.push(
        <ToolCallCard
          key={part.callId}
          call={part}
          result={resultsById.get(part.callId)}
          running={!!streaming && !resultsById.has(part.callId)}
        />,
      );
    }
    // tool_result é renderizado dentro do card do respectivo tool_call
  });

  // o modelo está "pensando" quando não há atividade visível no fim do stream:
  // resposta ainda vazia, ou a última tool terminou e a próxima rodada (texto
  // ou nova tool) ainda não começou — sem isso a resposta parece travada,
  // principalmente com os cards técnicos ocultos
  const lastPart = message.parts[message.parts.length - 1];
  const modelThinking = streaming && (!lastPart || lastPart.type === 'tool_result');

  return (
    <div className="msg msg--assistant">
      <span className="msg__role">Assistente</span>
      <div className="msg__body">
        {rendered}
        {modelThinking && <ThinkingRow />}
        {message.error && (
          <div className="msg__error">
            <TriangleAlert className="icon" aria-hidden /> {message.error.message}
            {isLastAssistant && !streaming && !actionsDisabled && (
              <button
                className="msg__action msg__error-retry"
                title="Reenviar a última mensagem e gerar a resposta de novo"
                onClick={() => {
                  const sessionId = useSessions.getState().current?.id;
                  if (sessionId) useChat.getState().regenerate(sessionId);
                }}
              >
                <RefreshCw className="icon icon--sm" aria-hidden /> tentar novamente
              </button>
            )}
          </div>
        )}
        {!streaming && !actionsDisabled && (
          <div className="msg__actions">
            {messageText(message) && (
              <button className="msg__action" title="Copiar a resposta inteira" onClick={copyMessage}>
                <Copy className="icon icon--sm" aria-hidden /> copiar
              </button>
            )}
            {isLastAssistant && (
              <button
                className="msg__action"
                title="Gerar esta resposta de novo"
                onClick={() => {
                  const sessionId = useSessions.getState().current?.id;
                  if (sessionId) useChat.getState().regenerate(sessionId);
                }}
              >
                <RefreshCw className="icon icon--sm" aria-hidden /> regenerar
              </button>
            )}
            {isLastAssistant && message.finishReason === 'max_rounds' && (
              <button
                className="msg__action msg__action--primary"
                title="A resposta parou no limite de rodadas de ferramentas — pede para o assistente seguir de onde parou"
                onClick={() => void useChat.getState().send('Continue de onde parou.')}
              >
                <Play className="icon icon--sm" aria-hidden /> continuar
              </button>
            )}
          </div>
        )}
        {message.usage && (
          <div
            className="msg__usage"
            title="Tokens enviados ao modelo (entrada, somando todas as rodadas) e gerados (saída) · requisições ao Copilot nesta resposta · AI credits realmente descontados da licença nesta resposta (medidos na cota do Copilot)"
          >
            <ArrowUp className="icon icon--sm" aria-hidden /> {formatTokens(message.usage.inputTokens)} ·{' '}
            <ArrowDown className="icon icon--sm" aria-hidden /> {formatTokens(message.usage.outputTokens)} tokens
            {' · '}
            {message.usage.requests} req
            {(() => {
              const known = models.find((m) => m.id === message.modelId);
              // sem modelId gravado (mensagens antigas), vale o primeiro da lista
              const model = known ?? (message.modelId ? undefined : models[0]);
              // a CLI resolve o alias e devolve o modelo concreto que respondeu
              // (ex.: "claude-opus-5[1m]"), que não está no catálogo de aliases
              // — mostrar esse id cru é mais fiel do que cair no models[0]
              const modelLabel = model?.name ?? message.modelId ?? 'modelo';
              // motores com cobrança própria (CLI) reportam dólares, não
              // credits da licença do Copilot — são unidades diferentes
              if (message.usage.costUsd !== undefined) {
                return (
                  <>
                    {' · '}
                    {modelLabel} · US$ {message.usage.costUsd.toFixed(4)}
                  </>
                );
              }
              // preferência: custo real medido na licença; senão, estimativa
              // pelo multiplicador (modelos antigos que ainda o expõem)
              const credits =
                message.usage.credits ??
                (model?.multiplier !== undefined
                  ? message.usage.requests * model.multiplier
                  : undefined);
              if (credits === undefined) return null;
              return (
                <>
                  {' · '}
                  {modelLabel} · {formatCredits(credits)}{' '}
                  {credits === 1 ? 'credit' : 'credits'}
                </>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
});

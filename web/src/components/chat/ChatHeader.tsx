import { useEffect, useState } from 'react';
import type { SessionMode, TokenUsage } from '@aiportal/shared';
import { useSessions } from '../../stores/sessionsStore';
import { useCatalog } from '../../stores/catalogStore';
import { useUi } from '../../stores/uiStore';
import { Dropdown } from '../common/Dropdown';
import { formatCredits, formatMultiplier, formatPriceCategory, formatTokens } from './MessageBubble';

const MODE_LABEL: Record<SessionMode, string> = {
  ask: 'Ask',
  plan: 'Plan',
  agent: 'Agent',
};

const MODE_DESC: Record<SessionMode, string> = {
  ask: 'Pergunta e resposta, sem ferramentas',
  plan: 'Gera planos; só leitura de arquivos',
  agent: 'Usa ferramentas e MCPs automaticamente',
};

const MODE_COLOR: Record<SessionMode, string> = {
  ask: 'var(--mode-ask)',
  plan: 'var(--mode-plan)',
  agent: 'var(--mode-agent)',
};

export function ChatHeader() {
  const session = useSessions((s) => s.current);
  const patchCurrent = useSessions((s) => s.patchCurrent);
  const setMode = useSessions((s) => s.setMode);
  const models = useCatalog((s) => s.models);
  const agents = useCatalog((s) => s.agents);
  const loadAgents = useCatalog((s) => s.loadAgents);
  const quota = useCatalog((s) => s.quota);
  const quotaError = useCatalog((s) => s.quotaError);
  const loadQuota = useCatalog((s) => s.loadQuota);
  const loadAll = useCatalog((s) => s.loadAll);
  const panel = useUi((s) => s.panel);
  const openPanel = useUi((s) => s.openPanel);
  const closePanel = useUi((s) => s.closePanel);
  const setView = useUi((s) => s.setView);
  const [title, setTitle] = useState(session?.title ?? '');

  useEffect(() => {
    setTitle(session?.title ?? '');
  }, [session?.id, session?.title]);

  useEffect(() => {
    void loadQuota();
  }, [loadQuota]);

  const agent = agents.find((a) => a.id === session?.agentId);

  // presets podem ser registrados depois do boot (ex: BMAD) — recarrega o catálogo
  useEffect(() => {
    if (session?.agentId && !agent) void loadAgents();
  }, [session?.agentId, agent, loadAgents]);

  if (!session) return null;

  const model = models.find((m) => m.id === session.modelId) ?? models[0];

  // total da conversa: soma o usage de todas as respostas
  const totals = session.messages.reduce<TokenUsage>(
    (acc, m) => {
      if (m.usage) {
        acc.inputTokens += m.usage.inputTokens;
        acc.outputTokens += m.usage.outputTokens;
        acc.requests += m.usage.requests;
      }
      return acc;
    },
    { inputTokens: 0, outputTokens: 0, requests: 0 },
  );
  const totalTokens = totals.inputTokens + totals.outputTokens;
  const premium = quota?.premium;
  const creditsUsed =
    premium && !premium.unlimited ? Math.max(0, premium.entitlement - premium.remaining) : undefined;
  // credits da conversa: soma o custo real medido por resposta; para mensagens
  // antigas sem medição, estima por requisições × multiplicador (quando havia)
  const conversationCredits = session.messages.reduce<number | undefined>((acc, m) => {
    if (!m.usage) return acc;
    if (m.usage.credits !== undefined) return (acc ?? 0) + m.usage.credits;
    const msgModel = models.find((x) => x.id === m.modelId) ?? models[0];
    if (msgModel?.multiplier === undefined) return acc;
    return (acc ?? 0) + m.usage.requests * msgModel.multiplier;
  }, undefined);

  return (
    <header className="chat-header">
      <input
        className="chat-header__title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => {
          if (title.trim() && title !== session.title) void patchCurrent({ title: title.trim() });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        title="Renomear conversa"
      />
      <span className="chat-header__spacer" />

      {/* Modo: ask / plan / agent */}
      <Dropdown
        trigger={(_, toggle) => (
          <button className="pill-btn pill-btn--active" onClick={toggle} title={MODE_DESC[session.mode]}>
            <span className="mode-dot" style={{ background: MODE_COLOR[session.mode] }} />
            {MODE_LABEL[session.mode]}
          </button>
        )}
      >
        {(close) =>
          (Object.keys(MODE_LABEL) as SessionMode[]).map((mode) => (
            <button
              key={mode}
              className={`dropdown__item${session.mode === mode ? ' dropdown__item--sel' : ''}`}
              onClick={() => {
                void setMode(mode);
                close();
              }}
            >
              <span className="mode-dot" style={{ background: MODE_COLOR[mode] }} />
              <span>
                {MODE_LABEL[mode]}
                <span className="dropdown__item-sub">{MODE_DESC[mode]}</span>
              </span>
            </button>
          ))
        }
      </Dropdown>

      {/* Modelo */}
      <Dropdown
        trigger={(_, toggle) => (
          <button className="pill-btn" onClick={toggle} title="Modelo do Copilot">
            ◆ {model?.name ?? 'modelo'}
            {model?.multiplier !== undefined
              ? ` · ${formatMultiplier(model.multiplier)}`
              : model?.priceCategory
                ? ` · ${formatPriceCategory(model.priceCategory)}`
                : ''}
          </button>
        )}
      >
        {(close) =>
          models.map((m) => (
            <button
              key={m.id}
              className={`dropdown__item${m.id === (session.modelId ?? model?.id) ? ' dropdown__item--sel' : ''}`}
              onClick={() => {
                void patchCurrent({ modelId: m.id });
                close();
              }}
            >
              <span>
                {m.name}
                {m.multiplier !== undefined ? (
                  <span
                    className={`model-mult${m.multiplier === 0 ? ' model-mult--free' : ''}`}
                    title={
                      m.multiplier === 0
                        ? 'Incluído no plano — não desconta AI credits'
                        : `Desconta ${formatMultiplier(m.multiplier)} AI credits por requisição`
                    }
                  >
                    {formatMultiplier(m.multiplier)}
                  </span>
                ) : m.priceCategory ? (
                  <span
                    className="model-mult"
                    title="Faixa de preço do Copilot — o custo em AI credits varia pelos tokens usados"
                  >
                    {formatPriceCategory(m.priceCategory)}
                  </span>
                ) : null}
                <span className="dropdown__item-sub">
                  {m.family} · {Math.round(m.maxInputTokens / 1000)}k tokens
                </span>
              </span>
            </button>
          ))
        }
      </Dropdown>

      {/* Agente */}
      <Dropdown
        trigger={(_, toggle) => (
          <button className="pill-btn" onClick={toggle} title="Agente (preset de instruções)">
            {agent ? `${agent.icon ?? '🤖'} ${agent.name}` : '🤖 Sem agente'}
          </button>
        )}
      >
        {(close) => (
          <>
            <button
              className={`dropdown__item${!session.agentId ? ' dropdown__item--sel' : ''}`}
              onClick={() => {
                void patchCurrent({ agentId: '' });
                close();
              }}
            >
              Sem agente
            </button>
            {agents.map((a) => (
              <button
                key={a.id}
                className={`dropdown__item${a.id === session.agentId ? ' dropdown__item--sel' : ''}`}
                onClick={() => {
                  void patchCurrent({
                    agentId: a.id,
                    ...(a.defaultModelId ? { modelId: a.defaultModelId } : {}),
                    ...(a.defaultMode ? { mode: a.defaultMode } : {}),
                  });
                  close();
                }}
              >
                <span>
                  {a.icon ?? '🤖'} {a.name}
                  {a.description && <span className="dropdown__item-sub">{a.description}</span>}
                </span>
              </button>
            ))}
            <div className="dropdown__sep" />
            <button
              className="dropdown__item"
              onClick={() => {
                setView('agents');
                close();
              }}
            >
              Gerenciar agentes…
            </button>
          </>
        )}
      </Dropdown>

      {/* Uso de tokens + AI credits */}
      <Dropdown
        trigger={(_, toggle) => (
          <button
            className="pill-btn"
            onClick={toggle}
            title="Uso de tokens da conversa e AI credits do Copilot"
          >
            ⚡ {totalTokens ? `${formatTokens(totalTokens)} tok` : 'Uso'}
            {creditsUsed !== undefined && premium
              ? ` · ${formatCredits(creditsUsed)}/${premium.entitlement}`
              : ''}
          </button>
        )}
      >
        {() => (
          <div className="usage-pop">
            <div className="usage-pop__section">
              <div className="dropdown__label">Esta conversa</div>
              <div className="usage-pop__row">
                <span>Tokens de entrada</span>
                <strong>{formatTokens(totals.inputTokens)}</strong>
              </div>
              <div className="usage-pop__row">
                <span>Tokens de saída</span>
                <strong>{formatTokens(totals.outputTokens)}</strong>
              </div>
              <div className="usage-pop__row">
                <span>Requisições ao Copilot</span>
                <strong>{totals.requests}</strong>
              </div>
              {conversationCredits !== undefined && (
                <div className="usage-pop__row">
                  <span>AI credits da conversa</span>
                  <strong>{formatCredits(conversationCredits)}</strong>
                </div>
              )}
            </div>
            <div className="dropdown__sep" />
            <div className="usage-pop__section">
              <div className="dropdown__label">AI credits (premium requests)</div>
              {premium ? (
                premium.unlimited ? (
                  <div className="usage-pop__row">
                    <span>Plano {quota?.plan ?? '—'}</span>
                    <strong>ilimitado</strong>
                  </div>
                ) : (
                  <>
                    <div className="usage-pop__row">
                      <span>Usados</span>
                      <strong>
                        {formatCredits(creditsUsed ?? 0)} /{' '}
                        {premium.entitlement.toLocaleString('pt-BR')}
                      </strong>
                    </div>
                    <div className="usage-pop__bar" aria-hidden>
                      <span
                        style={{
                          width: `${Math.min(100, Math.max(0, 100 - premium.percentRemaining))}%`,
                        }}
                      />
                    </div>
                    <div className="usage-pop__row usage-pop__row--dim">
                      <span>Restantes</span>
                      <span>
                        {premium.remaining.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}
                      </span>
                    </div>
                    {quota?.resetDate && (
                      <div className="usage-pop__row usage-pop__row--dim">
                        <span>Renova em</span>
                        <span>{quota.resetDate}</span>
                      </div>
                    )}
                    {premium.overageCount > 0 && (
                      <div className="usage-pop__row usage-pop__row--dim">
                        <span>Excedente usado</span>
                        <span>{premium.overageCount}</span>
                      </div>
                    )}
                  </>
                )
              ) : (
                <div className="usage-pop__row usage-pop__row--dim">
                  <span>
                    {quota === null
                      ? (quotaError ?? 'Indisponível no momento')
                      : 'Carregando…'}
                  </span>
                </div>
              )}
              <button
                className="dropdown__item"
                onClick={() => {
                  // recarrega modelos junto: os multiplicadores vêm de /api/models
                  void loadQuota(true);
                  void loadAll();
                }}
              >
                ↻ Atualizar credits
              </button>
            </div>
            <div className="usage-pop__note">
              Cada rodada de ferramentas é 1 requisição. Os AI credits por resposta são medidos
              direto na licença (saldo antes − depois); o preço varia pelo modelo e pelos tokens
              usados.
            </div>
          </div>
        )}
      </Dropdown>

      <button
        className={`pill-btn${panel.kind === 'files' ? ' pill-btn--active' : ''}`}
        onClick={() => (panel.kind === 'files' ? closePanel() : openPanel({ kind: 'files' }))}
        title={
          session.projectId
            ? 'Arquivos do projeto (painel lateral)'
            : 'Arquivos do workspace desta conversa (painel lateral)'
        }
      >
        📄 Arquivos
      </button>
    </header>
  );
}

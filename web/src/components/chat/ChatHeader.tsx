import { useEffect, useState } from 'react';
import { Bot, Columns2, Cpu, Diamond, Download, FileText, Mail, RefreshCw, Share2, Zap } from 'lucide-react';
import { AgentIcon } from '../common/AgentIcon';
import type {
  ProviderCapabilities,
  ProviderId,
  ProviderInfo,
  SessionMode,
  TokenUsage,
} from '@aiportal/shared';
import { isBmadAsset, slugifyCommand } from '@aiportal/shared';
import { api } from '../../api/client';
import { useSessions } from '../../stores/sessionsStore';
import { useCatalog } from '../../stores/catalogStore';
import { usePreview } from '../../stores/previewStore';
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

/** Nome do motor exibido enquanto o servidor ainda não respondeu /api/providers. */
const PROVIDER_LABEL: Record<ProviderId, string> = {
  copilot: 'GitHub Copilot',
  'claude-code': 'Claude Code',
  devin: 'Devin',
};

const PROVIDER_ORDER: ProviderId[] = ['copilot', 'claude-code', 'devin'];

/**
 * Linha do seletor de motor. `capabilities` é opcional porque a lista inclui
 * motores que o servidor ainda não descreveu (primeiro render, ou servidor
 * com build antiga sem /api/providers).
 */
type ProviderRow = Pick<ProviderInfo, 'id' | 'label' | 'available'> & {
  detail?: string;
  capabilities?: ProviderCapabilities;
};

/** Janela de contexto legível: "200k" até 1 milhão, "1M" daí para cima. */
function formatContextWindow(tokens: number): string {
  return tokens >= 1_000_000
    ? `${Math.round((tokens / 1_000_000) * 10) / 10}M`
    : `${Math.round(tokens / 1000)}k`;
}

export function ChatHeader() {
  const session = useSessions((s) => s.current);
  const patchCurrent = useSessions((s) => s.patchCurrent);
  const setMode = useSessions((s) => s.setMode);
  const models = useCatalog((s) => s.models);
  const providers = useCatalog((s) => s.providers);
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
  const toast = useUi((s) => s.toast);
  const previewEnabled = usePreview((s) => s.enabled);
  const togglePreview = usePreview((s) => s.toggle);
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

  // o motor decide o catálogo: "Claude Opus" pelo Copilot e pelo Claude Code
  // são caminhos diferentes (cobrança, ferramentas, loop), então o id do
  // modelo só é único dentro de um motor — a busca casa os dois campos
  const sessionProvider = session.provider ?? 'copilot';
  // servidor com build antiga devolve modelos sem `provider`: sem o fallback a
  // lista fica vazia e o usuário perde o seletor de modelo até recarregar
  const providerModels = models.filter((m) => (m.provider ?? 'copilot') === sessionProvider);
  const model = providerModels.find((m) => m.id === session.modelId) ?? providerModels[0];
  // sempre lista todos os motores conhecidos, mesmo os que a máquina não tem:
  // ver "Claude Code — CLI não encontrada" explica mais do que a ausência dele
  const providerList: ProviderRow[] = PROVIDER_ORDER.map(
    (id) =>
      providers.find((p) => p.id === id) ?? {
        id,
        label: PROVIDER_LABEL[id],
        available: false,
        detail: 'Verificando…',
      },
  );
  const currentProvider = providerList.find((p) => p.id === sessionProvider);
  // BMAD manda o agente usar as ferramentas do portal pelo nome; onde elas não
  // existem a persona é injetada mas os workflows não rodam. Avisa em vez de
  // deixar o usuário descobrir com um workflow travado no meio.
  const usesBmad =
    (!!session.agentId && isBmadAsset(session.agentId)) ||
    session.activeSkillIds.some(isBmadAsset);
  const bmadBroken = usesBmad && currentProvider?.capabilities?.bmad === false;

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

  // baixa a conversa inteira como .md legível (mesmo artefato do envio por email)
  const exportConversation = async () => {
    try {
      await api.exportSessionMarkdown(
        session.id,
        `${slugifyCommand(session.title) || 'conversa'}.md`,
      );
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const emailConversation = async () => {
    try {
      const result = await api.shareByEmail('session', session.id);
      toast(
        result.mode === 'manual'
          ? 'Sem cliente de email com anexo automático — o arquivo foi salvo e a pasta aberta: anexe no rascunho que abriu.'
          : 'Email aberto com o anexo — é só endereçar e enviar.',
        result.mode === 'manual' ? 'info' : 'ok',
      );
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

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

      {/* Motor: quem responde a conversa (define o catálogo de modelos abaixo) */}
      <Dropdown
        trigger={(_, toggle) => (
          <button
            className="pill-btn"
            onClick={toggle}
            title={
              bmadBroken
                ? `${currentProvider?.label}: os workflows do BMAD ainda não rodam neste motor — ` +
                  'a persona entra no contexto, mas as ferramentas do portal que ela usa ' +
                  '(bmad_read_file, portal_write_file…) só existem no GitHub Copilot.'
                : currentProvider?.detail
                  ? `${currentProvider.label} — ${currentProvider.detail}`
                  : 'Motor que responde a conversa'
            }
          >
            <Cpu
              className="icon icon--sm"
              aria-hidden
              style={{ color: bmadBroken ? 'var(--warn, #b45309)' : '#7c3aed' }}
            />{' '}
            {currentProvider?.label ?? 'motor'}
            {bmadBroken ? ' ⚠' : ''}
          </button>
        )}
      >
        {(close) =>
          providerList.map((p) => (
            <button
              key={p.id}
              className={`dropdown__item${p.id === sessionProvider ? ' dropdown__item--sel' : ''}${p.available ? '' : ' dropdown__item--disabled'}`}
              disabled={!p.available}
              title={p.detail}
              onClick={() => {
                if (p.id === sessionProvider) return close();
                // catálogos são disjuntos: o modelo atual não existe no motor
                // novo, então cai no primeiro dele em vez de virar um id inválido
                const first = models.find((m) => m.provider === p.id);
                void patchCurrent({
                  provider: p.id,
                  // string vazia limpa o campo no servidor (undefined some do JSON)
                  modelId: first ? first.id : '',
                });
                close();
              }}
            >
              <span>
                {p.label}
                <span className="dropdown__item-sub">
                  {usesBmad && p.capabilities?.bmad === false
                    ? 'Workflows do BMAD ainda não rodam aqui'
                    : (p.detail ?? '')}
                </span>
              </span>
            </button>
          ))
        }
      </Dropdown>

      {/* Modelo (só os do motor selecionado) */}
      <Dropdown
        trigger={(_, toggle) => (
          <button className="pill-btn" onClick={toggle} title="Modelo do motor selecionado">
            <Diamond className="icon icon--sm" aria-hidden style={{ color: '#2563eb' }} />{' '}
            {model?.name ?? 'modelo'}
            {model?.multiplier !== undefined
              ? ` · ${formatMultiplier(model.multiplier)}`
              : model?.priceCategory
                ? ` · ${formatPriceCategory(model.priceCategory)}`
                : ''}
          </button>
        )}
      >
        {(close) =>
          providerModels.map((m) => (
            <button
              key={m.id}
              className={`dropdown__item${m.id === model?.id ? ' dropdown__item--sel' : ''}${m.canSend === false ? ' dropdown__item--disabled' : ''}`}
              disabled={m.canSend === false}
              title={
                m.canSend === false
                  ? 'Sem acesso a este modelo — habilite-o nas configurações do Copilot no VS Code'
                  : undefined
              }
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
                        ? 'Incluído no plano — usar este modelo não gasta AI credits'
                        : `Cada chamada a este modelo gasta ${formatMultiplier(m.multiplier)} do saldo de AI credits (uma resposta pode fazer mais de uma chamada)`
                    }
                  >
                    {formatMultiplier(m.multiplier)}
                  </span>
                ) : m.priceCategory ? (
                  <span
                    className="model-mult"
                    title="Faixa de preço do Copilot — o gasto de AI credits varia com o tamanho das mensagens e respostas"
                  >
                    {formatPriceCategory(m.priceCategory)}
                  </span>
                ) : null}
                <span className="dropdown__item-sub">
                  {m.family} · {formatContextWindow(m.maxInputTokens)} tokens
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
            {agent ? (
              <>
                <AgentIcon icon={agent.icon} /> {agent.name}
              </>
            ) : (
              <>
                <Bot className="icon" aria-hidden /> Sem agente
              </>
            )}
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
            {agents
              .filter((a) => a.enabled !== false || a.id === session.agentId)
              .map((a) => (
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
                  <AgentIcon icon={a.icon} /> {a.name}
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
            title="Quanto esta conversa já consumiu e quanto ainda resta do seu pacote mensal de AI credits do Copilot"
          >
            <Zap className="icon" aria-hidden style={{ color: '#dd9a00' }} fill="currentColor" />{' '}
            {totalTokens ? `${formatTokens(totalTokens)} tok` : 'Uso'}
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
                <span title="Volume de texto que o modelo LEU nesta conversa (suas mensagens, arquivos e histórico) — tokens são os pedacinhos de texto que ele processa">
                  Tokens de entrada
                </span>
                <strong>{formatTokens(totals.inputTokens)}</strong>
              </div>
              <div className="usage-pop__row">
                <span title="Volume de texto que o modelo ESCREVEU nesta conversa (as respostas)">
                  Tokens de saída
                </span>
                <strong>{formatTokens(totals.outputTokens)}</strong>
              </div>
              <div className="usage-pop__row">
                <span title="Quantas vezes o modelo foi acionado nesta conversa — uma resposta que usa ferramentas pode fazer várias chamadas">
                  Chamadas ao modelo
                </span>
                <strong>{totals.requests}</strong>
              </div>
              {conversationCredits !== undefined && (
                <div className="usage-pop__row">
                  <span title="Quanto esta conversa já gastou do seu pacote mensal de AI credits">
                    AI credits da conversa
                  </span>
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
                <RefreshCw className="icon" aria-hidden /> Atualizar credits
              </button>
            </div>
            <div className="usage-pop__note">
              AI credits são a "moeda" do plano do Copilot: cada resposta gasta um pouco do pacote
              mensal, e o gasto varia com o modelo escolhido e o tamanho da conversa. O valor
              mostrado é medido direto na sua licença (saldo antes − depois de cada resposta).
            </div>
          </div>
        )}
      </Dropdown>

      {/* Exportar / compartilhar a conversa */}
      <Dropdown
        trigger={(_, toggle) => (
          <button
            className="pill-btn"
            onClick={toggle}
            title="Exportar ou compartilhar esta conversa"
            aria-label="Compartilhar"
          >
            <Share2 className="icon" aria-hidden style={{ color: '#0d9488' }} />
          </button>
        )}
      >
        {(close) => (
          <>
            <button
              className="dropdown__item"
              onClick={() => {
                void exportConversation();
                close();
              }}
            >
              <Download className="icon" aria-hidden /> Exportar conversa (.md)
            </button>
            <button
              className="dropdown__item"
              onClick={() => {
                void emailConversation();
                close();
              }}
            >
              <Mail className="icon" aria-hidden /> Enviar por e-mail
            </button>
          </>
        )}
      </Dropdown>

      <button
        className={`pill-btn${previewEnabled ? ' pill-btn--active' : ''}`}
        onClick={() => {
          // ligar o preview sem o painel de arquivos aberto não teria de onde abrir abas
          if (!previewEnabled && panel.kind !== 'files') openPanel({ kind: 'files' });
          togglePreview();
        }}
        title="Modo preview: abas de arquivos ao lado do chat — clique num arquivo do painel Arquivos para abrir aqui"
        aria-label="Preview"
      >
        <Columns2 className="icon" aria-hidden style={{ color: '#7c3aed' }} />
      </button>

      <button
        className={`pill-btn${panel.kind === 'files' ? ' pill-btn--active' : ''}`}
        onClick={() => (panel.kind === 'files' ? closePanel() : openPanel({ kind: 'files' }))}
        title={
          session.projectId
            ? 'Arquivos do projeto (painel lateral)'
            : 'Arquivos do workspace desta conversa (painel lateral)'
        }
        aria-label="Arquivos"
      >
        <FileText className="icon" aria-hidden style={{ color: '#b45309' }} />
      </button>
    </header>
  );
}

import { useMemo, useState } from 'react';
import { useCatalog } from '../../stores/catalogStore';
import { useChat } from '../../stores/chatStore';
import { useSessions } from '../../stores/sessionsStore';
import { Modal } from '../common/Modal';

/**
 * Ações rápidas do BMAD para o time de produto: botões que disparam as
 * principais skills sem digitar no chat. Dois tipos:
 *  - run: envia o comando na hora — a skill trabalha com o contexto da conversa;
 *  - input: abre um mini-modal para complementar (tema, ideia…) antes de enviar.
 *    Deixar o campo vazio também vale: roda só com o contexto.
 * Só aparecem as ações cuja skill está de fato instalada no catálogo. Ações com
 * `persona` trocam a conversa para o agente BMAD certo antes de rodar (se ele
 * estiver habilitado); sem persona, roda com o agente atual da conversa.
 */

interface BmadAction {
  /** Comando da skill (sem a barra). */
  command: string;
  label: string;
  icon: string;
  /** Tooltip explicando o que a ação faz. */
  hint: string;
  kind: 'run' | 'input';
  /** Persona BMAD dona da ação (sufixo do preset bmad-global-bmad-agent-…). */
  persona?: 'analyst' | 'architect' | 'pm' | 'ux-designer' | 'dev' | 'tech-writer';
  /** Complemento fixo enviado junto (kind run). */
  args?: string;
  /** Pergunta e exemplo do campo (kind input). */
  inputLabel?: string;
  placeholder?: string;
}

const GROUPS: { title: string; actions: BmadAction[] }[] = [
  {
    title: 'Descobrir',
    actions: [
      {
        command: 'bmad-brainstorming',
        persona: 'analyst',
        label: 'Brainstorming',
        icon: '💡',
        hint: 'Sessão de ideação facilitada, com técnicas criativas',
        kind: 'input',
        inputLabel: 'Sobre o que vamos idear?',
        placeholder: 'ex: como reduzir o churn dos clientes PJ',
      },
      {
        command: 'bmad-market-research',
        persona: 'analyst',
        label: 'Pesquisa de mercado',
        icon: '🔎',
        hint: 'Pesquisa de concorrência e clientes',
        kind: 'input',
        inputLabel: 'Qual mercado ou concorrência pesquisar?',
        placeholder: 'ex: apps de gestão financeira PF no Brasil',
      },
      {
        command: 'bmad-domain-research',
        persona: 'analyst',
        label: 'Pesquisa de domínio',
        icon: '🌐',
        hint: 'Pesquisa de um domínio ou indústria',
        kind: 'input',
        inputLabel: 'Qual domínio ou indústria pesquisar?',
        placeholder: 'ex: crédito consignado, open finance',
      },
      {
        command: 'bmad-technical-research',
        persona: 'architect',
        label: 'Pesquisa técnica',
        icon: '🧪',
        hint: 'Pesquisa de tecnologias e arquitetura',
        kind: 'input',
        inputLabel: 'Qual tecnologia ou questão técnica pesquisar?',
        placeholder: 'ex: opções de motor de regras para PJ',
      },
    ],
  },
  {
    title: 'Definir',
    actions: [
      {
        command: 'bmad-product-brief',
        persona: 'analyst',
        label: 'Product Brief',
        icon: '📋',
        hint: 'Cria (ou atualiza) o brief do produto',
        kind: 'input',
        inputLabel: 'Descreva a ideia ou o produto',
        placeholder: 'ex: portal de autoatendimento para renegociação de dívidas',
      },
      {
        command: 'bmad-prd',
        persona: 'pm',
        label: 'PRD',
        icon: '📄',
        hint: 'Cria ou atualiza o PRD (usa o brief/contexto se existir)',
        kind: 'input',
        inputLabel: 'O que o PRD deve cobrir?',
        placeholder: 'ex: criar o PRD a partir do brief desta conversa',
      },
      {
        command: 'bmad-prfaq',
        persona: 'pm',
        label: 'PRFAQ',
        icon: '📰',
        hint: 'Working backwards: press release + FAQ do conceito',
        kind: 'input',
        inputLabel: 'Qual conceito vamos desafiar?',
        placeholder: 'ex: cartão de crédito por assinatura',
      },
      {
        command: 'bmad-ux',
        persona: 'ux-designer',
        label: 'UX Design',
        icon: '🎨',
        hint: 'Planeja padrões de UX e especificações de design',
        kind: 'input',
        inputLabel: 'Qual produto ou fluxo vamos desenhar?',
        placeholder: 'ex: onboarding do app, fluxo de contratação',
      },
    ],
  },
  {
    title: 'Validar',
    actions: [
      {
        command: 'bmad-prd',
        persona: 'pm',
        label: 'Validar PRD',
        icon: '✅',
        hint: 'Valida o PRD desta conversa ou dos arquivos do projeto',
        kind: 'run',
        args: 'Valide o PRD já produzido nesta conversa ou nos arquivos do projeto.',
      },
      {
        command: 'bmad-review-adversarial-general',
        label: 'Revisão crítica',
        icon: '😈',
        hint: 'Revisão cética do que foi produzido, com relatório de achados',
        kind: 'run',
      },
      {
        command: 'bmad-advanced-elicitation',
        label: 'Refinar resposta',
        icon: '✨',
        hint: 'Força o assistente a reconsiderar e melhorar a última resposta',
        kind: 'run',
      },
    ],
  },
  {
    title: 'Planejar',
    actions: [
      {
        command: 'bmad-create-epics-and-stories',
        persona: 'pm',
        label: 'Épicos e histórias',
        icon: '🧩',
        hint: 'Quebra os requisitos do PRD em épicos e user stories',
        kind: 'run',
      },
      {
        command: 'bmad-check-implementation-readiness',
        persona: 'pm',
        label: 'Pronto p/ implementar?',
        icon: '🚦',
        hint: 'Confere se PRD, UX, arquitetura e épicos estão completos',
        kind: 'run',
      },
    ],
  },
  {
    title: 'Mais',
    actions: [
      {
        command: 'bmad-help',
        label: 'O que fazer agora?',
        icon: '❓',
        hint: 'Analisa onde a conversa está e recomenda o próximo passo BMAD',
        kind: 'run',
      },
      {
        command: 'bmad-party-mode',
        label: 'Mesa redonda',
        icon: '🎭',
        hint: 'Discussão em grupo entre as personas BMAD',
        kind: 'run',
      },
    ],
  },
];

const COLLAPSED_KEY = 'aiportal.bmadActionsCollapsed';

export function BmadActions() {
  const skills = useCatalog((s) => s.skills);
  const agents = useCatalog((s) => s.agents);
  const send = useChat((s) => s.send);
  const isStreaming = useChat((s) => s.isStreaming);
  const session = useSessions((s) => s.current);
  const patchCurrent = useSessions((s) => s.patchCurrent);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSED_KEY) === '1',
  );
  const [pending, setPending] = useState<BmadAction>();
  const [input, setInput] = useState('');

  // só ações cuja skill existe de fato (BMAD instalado e comando disponível)
  const available = useMemo(() => {
    const commands = new Set(skills.filter((s) => s.command).map((s) => s.command));
    return GROUPS.map((g) => ({
      ...g,
      actions: g.actions.filter((a) => commands.has(a.command)),
    })).filter((g) => g.actions.length > 0);
  }, [skills]);

  if (!session || available.length === 0) return null;

  const toggle = () => {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '0' : '1');
    setCollapsed(!collapsed);
  };

  // preset da persona dona da ação — só vale se estiver habilitado nas Configurações
  const presetFor = (action: BmadAction) => {
    if (!action.persona) return undefined;
    const preset = agents.find((a) => a.id === `bmad-global-bmad-agent-${action.persona}`);
    return preset && preset.enabled !== false ? preset : undefined;
  };

  const run = async (action: BmadAction, complement?: string) => {
    // troca a conversa para a persona certa ANTES de enviar (o servidor lê o
    // agente da sessão na hora do chat); se falhar, roda com o agente atual
    const preset = presetFor(action);
    if (preset && session.agentId !== preset.id) {
      try {
        await patchCurrent({
          agentId: preset.id,
          ...(preset.defaultModelId ? { modelId: preset.defaultModelId } : {}),
          ...(preset.defaultMode ? { mode: preset.defaultMode } : {}),
        });
      } catch {
        // sem bloquear a ação
      }
    }
    const rest = (complement ?? action.args ?? '').trim();
    void send(`/${action.command}${rest ? ` ${rest}` : ''}`);
  };

  const onChipClick = (action: BmadAction) => {
    if (isStreaming) return;
    if (action.kind === 'run') {
      void run(action);
    } else {
      setInput('');
      setPending(action);
    }
  };

  const confirmPending = () => {
    if (!pending) return;
    void run(pending, input);
    setPending(undefined);
  };

  return (
    <div className="bmad-deck-wrap">
      <div className={`bmad-deck${collapsed ? ' bmad-deck--collapsed' : ''}`}>
        <button
          className="bmad-deck__header"
          onClick={toggle}
          title={collapsed ? 'Mostrar ações BMAD' : 'Ocultar ações BMAD'}
        >
          <span className="bmad-deck__brand">🅱️ Ações BMAD</span>
          <span className="bmad-deck__hint">
            {collapsed ? 'Descobrir · Definir · Validar · Planejar' : 'fluxo do time de produto'}
          </span>
          <span className="bmad-deck__caret">{collapsed ? '▸' : '▾'}</span>
        </button>
        {!collapsed && (
          <div className="bmad-deck__rows">
            {available.map((group) => (
              <div className="bmad-deck__row" key={group.title}>
                <span className="bmad-deck__row-title">{group.title}</span>
                <span className="bmad-deck__chips">
                  {group.actions.map((action) => {
                    const preset = presetFor(action);
                    return (
                      <button
                        key={`${action.command}-${action.label}`}
                        className="bmad-chip"
                        title={preset ? `${action.hint} · com ${preset.name}` : action.hint}
                        disabled={isStreaming}
                        onClick={() => onChipClick(action)}
                      >
                        {action.icon} {action.label}
                      </button>
                    );
                  })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {pending && (
        <Modal
          title={`${pending.icon} ${pending.label}`}
          onClose={() => setPending(undefined)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setPending(undefined)}>
                Cancelar
              </button>
              <button className="btn btn--primary" onClick={confirmPending}>
                {input.trim() ? 'Executar' : 'Executar com o contexto da conversa'}
              </button>
            </>
          }
        >
          <div className="field">
            <label>{pending.inputLabel}</label>
            <textarea
              autoFocus
              rows={3}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  confirmPending();
                }
              }}
              placeholder={pending.placeholder}
            />
          </div>
          <p style={{ color: 'var(--text-dim)', fontSize: 12.5, margin: 0 }}>
            {pending.hint}. Pode deixar em branco: a skill usa o que já está na conversa.
          </p>
        </Modal>
      )}
    </div>
  );
}

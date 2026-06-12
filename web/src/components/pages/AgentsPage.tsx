import { useEffect, useState } from 'react';
import type { AgentPreset, SessionMode, VsCodeAgent } from '@aiportal/shared';
import { api } from '../../api/client';
import { useCatalog } from '../../stores/catalogStore';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';
import { formatMultiplier } from '../chat/MessageBubble';
import { Select } from '../common/Select';
import { EmptyState, PageShell, Panel } from './PageShell';

interface Draft {
  id?: string;
  name: string;
  icon: string;
  description: string;
  instructions: string;
  defaultModelId: string;
  defaultMode: '' | SessionMode;
}

const EMPTY: Draft = {
  name: '',
  icon: '🤖',
  description: '',
  instructions: '',
  defaultModelId: '',
  defaultMode: '',
};

export function AgentsPage() {
  const agents = useCatalog((s) => s.agents);
  const models = useCatalog((s) => s.models);
  const loadAgents = useCatalog((s) => s.loadAgents);
  const newSession = useSessions((s) => s.newSession);
  const session = useSessions((s) => s.current);
  const viewProjectId = useSessions((s) => s.viewProjectId);
  const setView = useUi((s) => s.setView);
  const toast = useUi((s) => s.toast);
  const confirm = useUi((s) => s.confirm);
  // conversa rápida nasce no projeto aberto (se houver)
  const contextProjectId = session?.projectId ?? viewProjectId ?? null;
  const [draft, setDraft] = useState<Draft | undefined>();
  const [busy, setBusy] = useState(false);
  const [vsAgents, setVsAgents] = useState<VsCodeAgent[]>([]);

  useEffect(() => {
    void loadAgents();
    void api.listVsCodeAgents().then(setVsAgents).catch(() => setVsAgents([]));
  }, [loadAgents]);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const payload: Partial<AgentPreset> = {
        name: draft.name.trim(),
        icon: draft.icon || undefined,
        description: draft.description.trim() || undefined,
        instructions: draft.instructions,
        defaultModelId: draft.defaultModelId || undefined,
        defaultMode: draft.defaultMode || undefined,
      };
      if (draft.id) await api.patchAgent(draft.id, payload);
      else await api.createAgent(payload);
      toast('Agente salvo.', 'ok');
      setDraft(undefined);
      await loadAgents();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const importVsAgent = (vs: VsCodeAgent) => {
    setDraft({
      name: vs.name,
      icon: '🧩',
      description:
        vs.description ?? `Importado do VS Code (${vs.source === 'project' ? 'repo' : 'perfil'})`,
      instructions: vs.instructions,
      defaultModelId: '',
      defaultMode: '',
    });
  };

  return (
    <PageShell
      icon="🤖"
      title="Agentes"
      subtitle="Presets de instruções + modelo + modo que você aplica a uma conversa."
      actions={
        <button className="btn btn--primary" onClick={() => setDraft({ ...EMPTY })}>
          ＋ Novo agente
        </button>
      }
    >
      <div className="page-cols">
        <Panel title="Meus agentes" count={agents.length}>
          {agents.length === 0 && (
            <EmptyState
              icon="🤖"
              title="Nenhum agente ainda"
              hint="Crie um preset de instruções ou importe um chat mode do VS Code abaixo."
              action={
                <button className="btn btn--primary" onClick={() => setDraft({ ...EMPTY })}>
                  ＋ Criar primeiro agente
                </button>
              }
            />
          )}
          {agents.map((agent) => (
            <button
              className={`page-list-item${draft?.id === agent.id ? ' page-list-item--active' : ''}`}
              key={agent.id}
              onClick={() =>
                setDraft({
                  id: agent.id,
                  name: agent.name,
                  icon: agent.icon ?? '🤖',
                  description: agent.description ?? '',
                  instructions: agent.instructions,
                  defaultModelId: agent.defaultModelId ?? '',
                  defaultMode: agent.defaultMode ?? '',
                })
              }
            >
              <span className="item-card__name">
                {agent.icon ?? '🤖'} {agent.name}
              </span>
              <span className="item-card__desc">
                {agent.description || agent.instructions || '—'}
              </span>
              <span className="page-list-item__actions">
                <span
                  role="button"
                  className="mini-btn"
                  title="Nova conversa com este agente"
                  onClick={(e) => {
                    e.stopPropagation();
                    setView('chat');
                    void newSession(contextProjectId, { agentId: agent.id });
                  }}
                >
                  Conversar →
                </span>
                <span
                  role="button"
                  className="mini-btn mini-btn--danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    void confirm({
                      title: 'Excluir agente',
                      message: `Excluir o agente "${agent.name}"?`,
                      confirmLabel: 'Excluir',
                      danger: true,
                    }).then((ok) => {
                      if (!ok) return;
                      if (draft?.id === agent.id) setDraft(undefined);
                      void api.deleteAgent(agent.id).then(() => loadAgents());
                    });
                  }}
                >
                  Excluir
                </span>
              </span>
            </button>
          ))}

          {vsAgents.length > 0 && (
            <>
              <div className="panel__divider">Chat modes do VS Code</div>
              {vsAgents.map((vs) => (
                <div className="page-list-item page-list-item--static" key={vs.id}>
                  <span className="item-card__name">🧩 {vs.name}</span>
                  <span className="item-card__desc">
                    {vs.description || '—'}
                    <em style={{ opacity: 0.7 }}>
                      {' '}
                      · {vs.source === 'project' ? '.github/chatmodes do repo' : 'perfil do usuário'}
                    </em>
                  </span>
                  <span className="page-list-item__actions">
                    <span role="button" className="mini-btn" onClick={() => importVsAgent(vs)}>
                      Importar →
                    </span>
                  </span>
                </div>
              ))}
            </>
          )}
        </Panel>

        {draft ? (
          <Panel title={draft.id ? 'Editar agente' : 'Novo agente'} className="panel--form">
            <div className="row">
              <div className="field" style={{ maxWidth: 90, flex: '0 0 90px' }}>
                <label>Ícone</label>
                <input
                  value={draft.icon}
                  onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
                  maxLength={4}
                />
              </div>
              <div className="field">
                <label>Nome</label>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="ex: Analista de Produto"
                />
              </div>
            </div>
            <div className="field">
              <label>Descrição</label>
              <input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </div>
            <div className="row">
              <div className="field">
                <label>Modelo padrão</label>
                <Select
                  value={draft.defaultModelId}
                  onChange={(value) => setDraft({ ...draft, defaultModelId: value })}
                  options={[
                    { value: '', label: '— herdar da sessão —' },
                    ...models.map((m) => ({
                      value: m.id,
                      label:
                        m.multiplier !== undefined
                          ? `${m.name} · ${formatMultiplier(m.multiplier)}`
                          : m.name,
                    })),
                  ]}
                />
              </div>
              <div className="field">
                <label>Modo padrão</label>
                <Select
                  value={draft.defaultMode}
                  onChange={(value) =>
                    setDraft({ ...draft, defaultMode: value as Draft['defaultMode'] })
                  }
                  options={[
                    { value: '', label: '— manter o da sessão —' },
                    { value: 'ask', label: 'Ask', hint: 'Pergunta e resposta, sem ferramentas' },
                    { value: 'plan', label: 'Plan', hint: 'Gera planos; só leitura' },
                    { value: 'agent', label: 'Agent', hint: 'Usa ferramentas e MCPs' },
                  ]}
                />
              </div>
            </div>
            <div className="field page-card__grow">
              <label>Instruções do agente (markdown)</label>
              <textarea
                className="page-card__editor"
                value={draft.instructions}
                onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
                placeholder="Você é um analista de produto sênior. Sempre estruture respostas com…"
              />
            </div>
            <div className="form-actions">
              <button className="btn" onClick={() => setDraft(undefined)}>
                Cancelar
              </button>
              <button
                className="btn btn--primary"
                disabled={busy || !draft.name.trim()}
                onClick={() => void save()}
              >
                Salvar agente
              </button>
            </div>
          </Panel>
        ) : (
          <Panel className="panel--placeholder">
            <EmptyState
              icon="✏️"
              title="Nenhum agente selecionado"
              hint="Selecione um agente ao lado para editar, crie um novo ou importe um chat mode do VS Code."
            />
          </Panel>
        )}
      </div>
    </PageShell>
  );
}

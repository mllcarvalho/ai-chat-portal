import { useEffect, useState } from 'react';
import type { AgentPreset, SessionMode, VsCodeAgent } from '@aiportal/shared';
import { api } from '../../api/client';
import { useCatalog } from '../../stores/catalogStore';
import { useUi } from '../../stores/uiStore';
import { PageShell } from './PageShell';

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
  const toast = useUi((s) => s.toast);
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
      description: vs.description ?? `Importado do VS Code (${vs.source === 'project' ? 'repo' : 'perfil'})`,
      instructions: vs.instructions,
      defaultModelId: '',
      defaultMode: '',
    });
  };

  return (
    <PageShell
      title="Agentes"
      subtitle="Presets de instruções + modelo + modo que você aplica a uma conversa."
      actions={
        <button className="btn btn--primary" onClick={() => setDraft({ ...EMPTY })}>
          ＋ Novo agente
        </button>
      }
    >
      <div className="page-cols">
        <div>
          {agents.length === 0 && (
            <div className="empty-state">Nenhum agente ainda. Crie um ou importe do VS Code abaixo.</div>
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
              <span className="item-card__desc">{agent.description || agent.instructions || '—'}</span>
              <span className="page-list-item__actions">
                <span
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`Excluir o agente "${agent.name}"?`)) {
                      if (draft?.id === agent.id) setDraft(undefined);
                      void api.deleteAgent(agent.id).then(() => loadAgents());
                    }
                  }}
                >
                  Excluir
                </span>
              </span>
            </button>
          ))}

          {vsAgents.length > 0 && (
            <>
              <div className="sidebar__section-title" style={{ padding: '18px 0 6px' }}>
                Agentes do VS Code (chat modes)
              </div>
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
                    <span role="button" onClick={() => importVsAgent(vs)}>
                      Importar →
                    </span>
                  </span>
                </div>
              ))}
            </>
          )}
        </div>

        {draft ? (
          <div className="page-card">
            <h3 className="page-card__title">{draft.id ? 'Editar agente' : 'Novo agente'}</h3>
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
                <select
                  value={draft.defaultModelId}
                  onChange={(e) => setDraft({ ...draft, defaultModelId: e.target.value })}
                >
                  <option value="">— herdar da sessão —</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Modo padrão</label>
                <select
                  value={draft.defaultMode}
                  onChange={(e) => setDraft({ ...draft, defaultMode: e.target.value as Draft['defaultMode'] })}
                >
                  <option value="">— manter o da sessão —</option>
                  <option value="ask">Ask</option>
                  <option value="plan">Plan</option>
                  <option value="agent">Agent</option>
                </select>
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
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn--ghost" onClick={() => setDraft(undefined)}>
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
          </div>
        ) : (
          <div className="empty-state page-card page-card--placeholder">
            Selecione um agente ao lado para editar, crie um novo ou importe um chat mode do VS Code.
          </div>
        )}
      </div>
    </PageShell>
  );
}

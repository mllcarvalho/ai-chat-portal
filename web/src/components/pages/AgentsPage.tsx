import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  isBmadAsset,
  slugifyCommand,
  type AgentPreset,
  type KnowledgeBase,
  type SessionMode,
  type Skill,
  type VsCodeAgent,
} from '@aiportal/shared';
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
  skillIds: string[];
  knowledgeBaseIds: string[];
}

const EMPTY: Draft = {
  name: '',
  icon: '🤖',
  description: '',
  instructions: '',
  defaultModelId: '',
  defaultMode: '',
  skillIds: [],
  knowledgeBaseIds: [],
};

/** Resumo dos vínculos do agente para a lista (ex: "2 skills · 1 base"). */
function linkSummary(agent: AgentPreset): string {
  const parts: string[] = [];
  const skills = agent.skillIds?.length ?? 0;
  const bases = agent.knowledgeBaseIds?.length ?? 0;
  if (skills) parts.push(`${skills} skill${skills === 1 ? '' : 's'}`);
  if (bases) parts.push(`${bases} base${bases === 1 ? '' : 's'}`);
  return parts.length ? ` · 🔗 ${parts.join(' · ')}` : '';
}

const LINK_LIST_STYLE: CSSProperties = {
  maxHeight: 130,
  overflowY: 'auto',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '6px 10px',
  background: 'var(--bg-1)',
};

const LINK_ITEM_STYLE: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  fontSize: 13,
  padding: '3px 0',
  cursor: 'pointer',
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
  const [skills, setSkills] = useState<Skill[]>([]);
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadAgents();
    void api.listVsCodeAgents().then(setVsAgents).catch(() => setVsAgents([]));
  }, [loadAgents]);

  // opções dos vínculos (skills/bases criadas pelo usuário; assets BMAD são gerenciados)
  useEffect(() => {
    void api
      .listSkills(contextProjectId ?? undefined)
      .then((list) => setSkills(list.filter((s) => !isBmadAsset(s.id))))
      .catch(() => setSkills([]));
    void api
      .listKnowledge(contextProjectId ?? undefined)
      .then(setBases)
      .catch(() => setBases([]));
  }, [contextProjectId]);

  const toggleDraftLink = (key: 'skillIds' | 'knowledgeBaseIds', id: string) => {
    setDraft((d) => {
      if (!d) return d;
      const list = d[key];
      return { ...d, [key]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] };
    });
  };

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
        // arrays sempre presentes: desmarcar tudo também precisa persistir
        skillIds: draft.skillIds,
        knowledgeBaseIds: draft.knowledgeBaseIds,
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

  const exportAgent = async (agent: AgentPreset) => {
    const slug = slugifyCommand(agent.name) || 'agente';
    // com vínculos o export vira zip (agente + skills + bases); sem, segue o .json simples
    if (agent.skillIds?.length || agent.knowledgeBaseIds?.length) {
      try {
        await api.exportAgentZip(agent.id, `${slug}.agent.zip`);
      } catch (err) {
        toast((err as Error).message, 'error');
      }
      return;
    }
    const payload = {
      type: 'ai-chat-portal-agent',
      name: agent.name,
      icon: agent.icon,
      description: agent.description,
      instructions: agent.instructions,
      defaultModelId: agent.defaultModelId,
      defaultMode: agent.defaultMode,
      enabledTools: agent.enabledTools ?? undefined,
      originId: agent.importedFrom ?? agent.id,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug}.agent.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importAgentFiles = async (files: FileList) => {
    setBusy(true);
    let okCount = 0;
    for (const file of Array.from(files)) {
      try {
        if (/\.zip$/i.test(file.name)) {
          const zipBase64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
            reader.onerror = () => reject(new Error('Falha ao ler o arquivo'));
            reader.readAsDataURL(file);
          });
          await api.importAgentZip(zipBase64);
          okCount++;
          continue;
        }
        const parsed = JSON.parse(await file.text()) as unknown;
        // aceita um agente por arquivo ou uma lista de agentes
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          const agent = item as Partial<AgentPreset> & { originId?: string };
          if (!agent?.name?.trim()) throw new Error('JSON sem o campo "name" de agente');
          const payload: Partial<AgentPreset> = {
            name: agent.name.trim(),
            icon: agent.icon,
            description: agent.description,
            instructions: agent.instructions ?? '',
            defaultModelId: agent.defaultModelId,
            defaultMode: ['ask', 'plan', 'agent'].includes(agent.defaultMode ?? '')
              ? agent.defaultMode
              : undefined,
            enabledTools: agent.enabledTools ?? null,
          };
          // upsert por origem: reimport atualiza em vez de duplicar
          const existing = agent.originId
            ? agents.find((a) => a.id === agent.originId || a.importedFrom === agent.originId)
            : undefined;
          if (existing) await api.patchAgent(existing.id, payload);
          else await api.createAgent({ ...payload, importedFrom: agent.originId });
          okCount++;
        }
      } catch (err) {
        toast(`"${file.name}": ${(err as Error).message}`, 'error');
      }
    }
    if (okCount) {
      await loadAgents();
      toast(
        `${okCount} agente${okCount === 1 ? '' : 's'} importado${okCount === 1 ? '' : 's'}/atualizado${okCount === 1 ? '' : 's'}.`,
        'ok',
      );
    }
    setBusy(false);
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
      skillIds: [],
      knowledgeBaseIds: [],
    });
  };

  return (
    <PageShell
      icon="🤖"
      title="Agentes"
      subtitle="Presets de instruções + modelo + modo que você aplica a uma conversa."
      actions={
        <>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,.zip,application/json,application/zip"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) void importAgentFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <button
            className="btn"
            disabled={busy}
            onClick={() => importInputRef.current?.click()}
            title="Importar agentes exportados (.agent.json ou .agent.zip com skills e bases)"
          >
            📦 Importar
          </button>
          <button className="btn btn--primary" onClick={() => setDraft({ ...EMPTY })}>
            ＋ Novo agente
          </button>
        </>
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
                  skillIds: agent.skillIds ?? [],
                  knowledgeBaseIds: agent.knowledgeBaseIds ?? [],
                })
              }
            >
              <span className="item-card__name">
                {agent.icon ?? '🤖'} {agent.name}
              </span>
              <span className="item-card__desc">
                {agent.description || agent.instructions || '—'}
                {linkSummary(agent)}
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
                  className="mini-btn"
                  title="Baixar para compartilhar (.agent.json; com skills/bases vinculadas vira .agent.zip)"
                  onClick={(e) => {
                    e.stopPropagation();
                    void exportAgent(agent);
                  }}
                >
                  Exportar
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
            <div className="row">
              <div className="field">
                <label>Skills vinculadas ({draft.skillIds.length})</label>
                <div style={LINK_LIST_STYLE}>
                  {skills.map((s) => (
                    <label key={s.id} style={LINK_ITEM_STYLE}>
                      <input
                        type="checkbox"
                        checked={draft.skillIds.includes(s.id)}
                        onChange={() => toggleDraftLink('skillIds', s.id)}
                      />
                      <span>
                        {s.name}
                        {s.scope === 'project' ? ' 📁' : ''}
                      </span>
                    </label>
                  ))}
                  {skills.length === 0 && (
                    <span style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
                      Nenhuma skill no portal ainda.
                    </span>
                  )}
                </div>
                <span style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
                  Garantidas no catálogo das conversas deste agente e levadas no export. Não
                  restringe: as demais skills continuam disponíveis.
                </span>
              </div>
              <div className="field">
                <label>Bases vinculadas ({draft.knowledgeBaseIds.length})</label>
                <div style={LINK_LIST_STYLE}>
                  {bases.map((b) => (
                    <label key={b.id} style={LINK_ITEM_STYLE}>
                      <input
                        type="checkbox"
                        checked={draft.knowledgeBaseIds.includes(b.id)}
                        onChange={() => toggleDraftLink('knowledgeBaseIds', b.id)}
                      />
                      <span>
                        {b.scope === 'project' ? '📁' : '🌐'} {b.name}
                        {b.enabled ? '' : ' (desativada no geral)'}
                      </span>
                    </label>
                  ))}
                  {bases.length === 0 && (
                    <span style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
                      Nenhuma base de conhecimento ainda.
                    </span>
                  )}
                </div>
                <span style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
                  Entram no contexto das conversas deste agente mesmo desativadas no toggle geral, e
                  vão juntas no export.
                </span>
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

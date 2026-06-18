import { useCallback, useEffect, useRef, useState } from 'react';
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
import { Modal } from '../common/Modal';
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

interface PickItem {
  id: string;
  label: string;
}

/** Resumo dos vínculos do agente para a lista (ex: "2 skills · 1 base"). */
function linkSummary(agent: AgentPreset): string {
  const parts: string[] = [];
  const skills = agent.skillIds?.length ?? 0;
  const bases = agent.knowledgeBaseIds?.length ?? 0;
  if (skills) parts.push(`${skills} skill${skills === 1 ? '' : 's'}`);
  if (bases) parts.push(`${bases} base${bases === 1 ? '' : 's'}`);
  return parts.length ? ` · 🔗 ${parts.join(' · ')}` : '';
}

/** Modal de seleção de vínculos (skills ou bases): busca + checkboxes. */
function LinkPickerModal(props: {
  title: string;
  emptyHint: string;
  items: PickItem[];
  selected: string[];
  onToggle: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? props.items.filter((it) => it.label.toLowerCase().includes(needle))
    : props.items;
  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      footer={
        <>
          <span className="link-picker__count">{props.selected.length} selecionada(s)</span>
          <button className="btn btn--primary" onClick={props.onClose}>
            Concluir
          </button>
        </>
      }
    >
      {props.items.length > 0 && (
        <input
          className="link-picker__search"
          placeholder="Buscar…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
      )}
      <div className="link-picker__list">
        {filtered.map((it) => (
          <label key={it.id} className="link-picker__item">
            <input
              type="checkbox"
              checked={props.selected.includes(it.id)}
              onChange={() => props.onToggle(it.id)}
            />
            <span>{it.label}</span>
          </label>
        ))}
        {filtered.length === 0 && (
          <span className="link-picker__empty">
            {props.items.length === 0 ? props.emptyHint : 'Nada encontrado.'}
          </span>
        )}
      </div>
    </Modal>
  );
}

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
  const [picker, setPicker] = useState<'skills' | 'bases' | null>(null);
  const [expandInstructions, setExpandInstructions] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadAgents();
    void api.listVsCodeAgents().then(setVsAgents).catch(() => setVsAgents([]));
  }, [loadAgents]);

  // opções dos vínculos (skills/bases criadas pelo usuário; assets BMAD são gerenciados)
  const loadLinks = useCallback(() => {
    void api
      .listSkills(contextProjectId ?? undefined)
      .then((list) => setSkills(list.filter((s) => !isBmadAsset(s.id))))
      .catch(() => setSkills([]));
    void api
      .listKnowledge(contextProjectId ?? undefined)
      .then(setBases)
      .catch(() => setBases([]));
  }, [contextProjectId]);

  useEffect(() => {
    loadLinks();
  }, [loadLinks]);

  const toggleDraftLink = (key: 'skillIds' | 'knowledgeBaseIds', id: string) => {
    setDraft((d) => {
      if (!d) return d;
      const list = d[key];
      return { ...d, [key]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] };
    });
  };

  const skillLabel = (s: Skill) => `${s.name}${s.scope === 'project' ? ' 📁' : ''}`;
  const baseLabel = (b: KnowledgeBase) =>
    `${b.scope === 'project' ? '📁' : '🌐'} ${b.name}${b.enabled ? '' : ' (desativada no geral)'}`;

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
    let bundledSkills = 0;
    let bundledBases = 0;
    for (const file of Array.from(files)) {
      try {
        if (/\.zip$/i.test(file.name)) {
          const zipBase64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
            reader.onerror = () => reject(new Error('Falha ao ler o arquivo'));
            reader.readAsDataURL(file);
          });
          const imported = await api.importAgentZip(zipBase64);
          bundledSkills += imported.skillIds?.length ?? 0;
          bundledBases += imported.knowledgeBaseIds?.length ?? 0;
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
      loadLinks();
      const bundled =
        bundledSkills || bundledBases
          ? ` (com ${bundledSkills} skill${bundledSkills === 1 ? '' : 's'} e ${bundledBases} base${bundledBases === 1 ? '' : 's'} vinculadas)`
          : '';
      toast(
        `${okCount} agente${okCount === 1 ? '' : 's'} importado${okCount === 1 ? '' : 's'}/atualizado${okCount === 1 ? '' : 's'}.${bundled}`,
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

  // chips dos vínculos selecionados no draft (com nome resolvido; ids órfãos viram chip de aviso)
  const renderLinkChips = (key: 'skillIds' | 'knowledgeBaseIds') => {
    const ids = draft?.[key] ?? [];
    if (ids.length === 0) {
      return <span className="link-field__empty">Nenhuma vinculada.</span>;
    }
    return (
      <div className="link-field__chips">
        {ids.map((id) => {
          const label =
            key === 'skillIds'
              ? skills.find((s) => s.id === id)?.name
              : bases.find((b) => b.id === id)?.name;
          return (
            <span key={id} className={`link-chip${label ? '' : ' link-chip--missing'}`}>
              {label ?? 'item indisponível'}
              <span
                role="button"
                className="link-chip__x"
                title="Desvincular"
                onClick={() => toggleDraftLink(key, id)}
              >
                ×
              </span>
            </span>
          );
        })}
      </div>
    );
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
          <Panel
            title={draft.id ? 'Editar agente' : 'Novo agente'}
            className="panel--form panel--agent-form"
          >
            <div className="agent-form">
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
                <div className="link-field">
                  <button className="btn btn--sm btn--ghost" onClick={() => setPicker('skills')}>
                    🔗 Vincular skills
                  </button>
                  {renderLinkChips('skillIds')}
                </div>
                <span style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
                  Garantidas no catálogo das conversas deste agente e levadas no export. Não
                  restringe: as demais skills continuam disponíveis.
                </span>
              </div>
              <div className="field">
                <label>Bases vinculadas ({draft.knowledgeBaseIds.length})</label>
                <div className="link-field">
                  <button className="btn btn--sm btn--ghost" onClick={() => setPicker('bases')}>
                    🔗 Vincular bases
                  </button>
                  {renderLinkChips('knowledgeBaseIds')}
                </div>
                <span style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
                  Entram no contexto das conversas deste agente mesmo desativadas no toggle geral, e
                  vão juntas no export.
                </span>
              </div>
            </div>
            <div className="field page-card__grow">
              <div className="field__label-row">
                <label>Instruções do agente (markdown)</label>
                <button
                  className="btn btn--sm btn--ghost"
                  onClick={() => setExpandInstructions(true)}
                  title="Editar em tela cheia"
                >
                  ⤢ Expandir
                </button>
              </div>
              <textarea
                className="page-card__editor"
                value={draft.instructions}
                onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
                placeholder="Você é um analista de produto sênior. Sempre estruture respostas com…"
              />
            </div>
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

      {draft && picker === 'skills' && (
        <LinkPickerModal
          title="Vincular skills"
          emptyHint="Nenhuma skill no portal ainda."
          items={skills.map((s) => ({ id: s.id, label: skillLabel(s) }))}
          selected={draft.skillIds}
          onToggle={(id) => toggleDraftLink('skillIds', id)}
          onClose={() => setPicker(null)}
        />
      )}
      {draft && picker === 'bases' && (
        <LinkPickerModal
          title="Vincular bases de conhecimento"
          emptyHint="Nenhuma base de conhecimento ainda."
          items={bases.map((b) => ({ id: b.id, label: baseLabel(b) }))}
          selected={draft.knowledgeBaseIds}
          onToggle={(id) => toggleDraftLink('knowledgeBaseIds', id)}
          onClose={() => setPicker(null)}
        />
      )}
      {draft && expandInstructions && (
        <Modal
          title="Instruções do agente (markdown)"
          wide
          onClose={() => setExpandInstructions(false)}
          footer={
            <button className="btn btn--primary" onClick={() => setExpandInstructions(false)}>
              Concluir
            </button>
          }
        >
          <textarea
            className="modal-editor"
            value={draft.instructions}
            onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
            placeholder="Você é um analista de produto sênior. Sempre estruture respostas com…"
            autoFocus
          />
        </Modal>
      )}
    </PageShell>
  );
}

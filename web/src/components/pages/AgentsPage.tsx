import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot,
  Download,
  Folder,
  Globe,
  Import,
  Link,
  Mail,
  Maximize2,
  MessageSquare,
  Package,
  Pencil,
  Plus,
  Puzzle,
  Search,
  Trash2,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
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
import { AgentIcon } from '../common/AgentIcon';
import { MarkdownEditorModal } from '../common/MarkdownEditorModal';
import { Modal } from '../common/Modal';
import { Select } from '../common/Select';
import { EmptyState, PageShell, Panel } from './PageShell';

interface Draft {
  id?: string;
  /** 'shared' = o agente vive numa biblioteca compartilhada da equipe. */
  scope?: 'global' | 'shared';
  libraryId?: string;
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
  icon?: LucideIcon;
}

/** Resumo dos vínculos do agente para a lista (ex: "2 skills · 1 base"). */
function linkSummary(agent: AgentPreset): string {
  const parts: string[] = [];
  const skills = agent.skillIds?.length ?? 0;
  const bases = agent.knowledgeBaseIds?.length ?? 0;
  if (skills) parts.push(`${skills} skill${skills === 1 ? '' : 's'}`);
  if (bases) parts.push(`${bases} base${bases === 1 ? '' : 's'}`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
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
            <span>
              {it.icon && <it.icon className="icon" aria-hidden />} {it.label}
            </span>
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
  // agentes BMAD desabilitados ficam só nas Configurações, fora da lista
  const visibleAgents = agents.filter((a) => !(isBmadAsset(a.id) && a.enabled === false));
  const models = useCatalog((s) => s.models);
  const libraries = useCatalog((s) => s.libraries);
  const libraryName = (id?: string) =>
    libraries.find((lib) => lib.id === id)?.name ?? 'Compartilhada';
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
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [vsAgents, setVsAgents] = useState<VsCodeAgent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [picker, setPicker] = useState<'skills' | 'bases' | null>(null);
  const [expandInstructions, setExpandInstructions] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  // busca por nome/descrição na lista de agentes
  const needle = query.trim().toLowerCase();
  const shownAgents = needle
    ? visibleAgents.filter(
        (a) =>
          a.name.toLowerCase().includes(needle) ||
          (a.description ?? '').toLowerCase().includes(needle),
      )
    : visibleAgents;

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

  /** "2 skills e 1 base" — usado nas mensagens de mover vínculos. */
  const describeLinks = (items: { skills: Skill[]; bases: KnowledgeBase[] }) => {
    const parts: string[] = [];
    if (items.skills.length) {
      parts.push(`${items.skills.length} skill${items.skills.length === 1 ? '' : 's'}`);
    }
    if (items.bases.length) {
      parts.push(`${items.bases.length} base${items.bases.length === 1 ? '' : 's'} de conhecimento`);
    }
    return parts.join(' e ');
  };

  const skillLabel = (s: Skill) => s.name;
  const baseLabel = (b: KnowledgeBase) =>
    `${b.name}${b.enabled ? '' : ' (desativada no geral)'}`;

  /**
   * Vínculos do agente que NÃO estão na mesma biblioteca compartilhada. São
   * eles que quebram o agente na máquina de quem recebe: o preset guarda ids,
   * e a skill/base referenciada só existe no computador de quem criou.
   */
  const localLinks = (d: Draft) => {
    if (d.scope !== 'shared' || !d.libraryId) return { skills: [], bases: [] };
    return {
      skills: d.skillIds
        .map((id) => skills.find((s) => s.id === id))
        .filter((s): s is Skill => !!s && !(s.scope === 'shared' && s.libraryId === d.libraryId)),
      bases: d.knowledgeBaseIds
        .map((id) => bases.find((b) => b.id === id))
        .filter(
          (b): b is KnowledgeBase => !!b && !(b.scope === 'shared' && b.libraryId === d.libraryId),
        ),
    };
  };

  const save = async () => {
    if (!draft) return;
    /** Skills/bases a mover junto com o agente (decidido no confirm abaixo). */
    let carry: { skills: Skill[]; bases: KnowledgeBase[] } = { skills: [], bases: [] };
    if (draft.scope === 'shared') {
      const pending = localLinks(draft);
      const pendingCount = pending.skills.length + pending.bases.length;
      const ok = await confirm({
        title: 'Salvar na biblioteca compartilhada',
        message:
          `Este agente vai para a biblioteca "${libraryName(draft.libraryId)}" — ` +
          'todo mundo que usa essa pasta passa a ver a nova versão.' +
          (pendingCount
            ? `\n\nEle usa ${describeLinks(pending)} que ainda ${pendingCount === 1 ? 'está' : 'estão'} ` +
              'só nesta máquina. Sem levar junto, quem abrir o agente vê "item indisponível". ' +
              'Levar tudo para a biblioteca?'
            : ''),
        confirmLabel: pendingCount ? 'Salvar e levar junto' : 'Salvar para a equipe',
      });
      if (!ok) return;
      carry = pending;
    }
    setBusy(true);
    try {
      const payload: Partial<AgentPreset> = {
        scope: draft.scope === 'shared' ? 'shared' : 'global',
        libraryId: draft.scope === 'shared' ? draft.libraryId : undefined,
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
      // move primeiro os vínculos: se a pasta de rede recusar, o agente não é
      // salvo apontando para itens que ficaram para trás
      for (const skill of carry.skills) {
        await api.patchSkill(skill.id, { scope: 'shared', libraryId: draft.libraryId });
      }
      for (const base of carry.bases) {
        await api.patchKnowledgeBase(base.id, { scope: 'shared', libraryId: draft.libraryId });
      }
      if (draft.id) await api.patchAgent(draft.id, payload);
      else await api.createAgent(payload);
      const carried = carry.skills.length + carry.bases.length;
      toast(
        carried
          ? `Agente salvo e ${describeLinks(carry)} ${carried === 1 ? 'movida' : 'movidas'} para a biblioteca.`
          : 'Agente salvo.',
        'ok',
      );
      if (carried) loadLinks();
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

  const emailShare = async (id: string) => {
    try {
      const result = await api.shareByEmail('agent', id);
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
          const item =
            key === 'skillIds' ? skills.find((s) => s.id === id) : bases.find((b) => b.id === id);
          const label = item?.name;
          // num agente compartilhado, vínculo que não está na mesma biblioteca
          // vira "item indisponível" na máquina de quem receber
          const onlyLocal =
            !!item &&
            draft?.scope === 'shared' &&
            !(item.scope === 'shared' && item.libraryId === draft.libraryId);
          return (
            <span
              key={id}
              className={`link-chip${label ? '' : ' link-chip--missing'}${onlyLocal ? ' link-chip--local' : ''}`}
              title={
                onlyLocal
                  ? 'Só nesta máquina — ao salvar, o portal oferece levar para a biblioteca compartilhada'
                  : undefined
              }
            >
              {label ?? 'item indisponível'}
              {onlyLocal && ' · só nesta máquina'}
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
      icon={<Bot className="icon icon--lg" aria-hidden />}
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
            <Package className="icon" aria-hidden /> Importar
          </button>
          <button className="btn btn--primary" onClick={() => setDraft({ ...EMPTY })}>
            <Plus className="icon" aria-hidden /> Novo agente
          </button>
        </>
      }
    >
      <div className="page-cols">
        <Panel
          title="Meus agentes"
          count={shownAgents.length}
          actions={
            visibleAgents.length > 0 ? (
              <div className="panel-search">
                <Search className="icon icon--sm" aria-hidden />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar…"
                  aria-label="Buscar agente por nome ou descrição"
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setQuery('');
                  }}
                />
                {query && (
                  <button title="Limpar busca" aria-label="Limpar busca" onClick={() => setQuery('')}>
                    <X className="icon icon--sm" aria-hidden />
                  </button>
                )}
              </div>
            ) : undefined
          }
        >
          {needle && visibleAgents.length > 0 && shownAgents.length === 0 && (
            <EmptyState
              icon={<Search className="icon icon--lg" aria-hidden />}
              title="Nada encontrado"
              hint="Nenhum agente com esse nome ou descrição."
            />
          )}
          {visibleAgents.length === 0 && !(draft && !draft.id) && (
            <EmptyState
              icon={<Bot className="icon icon--lg" aria-hidden />}
              title="Nenhum agente ainda"
              hint="Crie um preset de instruções ou importe um chat mode do VS Code abaixo."
              action={
                <button className="btn btn--primary" onClick={() => setDraft({ ...EMPTY })}>
                  <Plus className="icon" aria-hidden /> Criar primeiro agente
                </button>
              }
            />
          )}
          {draft && !draft.id && (
            <div className="page-list-item page-list-item--active page-list-item--draft">
              <span className="page-list-item__row">
                <span className="item-card__name">
                  <AgentIcon icon={draft.icon} /> {draft.name.trim() || 'Novo agente'}
                </span>
                <span className="mcp-status">rascunho</span>
              </span>
              <span className="item-card__desc">
                {draft.description.trim() || 'Preencha ao lado e salve.'}
              </span>
              <span className="page-list-item__actions">
                <span
                  role="button"
                  className="mini-btn"
                  title="Descartar rascunho"
                  aria-label="Descartar rascunho"
                  onClick={() => setDraft(undefined)}
                >
                  <X className="icon" aria-hidden />
                </span>
              </span>
            </div>
          )}
          {shownAgents.map((agent) => (
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
                  scope: agent.scope,
                  libraryId: agent.libraryId,
                  skillIds: agent.skillIds ?? [],
                  knowledgeBaseIds: agent.knowledgeBaseIds ?? [],
                })
              }
            >
              <span className="page-list-item__row">
                <span className="item-card__name">
                  <AgentIcon icon={agent.icon} /> {agent.name}
                </span>
                {agent.scope === 'shared' && (
                  <span
                    className="scope-badge scope-badge--shared"
                    title={libraryName(agent.libraryId)}
                  >
                    <Users className="icon icon--sm" aria-hidden /> {libraryName(agent.libraryId)}
                  </span>
                )}
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
                  aria-label="Nova conversa com este agente"
                  onClick={(e) => {
                    e.stopPropagation();
                    setView('chat');
                    void newSession(contextProjectId, { agentId: agent.id });
                  }}
                >
                  <MessageSquare className="icon" aria-hidden />
                </span>
                <span
                  role="button"
                  className="mini-btn"
                  title="Baixar para compartilhar (.agent.json; com skills/bases vinculadas vira .agent.zip)"
                  aria-label="Exportar agente"
                  onClick={(e) => {
                    e.stopPropagation();
                    void exportAgent(agent);
                  }}
                >
                  <Download className="icon" aria-hidden />
                </span>
                {!isBmadAsset(agent.id) && (
                  <span
                    role="button"
                    className="mini-btn"
                    title="Enviar por email (abre o cliente com o .agent.zip anexado — skills e bases vinculadas vão juntas)"
                    aria-label="Enviar agente por email"
                    onClick={(e) => {
                      e.stopPropagation();
                      void emailShare(agent.id);
                    }}
                  >
                    <Mail className="icon" aria-hidden />
                  </span>
                )}
                <span
                  role="button"
                  className="mini-btn mini-btn--danger"
                  title="Excluir agente"
                  aria-label="Excluir agente"
                  onClick={(e) => {
                    e.stopPropagation();
                    void confirm({
                      title: 'Excluir agente',
                      message:
                        agent.scope === 'shared'
                          ? `Excluir o agente "${agent.name}" da biblioteca "${libraryName(agent.libraryId)}"? ` +
                            'Ele sai para TODAS as pessoas que usam essa pasta compartilhada.'
                          : `Excluir o agente "${agent.name}"?`,
                      confirmLabel: 'Excluir',
                      danger: true,
                    }).then((ok) => {
                      if (!ok) return;
                      if (draft?.id === agent.id) setDraft(undefined);
                      void api.deleteAgent(agent.id).then(() => loadAgents());
                    });
                  }}
                >
                  <Trash2 className="icon" aria-hidden />
                </span>
              </span>
            </button>
          ))}

          {vsAgents.length > 0 && (
            <>
              <div className="panel__divider">Chat modes do VS Code</div>
              {vsAgents.map((vs) => (
                <div className="page-list-item page-list-item--static" key={vs.id}>
                  <span className="page-list-item__row">
                    <span className="item-card__name">
                      <Puzzle className="icon" aria-hidden /> {vs.name}
                    </span>
                  </span>
                  <span className="item-card__desc">
                    {vs.description || '—'}
                    <em style={{ opacity: 0.7 }}>
                      {' '}
                      · {vs.source === 'project' ? '.github/chatmodes do repo' : 'perfil do usuário'}
                    </em>
                  </span>
                  <span className="page-list-item__actions">
                    <span
                      role="button"
                      className="mini-btn"
                      title="Importar como agente do portal"
                      aria-label="Importar como agente do portal"
                      onClick={() => importVsAgent(vs)}
                    >
                      <Import className="icon" aria-hidden />
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
              <div className="field" style={{ maxWidth: 72, flex: '0 0 72px' }}>
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
                <label>Onde fica</label>
                <Select
                  value={draft.scope === 'shared' ? 'shared' : 'global'}
                  onChange={(value) =>
                    setDraft({
                      ...draft,
                      scope: value as Draft['scope'],
                      libraryId:
                        value === 'shared'
                          ? draft.libraryId ?? libraries.find((l) => l.available)?.id
                          : draft.libraryId,
                    })
                  }
                  options={[
                    {
                      value: 'global',
                      label: <><Globe className="icon" aria-hidden /> Só nesta máquina</>,
                      hint: 'Agente pessoal',
                    },
                    {
                      value: 'shared',
                      label: <><Users className="icon" aria-hidden /> Compartilhado</>,
                      hint: libraries.length
                        ? 'Vai para a pasta da equipe'
                        : 'Configure uma biblioteca em Configurações',
                      disabled: libraries.length === 0,
                    },
                  ]}
                />
              </div>
              {draft.scope === 'shared' && (
                <div className="field">
                  <label>Biblioteca</label>
                  <Select
                    value={draft.libraryId ?? libraries[0]?.id ?? ''}
                    onChange={(value) => setDraft({ ...draft, libraryId: value })}
                    options={libraries.map((lib) => ({
                      value: lib.id,
                      label: <><Users className="icon" aria-hidden /> {lib.name}</>,
                      hint: lib.available ? lib.path : 'indisponível agora',
                      disabled: !lib.available,
                    }))}
                  />
                </div>
              )}
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
                    <Link className="icon" aria-hidden /> Vincular skills
                  </button>
                  {renderLinkChips('skillIds')}
                </div>
                <span className="field__hint">
                  Garantidas no catálogo das conversas deste agente e levadas no export. Não
                  restringe: as demais skills continuam disponíveis.
                </span>
              </div>
              <div className="field">
                <label>Bases vinculadas ({draft.knowledgeBaseIds.length})</label>
                <div className="link-field">
                  <button className="btn btn--sm btn--ghost" onClick={() => setPicker('bases')}>
                    <Link className="icon" aria-hidden /> Vincular bases
                  </button>
                  {renderLinkChips('knowledgeBaseIds')}
                </div>
                <span className="field__hint">
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
                  <Maximize2 className="icon" aria-hidden /> Expandir
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
              icon={<Pencil className="icon icon--lg" aria-hidden />}
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
          items={skills.map((s) => ({
            id: s.id,
            label: skillLabel(s),
            icon: s.scope === 'project' ? Folder : undefined,
          }))}
          selected={draft.skillIds}
          onToggle={(id) => toggleDraftLink('skillIds', id)}
          onClose={() => setPicker(null)}
        />
      )}
      {draft && picker === 'bases' && (
        <LinkPickerModal
          title="Vincular bases de conhecimento"
          emptyHint="Nenhuma base de conhecimento ainda."
          items={bases.map((b) => ({
            id: b.id,
            label: baseLabel(b),
            icon: b.scope === 'project' ? Folder : Globe,
          }))}
          selected={draft.knowledgeBaseIds}
          onToggle={(id) => toggleDraftLink('knowledgeBaseIds', id)}
          onClose={() => setPicker(null)}
        />
      )}
      {draft && expandInstructions && (
        <MarkdownEditorModal
          title="Instruções do agente (markdown)"
          value={draft.instructions}
          onChange={(value) => setDraft({ ...draft, instructions: value })}
          placeholder="Você é um analista de produto sênior. Sempre estruture respostas com…"
          onClose={() => setExpandInstructions(false)}
        />
      )}
    </PageShell>
  );
}

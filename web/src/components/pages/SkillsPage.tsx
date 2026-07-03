import { useEffect, useMemo, useRef, useState } from 'react';
import type { Skill, SkillWithContent } from '@aiportal/shared';
import { isBmadAsset, slugifyCommand } from '@aiportal/shared';
import { api } from '../../api/client';
import { useCatalog } from '../../stores/catalogStore';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';
import { MarkdownEditorModal } from '../common/MarkdownEditorModal';
import { Select } from '../common/Select';
import { EmptyState, PageShell, Panel } from './PageShell';

interface Draft {
  id?: string;
  scope: 'global' | 'project';
  projectId?: string;
  name: string;
  description: string;
  command: string;
  content: string;
}

const EMPTY: Draft = {
  scope: 'global',
  name: '',
  description: '',
  command: '',
  content: '',
};

/** 'all' | 'global' | 'bmad' | id de projeto */
type ScopeFilter = string;

/**
 * Arquivo .md de skill: frontmatter opcional (name/description/command — o
 * formato gerado pelo botão Baixar) + corpo markdown. Sem frontmatter, o
 * arquivo inteiro vira o conteúdo.
 */
function parseSkillFile(raw: string): {
  name?: string;
  description?: string;
  command?: string;
  content: string;
} {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!fm) return { content: raw.trim() };
  const fields: Record<string, string> = {};
  for (const line of fm[1].split(/\r?\n/)) {
    const m = /^(name|description|command)\s*:\s*(.*)$/.exec(line.trim());
    if (m) fields[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { ...fields, content: raw.slice(fm[0].length).trim() };
}

export function SkillsPage() {
  const skills = useCatalog((s) => s.skills);
  const loadSkills = useCatalog((s) => s.loadSkills);
  const session = useSessions((s) => s.current);
  const viewProjectId = useSessions((s) => s.viewProjectId);
  const projects = useSessions((s) => s.projects);
  const toast = useUi((s) => s.toast);
  const confirm = useUi((s) => s.confirm);
  const [filter, setFilter] = useState<ScopeFilter>('all');
  const [draft, setDraft] = useState<Draft | undefined>();
  const [expandContent, setExpandContent] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const contextProjectId = session?.projectId ?? viewProjectId ?? undefined;
  const projectName = (id?: string) => projects.find((p) => p.id === id)?.name ?? 'projeto';
  // quando o filtro aponta para um projeto (não é um dos agregadores fixos)
  const filterProjectId =
    filter !== 'all' && filter !== 'global' && filter !== 'bmad' ? filter : undefined;

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const hasBmad = useMemo(() => skills.some((s) => isBmadAsset(s.id)), [skills]);

  // as skills BMAD (auto-registradas) só aparecem no agregador delas,
  // para não poluir "Todos" e "Globais"
  const filtered = useMemo(() => {
    if (filter === 'bmad') return skills.filter((s) => isBmadAsset(s.id));
    const own = skills.filter((s) => !isBmadAsset(s.id));
    if (filter === 'all') return own;
    if (filter === 'global') return own.filter((s) => s.scope === 'global');
    return own.filter((s) => s.projectId === filter);
  }, [skills, filter]);

  const newDraft = () =>
    setDraft({
      ...EMPTY,
      // pré-seleciona o escopo conforme o filtro/contexto atual
      scope: filterProjectId ? 'project' : 'global',
      projectId: filterProjectId ?? contextProjectId ?? projects[0]?.id,
    });

  // importa um .md: o conteúdo vai para o editor e o usuário completa
  // nome, comando, escopo e descrição antes de salvar
  const importFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseSkillFile(String(reader.result ?? ''));
      if (!parsed.content) {
        toast('O arquivo está vazio.', 'error');
        return;
      }
      setDraft({
        scope: filterProjectId ? 'project' : 'global',
        projectId: filterProjectId ?? contextProjectId ?? projects[0]?.id,
        name: parsed.name ?? file.name.replace(/\.(md|markdown|txt)$/i, ''),
        description: parsed.description ?? '',
        command: parsed.command ?? '',
        content: parsed.content,
      });
      toast('Conteúdo importado — revise os campos e salve.', 'ok');
    };
    reader.onerror = () => toast('Não foi possível ler o arquivo.', 'error');
    reader.readAsText(file);
  };

  // baixa a skill como .md com frontmatter (re-importável pelo botão Importar)
  const download = async (skill: Skill) => {
    try {
      const full = await api.getSkill(skill.id);
      const command = full.command ?? slugifyCommand(full.name);
      const md = `---\nname: ${full.name}\ndescription: ${full.description}\ncommand: ${command}\n---\n\n${full.content}\n`;
      const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${command}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const emailShare = async (id: string) => {
    try {
      const result = await api.shareByEmail('skill', id);
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

  const edit = async (skill: Skill) => {
    try {
      const full = await api.getSkill(skill.id);
      setDraft({
        id: full.id,
        scope: full.scope,
        projectId: full.projectId,
        name: full.name,
        description: full.description,
        command: full.command ?? '',
        content: full.content,
      });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const remove = async (skill: Skill) => {
    const ok = await confirm({
      title: 'Excluir skill',
      message: `Excluir a skill "${skill.name}"?`,
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!ok) return;
    await api.deleteSkill(skill.id);
    if (draft?.id === skill.id) setDraft(undefined);
    await loadSkills();
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const payload: Partial<SkillWithContent> = {
        scope: draft.scope,
        projectId: draft.scope === 'project' ? draft.projectId : undefined,
        name: draft.name.trim(),
        description: draft.description.trim(),
        command: draft.command.trim().replace(/^\//, '') || undefined,
        content: draft.content,
      };
      if (draft.id) await api.patchSkill(draft.id, payload);
      else await api.createSkill(payload);
      toast('Skill salva.', 'ok');
      setDraft(undefined);
      await loadSkills();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageShell
      icon="⚡"
      title="Skills"
      subtitle="Instruções reutilizáveis em markdown. Toda skill pode ser ativada no contexto da conversa ou invocada por /comando."
      actions={
        <>
          <input
            ref={fileInput}
            type="file"
            accept=".md,.markdown,.txt"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importFile(file);
              e.target.value = '';
            }}
          />
          <button className="btn" onClick={() => fileInput.current?.click()}>
            ⬆ Importar .md
          </button>
          <button className="btn btn--primary" onClick={newDraft}>
            ＋ Nova skill
          </button>
        </>
      }
    >
      <div className="page-cols">
        <Panel
          title="Biblioteca"
          count={filtered.length}
          actions={
            <Select
              compact
              align="right"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: hasBmad ? 'Todos (sem BMAD)' : 'Todos os escopos' },
                { value: 'global', label: '🌐 Globais' },
                ...(hasBmad ? [{ value: 'bmad', label: '🅱️ BMAD' }] : []),
                ...projects.map((p) => ({ value: p.id, label: `📁 ${p.name}` })),
              ]}
            />
          }
        >
          {filtered.length === 0 && (
            <EmptyState
              icon="⚡"
              title={filter === 'all' ? 'Nenhuma skill ainda' : 'Nada neste escopo'}
              hint={
                <>
                  Skills são instruções reutilizáveis (markdown): ative no menu Skills da conversa
                  ou invoque por <code>/comando</code>. Você também pode pedir no chat com{' '}
                  <code>/criar-skill</code>.
                </>
              }
              action={
                <button className="btn btn--primary" onClick={newDraft}>
                  ＋ Criar primeira skill
                </button>
              }
            />
          )}
          {filtered.map((skill) => (
            <button
              className={`page-list-item${draft?.id === skill.id ? ' page-list-item--active' : ''}`}
              key={skill.id}
              onClick={() => void edit(skill)}
            >
              <span className="page-list-item__meta">
                <span className="item-card__tag item-card__tag--cmd">
                  /{skill.command ?? slugifyCommand(skill.name)}
                </span>
                <span
                  className={`scope-badge${skill.scope === 'project' ? ' scope-badge--project' : ''}`}
                >
                  {isBmadAsset(skill.id)
                    ? '🅱️ BMAD'
                    : skill.scope === 'project'
                      ? `📁 ${projectName(skill.projectId)}`
                      : '🌐 Global'}
                </span>
              </span>
              <span className="item-card__name">{skill.name}</span>
              <span className="item-card__desc">{skill.description || '—'}</span>
              <span className="page-list-item__actions">
                <span
                  role="button"
                  className="mini-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    void download(skill);
                  }}
                >
                  ⬇ Baixar
                </span>
                {!isBmadAsset(skill.id) && (
                  <span
                    role="button"
                    className="mini-btn"
                    title="Enviar por email (abre o cliente com o .md anexado — re-importável pelo botão Importar)"
                    onClick={(e) => {
                      e.stopPropagation();
                      void emailShare(skill.id);
                    }}
                  >
                    ✉️
                  </span>
                )}
                <span
                  role="button"
                  className="mini-btn mini-btn--danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    void remove(skill);
                  }}
                >
                  Excluir
                </span>
              </span>
            </button>
          ))}
        </Panel>

        {draft ? (
          <Panel title={draft.id ? 'Editar skill' : 'Nova skill'} className="panel--form">
            <div className="row">
              <div className="field">
                <label>Nome</label>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="ex: Tom executivo"
                />
              </div>
              <div className="field">
                <label>Comando slash</label>
                <input
                  value={draft.command}
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  placeholder={draft.name.trim() ? `/${slugifyCommand(draft.name)}` : '/comando (auto)'}
                />
              </div>
            </div>
            <div className="row">
              <div className="field">
                <label>Escopo</label>
                <Select
                  value={draft.scope}
                  disabled={!!draft.id}
                  onChange={(value) => {
                    const scope = value as Draft['scope'];
                    setDraft({
                      ...draft,
                      scope,
                      projectId:
                        scope === 'project'
                          ? draft.projectId ?? contextProjectId ?? projects[0]?.id
                          : draft.projectId,
                    });
                  }}
                  options={[
                    { value: 'global', label: '🌐 Global', hint: 'Vale em todas as conversas' },
                    {
                      value: 'project',
                      label: '📁 Projeto',
                      hint: 'Só nas conversas do projeto',
                      disabled: projects.length === 0,
                    },
                  ]}
                />
              </div>
              {draft.scope === 'project' && (
                <div className="field">
                  <label>Projeto</label>
                  <Select
                    value={draft.projectId ?? ''}
                    disabled={!!draft.id}
                    onChange={(value) => setDraft({ ...draft, projectId: value })}
                    options={projects.map((p) => ({ value: p.id, label: `📁 ${p.name}` }))}
                  />
                </div>
              )}
            </div>
            <div className="field">
              <label>Descrição</label>
              <input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="O que esta skill faz"
              />
            </div>
            <div className="field page-card__grow">
              <div className="field__label-row">
                <label>Conteúdo (markdown — use {'{{input}}'} para o texto digitado após o /comando)</label>
                <button
                  className="btn btn--sm btn--ghost"
                  onClick={() => setExpandContent(true)}
                  title="Editar em tela cheia (com visualização do markdown)"
                >
                  ⤢ Expandir
                </button>
              </div>
              <textarea
                className="page-card__editor"
                value={draft.content}
                onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                placeholder={'Resuma o texto a seguir em 5 bullets:\n\n{{input}}'}
              />
            </div>
            <div className="form-actions">
              <button className="btn" onClick={() => setDraft(undefined)}>
                Cancelar
              </button>
              <button
                className="btn btn--primary"
                disabled={
                  busy || !draft.name.trim() || (draft.scope === 'project' && !draft.projectId)
                }
                onClick={() => void save()}
              >
                Salvar skill
              </button>
            </div>
          </Panel>
        ) : (
          <Panel className="panel--placeholder">
            <EmptyState
              icon="✏️"
              title="Nenhuma skill selecionada"
              hint="Selecione uma skill ao lado para editar, ou crie uma nova."
            />
          </Panel>
        )}
      </div>

      {draft && expandContent && (
        <MarkdownEditorModal
          title={`Conteúdo da skill${draft.name.trim() ? ` "${draft.name.trim()}"` : ''} (markdown)`}
          value={draft.content}
          onChange={(value) => setDraft({ ...draft, content: value })}
          placeholder={'Resuma o texto a seguir em 5 bullets:\n\n{{input}}'}
          onClose={() => setExpandContent(false)}
        />
      )}
    </PageShell>
  );
}

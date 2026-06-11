import { useEffect, useState } from 'react';
import type { Skill, SkillWithContent } from '@aiportal/shared';
import { api } from '../../api/client';
import { useCatalog } from '../../stores/catalogStore';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';
import { PageShell } from './PageShell';

interface Draft {
  id?: string;
  kind: 'instruction' | 'command';
  scope: 'global' | 'project';
  name: string;
  description: string;
  command: string;
  content: string;
}

const EMPTY: Draft = {
  kind: 'instruction',
  scope: 'global',
  name: '',
  description: '',
  command: '',
  content: '',
};

export function SkillsPage() {
  const skills = useCatalog((s) => s.skills);
  const loadSkills = useCatalog((s) => s.loadSkills);
  const session = useSessions((s) => s.current);
  const viewProjectId = useSessions((s) => s.viewProjectId);
  const projects = useSessions((s) => s.projects);
  const toast = useUi((s) => s.toast);
  const [draft, setDraft] = useState<Draft | undefined>();
  const [busy, setBusy] = useState(false);

  const projectId = session?.projectId ?? viewProjectId ?? undefined;
  const projectName = projects.find((p) => p.id === projectId)?.name;

  useEffect(() => {
    void loadSkills(projectId);
  }, [loadSkills, projectId]);

  const edit = async (skill: Skill) => {
    try {
      const full = await api.getSkill(skill.id);
      setDraft({
        id: full.id,
        kind: full.kind,
        scope: full.scope,
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
    if (!window.confirm(`Excluir a skill "${skill.name}"?`)) return;
    await api.deleteSkill(skill.id);
    if (draft?.id === skill.id) setDraft(undefined);
    await loadSkills(projectId);
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const payload: Partial<SkillWithContent> = {
        kind: draft.kind,
        scope: draft.scope,
        projectId: draft.scope === 'project' ? projectId : undefined,
        name: draft.name.trim(),
        description: draft.description.trim(),
        command: draft.kind === 'command' ? draft.command.trim().replace(/^\//, '') : undefined,
        content: draft.content,
      };
      if (draft.id) await api.patchSkill(draft.id, payload);
      else await api.createSkill(payload);
      toast('Skill salva.', 'ok');
      setDraft(undefined);
      await loadSkills(projectId);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageShell
      title="Skills"
      subtitle="Instruções reutilizáveis injetadas no contexto e comandos slash (ex: /resumir)."
      actions={
        <button className="btn btn--primary" onClick={() => setDraft({ ...EMPTY })}>
          ＋ Nova skill
        </button>
      }
    >
      <div className="page-cols">
        <div>
          {skills.length === 0 && (
            <div className="empty-state">
              Crie skills para reaproveitar instruções ou comandos slash.
            </div>
          )}
          {skills.map((skill) => (
            <button
              className={`page-list-item${draft?.id === skill.id ? ' page-list-item--active' : ''}`}
              key={skill.id}
              onClick={() => void edit(skill)}
            >
              <span className={`item-card__tag${skill.kind === 'command' ? ' item-card__tag--cmd' : ''}`}>
                {skill.kind === 'command' ? `/${skill.command}` : 'instrução'}
                {skill.scope === 'project' ? ' · projeto' : ''}
              </span>
              <span className="item-card__name">{skill.name}</span>
              <span className="item-card__desc">{skill.description || '—'}</span>
              <span className="page-list-item__actions">
                <span
                  role="button"
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
        </div>
        {draft ? (
          <div className="page-card">
            <h3 className="page-card__title">{draft.id ? 'Editar skill' : 'Nova skill'}</h3>
            <div className="row">
              <div className="field">
                <label>Tipo</label>
                <select
                  value={draft.kind}
                  disabled={!!draft.id}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value as Draft['kind'] })}
                >
                  <option value="instruction">Instrução (injetada no contexto)</option>
                  <option value="command">Comando slash (template)</option>
                </select>
              </div>
              <div className="field">
                <label>Escopo</label>
                <select
                  value={draft.scope}
                  disabled={!!draft.id}
                  onChange={(e) => setDraft({ ...draft, scope: e.target.value as Draft['scope'] })}
                >
                  <option value="global">Global</option>
                  <option value="project" disabled={!projectId}>
                    {projectName ? `Projeto: ${projectName}` : 'Projeto atual'}
                  </option>
                </select>
              </div>
            </div>
            <div className="row">
              <div className="field">
                <label>Nome</label>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="ex: Tom executivo"
                />
              </div>
              {draft.kind === 'command' && (
                <div className="field">
                  <label>Comando (sem a barra)</label>
                  <input
                    value={draft.command}
                    onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                    placeholder="ex: resumir"
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
              <label>
                {draft.kind === 'command'
                  ? 'Template (use {{input}} para o texto digitado após o comando)'
                  : 'Instruções (markdown)'}
              </label>
              <textarea
                className="page-card__editor"
                value={draft.content}
                onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                placeholder={
                  draft.kind === 'command'
                    ? 'Resuma o texto a seguir em 5 bullets:\n\n{{input}}'
                    : 'Sempre responda em formato de relatório executivo…'
                }
              />
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn--ghost" onClick={() => setDraft(undefined)}>
                Cancelar
              </button>
              <button
                className="btn btn--primary"
                disabled={
                  busy || !draft.name.trim() || (draft.kind === 'command' && !draft.command.trim())
                }
                onClick={() => void save()}
              >
                Salvar skill
              </button>
            </div>
          </div>
        ) : (
          <div className="empty-state page-card page-card--placeholder">
            Selecione uma skill ao lado para editar, ou crie uma nova.
          </div>
        )}
      </div>
    </PageShell>
  );
}

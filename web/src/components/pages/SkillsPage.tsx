import { useEffect, useMemo, useRef, useState } from 'react';
import type { Skill, SkillWithContent } from '@aiportal/shared';
import { isBmadAsset, slugifyCommand } from '@aiportal/shared';
import { api } from '../../api/client';
import { useCatalog } from '../../stores/catalogStore';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';
import { MarkdownEditorModal } from '../common/MarkdownEditorModal';
import { parseSkillZip } from '../../lib/skillZipImport';
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
  /** Anexos da pasta da skill (só em skills já salvas). */
  files?: string[];
  /** Anexos vindos de um import .zip — gravados quando a skill for salva. */
  pendingFiles?: Array<{ path: string; base64: string }>;
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
  const assetInput = useRef<HTMLInputElement>(null);

  const uploadAsset = async (file: File) => {
    if (!draft?.id) return;
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const updated = await api.uploadSkillFile(draft.id, file.name, btoa(bin));
      setDraft((d) => (d && d.id === updated.id ? { ...d, files: updated.files } : d));
      toast('Anexo adicionado à skill.', 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async () => {
    if (!draft?.id) return;
    try {
      await api.revealSkillFolder(draft.id);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  // resumo compacto dos anexos: "a.md, refs/b.md e mais 12"
  const assetSummary = (paths: string[]) => {
    const names = paths.slice(0, 3).join(', ');
    return paths.length > 3 ? `${names} e mais ${paths.length - 3}` : names;
  };

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

  const draftBase = () => ({
    scope: (filterProjectId ? 'project' : 'global') as 'global' | 'project',
    projectId: filterProjectId ?? contextProjectId ?? projects[0]?.id,
  });

  // importa um .md (ou .skill.zip com anexos): o conteúdo vai para o editor e
  // o usuário completa nome, comando, escopo e descrição antes de salvar
  const importFile = async (file: File) => {
    try {
      if (/\.zip$/i.test(file.name)) {
        const JSZip = (await import('jszip')).default;
        const zip = await JSZip.loadAsync(await file.arrayBuffer());
        // aceita o .skill.zip do portal E uma pasta de skill zipada do disco
        // (skill.md/SKILL.md em qualquer caixa, mesmo dentro de uma subpasta)
        const result = await parseSkillZip(zip);
        if (!result) {
          toast('O zip não contém um skill.md/SKILL.md — não é um zip de skill.', 'error');
          return;
        }
        const parsed = parseSkillFile(result.markdown);
        setDraft({
          ...draftBase(),
          name: parsed.name ?? file.name.replace(/\.(skill\.)?zip$/i, ''),
          description: parsed.description ?? '',
          command: parsed.command ?? '',
          content: parsed.content,
          pendingFiles: result.files.length ? result.files : undefined,
        });
        toast(
          result.files.length
            ? `Skill importada com ${result.files.length} anexo(s) — revise e salve para gravar tudo.`
            : 'Conteúdo importado — revise os campos e salve.',
          'ok',
        );
        return;
      }
      const parsed = parseSkillFile(await file.text());
      if (!parsed.content) {
        toast('O arquivo está vazio.', 'error');
        return;
      }
      setDraft({
        ...draftBase(),
        name: parsed.name ?? file.name.replace(/\.(md|markdown|txt)$/i, ''),
        description: parsed.description ?? '',
        command: parsed.command ?? '',
        content: parsed.content,
      });
      toast('Conteúdo importado — revise os campos e salve.', 'ok');
    } catch {
      toast('Não foi possível ler o arquivo.', 'error');
    }
  };

  // baixa a skill: .md com frontmatter, ou .skill.zip quando ela tem anexos
  // (os dois re-importáveis pelo botão Importar)
  const download = async (skill: Skill) => {
    try {
      const full = await api.getSkill(skill.id);
      const command = full.command ?? slugifyCommand(full.name);
      if (full.files?.length) {
        await api.downloadSkillExport(skill.id, `${command}.skill.zip`);
        return;
      }
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
        files: full.files,
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
      const saved = draft.id
        ? await api.patchSkill(draft.id, payload)
        : await api.createSkill(payload);
      // anexos que vieram de um import .zip entram depois que a skill existe
      for (const file of draft.pendingFiles ?? []) {
        await api.uploadSkillFile(saved.id, file.path, file.base64);
      }
      toast(
        draft.pendingFiles?.length
          ? `Skill salva com ${draft.pendingFiles.length} anexo(s).`
          : 'Skill salva.',
        'ok',
      );
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
            accept=".md,.markdown,.txt,.zip"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importFile(file);
              e.target.value = '';
            }}
          />
          <button className="btn" onClick={() => fileInput.current?.click()}>
            ⬆ Importar (.md ou .zip)
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
            <div className="field">
              <div className="field__label-row">
                <label>
                  Anexos
                  {(draft.files?.length ?? 0) + (draft.pendingFiles?.length ?? 0) > 0 &&
                    ` (${(draft.files?.length ?? 0) + (draft.pendingFiles?.length ?? 0)})`}{' '}
                  — referências e templates que o modelo lê sob demanda
                </label>
                {draft.id && (
                  <span style={{ display: 'flex', gap: 6 }}>
                    <button
                      className="btn btn--sm btn--ghost"
                      title="Abrir a pasta da skill no gerenciador de arquivos — os anexos ficam lá"
                      onClick={() => void openFolder()}
                    >
                      📂 Abrir pasta
                    </button>
                    <button
                      className="btn btn--sm btn--ghost"
                      disabled={busy}
                      onClick={() => assetInput.current?.click()}
                    >
                      ⬆ Anexar arquivo
                    </button>
                  </span>
                )}
              </div>
              <input
                ref={assetInput}
                type="file"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void uploadAsset(file);
                  e.target.value = '';
                }}
              />
              <p className="page-hint" style={{ margin: 0 }} title={[...(draft.files ?? []), ...(draft.pendingFiles ?? []).map((f) => f.path)].join('\n') || undefined}>
                {draft.id
                  ? (draft.files?.length ?? 0) > 0
                    ? `📎 Esta skill tem ${draft.files!.length} arquivo(s) de apoio (${assetSummary(draft.files!)}). Use "Abrir pasta" para ver, editar ou remover.`
                    : 'Nenhum anexo — esta skill é só o markdown acima.'
                  : (draft.pendingFiles?.length ?? 0) > 0
                    ? `📎 ${draft.pendingFiles!.length} arquivo(s) vieram do import (${assetSummary(draft.pendingFiles!.map((f) => f.path))}) e serão gravados na pasta da skill quando você salvar.`
                    : 'Salve a skill primeiro — depois dá para anexar arquivos à pasta dela.'}
              </p>
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

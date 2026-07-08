import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  Folder,
  FolderOpen,
  Globe,
  Mail,
  Maximize2,
  Pencil,
  Plus,
  Search,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import type { Skill } from '@aiportal/shared';
import { UPLOAD_LIMITS, formatByteLimit, isBmadAsset, slugifyCommand } from '@aiportal/shared';
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

/** Limite de um anexo da pasta da skill (o servidor recusa acima disso). */
const ASSET_LIMIT_LABEL = formatByteLimit(UPLOAD_LIMITS.skillFileBytes);

/** Campos extraídos de um arquivo importado (.md/.txt ou .skill.zip). */
interface ParsedImport {
  name: string;
  description: string;
  command: string;
  content: string;
  pendingFiles?: Array<{ path: string; base64: string }>;
}

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
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft | undefined>();
  const [expandContent, setExpandContent] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const assetInput = useRef<HTMLInputElement>(null);

  const uploadAsset = async (file: File) => {
    if (!draft?.id) return;
    if (file.size > UPLOAD_LIMITS.skillFileBytes) {
      toast(`"${file.name}" passa do limite de ${ASSET_LIMIT_LABEL} e não foi anexado.`, 'error');
      return;
    }
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
  const scoped = useMemo(() => {
    if (filter === 'bmad') return skills.filter((s) => isBmadAsset(s.id));
    const own = skills.filter((s) => !isBmadAsset(s.id));
    if (filter === 'all') return own;
    if (filter === 'global') return own.filter((s) => s.scope === 'global');
    return own.filter((s) => s.projectId === filter);
  }, [skills, filter]);

  // busca por nome/comando/descrição, aplicada por cima do filtro de escopo
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      needle
        ? scoped.filter(
            (s) =>
              s.name.toLowerCase().includes(needle) ||
              (s.command ?? slugifyCommand(s.name)).toLowerCase().includes(needle) ||
              s.description.toLowerCase().includes(needle),
          )
        : scoped,
    [scoped, needle],
  );

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

  /** Lê e interpreta um arquivo de import (.md/.txt ou .skill.zip). Lança erro legível. */
  const parseImportFile = async (file: File): Promise<ParsedImport> => {
    if (/\.zip$/i.test(file.name)) {
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      // aceita o .skill.zip do portal E uma pasta de skill zipada do disco
      // (skill.md/SKILL.md em qualquer caixa, mesmo dentro de uma subpasta)
      const result = await parseSkillZip(zip);
      if (!result) {
        throw new Error('o zip não contém um skill.md/SKILL.md — não é um zip de skill.');
      }
      const parsed = parseSkillFile(result.markdown);
      return {
        name: parsed.name ?? file.name.replace(/\.(skill\.)?zip$/i, ''),
        description: parsed.description ?? '',
        command: parsed.command ?? '',
        content: parsed.content,
        pendingFiles: result.files.length ? result.files : undefined,
      };
    }
    const parsed = parseSkillFile(await file.text());
    if (!parsed.content) throw new Error('o arquivo está vazio.');
    return {
      name: parsed.name ?? file.name.replace(/\.(md|markdown|txt)$/i, ''),
      description: parsed.description ?? '',
      command: parsed.command ?? '',
      content: parsed.content,
    };
  };

  // importa um .md (ou .skill.zip com anexos): o conteúdo vai para o editor e
  // o usuário completa nome, comando, escopo e descrição antes de salvar
  const importFile = async (file: File) => {
    try {
      const parsed = await parseImportFile(file);
      setDraft({ ...draftBase(), ...parsed });
      toast(
        parsed.pendingFiles?.length
          ? `Skill importada com ${parsed.pendingFiles.length} anexo(s) — revise e salve para gravar tudo.`
          : 'Conteúdo importado — revise os campos e salve.',
        'ok',
      );
    } catch (err) {
      toast(`"${file.name}": ${(err as Error).message || 'não foi possível ler o arquivo.'}`, 'error');
    }
  };

  // vários arquivos de uma vez: cada um vira uma skill salva direto (sem passar
  // pelo editor), no escopo do filtro/contexto atual — mesmo padrão da AgentsPage
  const importFiles = async (files: FileList) => {
    const list = Array.from(files);
    if (list.length === 1) {
      await importFile(list[0]);
      return;
    }
    setBusy(true);
    let okCount = 0;
    const base = draftBase();
    for (const file of list) {
      try {
        const parsed = await parseImportFile(file);
        const saved = await api.createSkill({
          scope: base.scope,
          projectId: base.scope === 'project' ? base.projectId : undefined,
          name: parsed.name,
          description: parsed.description,
          command: parsed.command || undefined,
          content: parsed.content,
        });
        for (const pending of parsed.pendingFiles ?? []) {
          await api.uploadSkillFile(saved.id, pending.path, pending.base64);
        }
        okCount++;
      } catch (err) {
        toast(`"${file.name}": ${(err as Error).message || 'não foi possível ler o arquivo.'}`, 'error');
      }
    }
    if (okCount) {
      await loadSkills();
      toast(
        `${okCount} skill${okCount === 1 ? ' importada' : 's importadas'} — revise nome/escopo se precisar.`,
        'ok',
      );
    }
    setBusy(false);
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
      const payload = {
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
      icon={<Zap className="icon icon--lg" aria-hidden />}
      title="Skills"
      subtitle="Instruções reutilizáveis em markdown. Toda skill pode ser ativada no contexto da conversa ou invocada por /comando."
      actions={
        <>
          <input
            ref={fileInput}
            type="file"
            accept=".md,.markdown,.txt,.zip"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files?.length) void importFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <button
            className="btn"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
            title="Importar skills (.md ou .skill.zip) — vários arquivos de uma vez criam as skills direto"
          >
            <Upload className="icon" aria-hidden /> Importar (.md ou .zip)
          </button>
          <button className="btn btn--primary" onClick={newDraft}>
            <Plus className="icon" aria-hidden /> Nova skill
          </button>
        </>
      }
    >
      <div className="page-cols">
        <Panel
          title="Biblioteca"
          count={filtered.length}
          actions={
            <>
              <div className="panel-search">
                <Search className="icon icon--sm" aria-hidden />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar…"
                  aria-label="Buscar skill por nome, comando ou descrição"
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
              <Select
              compact
              align="right"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: hasBmad ? 'Todos (sem BMAD)' : 'Todos os escopos' },
                { value: 'global', label: <><Globe className="icon" aria-hidden /> Globais</> },
                ...(hasBmad ? [{ value: 'bmad', label: 'BMAD' }] : []),
                ...projects.map((p) => ({
                  value: p.id,
                  label: <><Folder className="icon" aria-hidden /> {p.name}</>,
                })),
              ]}
              />
            </>
          }
        >
          {filtered.length === 0 && !(draft && !draft.id) && (
            <EmptyState
              icon={<Zap className="icon icon--lg" aria-hidden />}
              title={
                needle
                  ? 'Nada encontrado na busca'
                  : filter === 'all'
                    ? 'Nenhuma skill ainda'
                    : 'Nada neste escopo'
              }
              hint={
                <>
                  Skills são instruções reutilizáveis (markdown): ative no menu Skills da conversa
                  ou invoque por <code>/comando</code>. Você também pode pedir no chat com{' '}
                  <code>/criar-skill</code>.
                </>
              }
              action={
                <button className="btn btn--primary" onClick={newDraft}>
                  <Plus className="icon" aria-hidden /> Criar primeira skill
                </button>
              }
            />
          )}
          {draft && !draft.id && (
            <div className="page-list-item page-list-item--active page-list-item--draft">
              <span className="page-list-item__meta">
                <span
                  className={`scope-badge${draft.scope === 'project' ? ' scope-badge--project' : ''}`}
                >
                  {draft.scope === 'project' ? (
                    <>
                      <Folder className="icon icon--sm" aria-hidden />{' '}
                      {projectName(draft.projectId)}
                    </>
                  ) : (
                    <>
                      <Globe className="icon icon--sm" aria-hidden /> Global
                    </>
                  )}
                </span>
                <span className="mcp-status">rascunho</span>
              </span>
              <span className="item-card__name">{draft.name.trim() || 'Nova skill'}</span>
              <span className="item-card__desc">
                {draft.description.trim() || 'Preencha ao lado e salve.'}
              </span>
              <span className="page-list-item__actions">
                <span role="button" className="mini-btn" onClick={() => setDraft(undefined)}>
                  Descartar
                </span>
              </span>
            </div>
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
                  {isBmadAsset(skill.id) ? (
                    'BMAD'
                  ) : skill.scope === 'project' ? (
                    <>
                      <Folder className="icon icon--sm" aria-hidden />{' '}
                      {projectName(skill.projectId)}
                    </>
                  ) : (
                    <>
                      <Globe className="icon icon--sm" aria-hidden /> Global
                    </>
                  )}
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
                  <Download className="icon icon--sm" aria-hidden /> Baixar
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
                    <Mail className="icon" aria-hidden />
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
                  // skills BMAD são gerenciadas pela integração; as demais podem
                  // trocar de escopo mesmo depois de criadas (a pasta é movida)
                  disabled={!!draft.id && isBmadAsset(draft.id)}
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
                    {
                      value: 'global',
                      label: <><Globe className="icon" aria-hidden /> Global</>,
                      hint: 'Vale em todas as conversas',
                    },
                    {
                      value: 'project',
                      label: <><Folder className="icon" aria-hidden /> Projeto</>,
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
                    disabled={!!draft.id && isBmadAsset(draft.id)}
                    onChange={(value) => setDraft({ ...draft, projectId: value })}
                    options={projects.map((p) => ({
                      value: p.id,
                      label: <><Folder className="icon" aria-hidden /> {p.name}</>,
                    }))}
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
                  <Maximize2 className="icon" aria-hidden /> Expandir
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
                      <FolderOpen className="icon" aria-hidden /> Abrir pasta
                    </button>
                    <button
                      className="btn btn--sm btn--ghost"
                      disabled={busy}
                      title={`Anexar um arquivo à pasta da skill — até ${ASSET_LIMIT_LABEL}`}
                      onClick={() => assetInput.current?.click()}
                    >
                      <Upload className="icon" aria-hidden /> Anexar arquivo
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
                    ? `Esta skill tem ${draft.files!.length} arquivo(s) de apoio (${assetSummary(draft.files!)}). Use "Abrir pasta" para ver, editar ou remover.`
                    : 'Nenhum anexo — esta skill é só o markdown acima.'
                  : (draft.pendingFiles?.length ?? 0) > 0
                    ? `${draft.pendingFiles!.length} arquivo(s) vieram do import (${assetSummary(draft.pendingFiles!.map((f) => f.path))}) e serão gravados na pasta da skill quando você salvar.`
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
              icon={<Pencil className="icon icon--lg" aria-hidden />}
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

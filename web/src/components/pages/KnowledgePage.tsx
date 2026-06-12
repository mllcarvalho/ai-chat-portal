import { useEffect, useRef, useState } from 'react';
import { slugifyCommand, type KnowledgeBase, type KnowledgeDoc } from '@aiportal/shared';
import { api } from '../../api/client';
import { extractDocumentText, isConvertibleDocument } from '../../lib/extractDocument';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';
import { Select } from '../common/Select';
import { EmptyState, PageShell, Panel } from './PageShell';

export function KnowledgePage() {
  const toast = useUi((s) => s.toast);
  const confirm = useUi((s) => s.confirm);
  const session = useSessions((s) => s.current);
  const viewProjectId = useSessions((s) => s.viewProjectId);
  const projects = useSessions((s) => s.projects);

  const projectId = session?.projectId ?? viewProjectId ?? undefined;
  const projectName = projects.find((p) => p.id === projectId)?.name;

  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [selected, setSelected] = useState<KnowledgeBase | undefined>();
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [docName, setDocName] = useState('');
  const [docContent, setDocContent] = useState('');
  const [newBaseName, setNewBaseName] = useState('');
  const [newBaseScope, setNewBaseScope] = useState<'global' | 'project'>('global');
  const [busy, setBusy] = useState(false);
  const [urlFormOpen, setUrlFormOpen] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteName, setRemoteName] = useState('');
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const reload = async () => {
    const list = await api.listKnowledge(projectId).catch(() => [] as KnowledgeBase[]);
    setBases(list);
    if (selected) {
      const still = list.find((b) => b.id === selected.id);
      setSelected(still);
      if (!still) setDocs([]);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const select = async (base: KnowledgeBase) => {
    setSelected(base);
    setDocName('');
    setDocContent('');
    setUrlFormOpen(false);
    setDocs(await api.listKnowledgeDocs(base.id).catch(() => []));
  };

  const createBase = async () => {
    if (!newBaseName.trim()) return;
    setBusy(true);
    try {
      const base = await api.createKnowledgeBase({
        name: newBaseName.trim(),
        scope: newBaseScope,
        projectId: newBaseScope === 'project' ? projectId : undefined,
      });
      setNewBaseName('');
      await reload();
      await select(base);
      toast('Base criada.', 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const exportBase = async (base: KnowledgeBase) => {
    try {
      await api.exportKnowledgeBase(base.id, `${slugifyCommand(base.name) || 'base'}.zip`);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const importBase = async (file: File) => {
    setBusy(true);
    try {
      const zipBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(new Error('Falha ao ler o arquivo'));
        reader.readAsDataURL(file);
      });
      const base = await api.importKnowledgeBase(zipBase64, {
        name: file.name.replace(/\.zip$/i, ''),
        scope: newBaseScope,
        projectId: newBaseScope === 'project' ? projectId : undefined,
      });
      await reload();
      await select(base);
      toast(
        `Base "${base.name}" importada/atualizada (${base.docCount} documento${base.docCount === 1 ? '' : 's'}).`,
        'ok',
      );
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleBase = async (base: KnowledgeBase) => {
    const updated = await api.patchKnowledgeBase(base.id, { enabled: !base.enabled });
    setBases((list) => list.map((b) => (b.id === updated.id ? updated : b)));
    if (selected?.id === updated.id) setSelected(updated);
  };

  const removeBase = async (base: KnowledgeBase) => {
    const ok = await confirm({
      title: 'Excluir base',
      message: `Excluir a base "${base.name}" e todos os seus documentos?`,
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!ok) return;
    await api.deleteKnowledgeBase(base.id);
    if (selected?.id === base.id) {
      setSelected(undefined);
      setDocs([]);
    }
    await reload();
  };

  const openDoc = async (doc: KnowledgeDoc) => {
    if (!selected) return;
    try {
      const { content } = await api.readKnowledgeDoc(selected.id, doc.name);
      setDocName(doc.name);
      setDocContent(content);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const saveDoc = async () => {
    if (!selected || !docName.trim()) return;
    setBusy(true);
    try {
      let name = docName.trim();
      if (!/\.(md|txt)$/i.test(name)) name = `${name}.md`;
      await api.writeKnowledgeDoc(selected.id, name, docContent);
      setDocName(name);
      setDocs(await api.listKnowledgeDocs(selected.id));
      await reload();
      toast('Documento salvo.', 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const uploadDocs = async (files: FileList) => {
    if (!selected) return;
    setBusy(true);
    let okCount = 0;
    for (const file of Array.from(files)) {
      try {
        let name = file.name;
        let content: string;
        if (isConvertibleDocument(name)) {
          content = await extractDocumentText(file);
          // o servidor só armazena .md/.txt — o documento vira markdown
          name = name.replace(/\.[^.]+$/, '.md');
        } else if (/\.(md|txt)$/i.test(name)) {
          content = await file.text();
        } else {
          toast(`"${name}" ignorado — use .md, .txt, Excel, Word ou PDF.`, 'info');
          continue;
        }
        await api.writeKnowledgeDoc(selected.id, name, content);
        okCount++;
      } catch (err) {
        toast(`"${file.name}": ${(err as Error).message}`, 'error');
      }
    }
    if (okCount) {
      setDocs(await api.listKnowledgeDocs(selected.id));
      await reload();
      toast(`${okCount} documento${okCount === 1 ? '' : 's'} enviado${okCount === 1 ? '' : 's'}.`, 'ok');
    }
    setBusy(false);
  };

  const addRemoteDoc = async () => {
    if (!selected || !remoteUrl.trim()) return;
    setBusy(true);
    try {
      const doc = await api.addRemoteKnowledgeDoc(
        selected.id,
        remoteUrl.trim(),
        remoteName.trim() || undefined,
      );
      setRemoteUrl('');
      setRemoteName('');
      setUrlFormOpen(false);
      setDocs(await api.listKnowledgeDocs(selected.id));
      await reload();
      toast(`"${doc.name}" adicionado e sincronizado.`, 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const syncDocs = async (name?: string) => {
    if (!selected) return;
    setBusy(true);
    try {
      const { docs: updated, errors } = await api.syncKnowledgeDocs(selected.id, name);
      setDocs(updated);
      await reload();
      // o documento aberto no editor pode ter sido atualizado pelo sync
      if (docName && updated.some((d) => d.name === docName && d.sourceUrl && !d.syncError)) {
        const { content } = await api.readKnowledgeDoc(selected.id, docName);
        setDocContent(content);
      }
      if (errors.length) {
        toast(errors.map((e) => `"${e.name}": ${e.error}`).join(' · '), 'error');
      } else {
        toast(name ? 'Documento sincronizado.' : 'Documentos sincronizados.', 'ok');
      }
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeDoc = async (doc: KnowledgeDoc) => {
    if (!selected) return;
    const ok = await confirm({
      title: 'Excluir documento',
      message: `Excluir o documento "${doc.name}"?`,
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!ok) return;
    await api.deleteKnowledgeDoc(selected.id, doc.name);
    if (docName === doc.name) {
      setDocName('');
      setDocContent('');
    }
    setDocs(await api.listKnowledgeDocs(selected.id));
    await reload();
  };

  return (
    <PageShell
      icon="📚"
      title="Bases de conhecimento"
      subtitle="Documentos .md/.txt injetados no contexto das conversas — enviados do computador ou sincronizados de uma URL (GitHub Pages, markdown publicado…). Bases globais valem para tudo; bases de projeto, só nas conversas do projeto."
    >
      <div className="page-cols page-cols--three">
        <Panel title="Bases" count={bases.length}>
          <div className="panel__form-block">
            <div className="field">
              <label>Nome</label>
              <input
                value={newBaseName}
                onChange={(e) => setNewBaseName(e.target.value)}
                placeholder="ex: Glossário do produto"
              />
            </div>
            <div className="field">
              <label>Escopo</label>
              <Select
                value={newBaseScope}
                onChange={(value) => setNewBaseScope(value as 'global' | 'project')}
                options={[
                  { value: 'global', label: '🌐 Global', hint: 'Vale em todas as conversas' },
                  {
                    value: 'project',
                    label: projectName ? `📁 Projeto: ${projectName}` : '📁 Projeto atual',
                    hint: projectId ? undefined : 'Abra um projeto primeiro',
                    disabled: !projectId,
                  },
                ]}
              />
            </div>
            <button
              className="btn btn--primary"
              disabled={busy || !newBaseName.trim()}
              onClick={() => void createBase()}
            >
              ＋ Criar base
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".zip"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importBase(file);
                e.target.value = '';
              }}
            />
            <button
              className="btn"
              disabled={busy}
              onClick={() => importInputRef.current?.click()}
              title="Importar uma base exportada em .zip (usa o escopo selecionado acima)"
            >
              📦 Importar .zip
            </button>
          </div>

          {bases.map((base) => (
            <div
              className={`page-list-item${selected?.id === base.id ? ' page-list-item--active' : ''}`}
              key={base.id}
              onClick={() => void select(base)}
              role="button"
            >
              <span className="item-card__name" style={{ justifyContent: 'space-between' }}>
                <span>
                  {base.scope === 'project' ? '📁' : '🌐'} {base.name}
                </span>
                <button
                  className={`switch${base.enabled ? ' switch--on' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void toggleBase(base);
                  }}
                  title={base.enabled ? 'Ativa no contexto' : 'Inativa'}
                  aria-label={`Alternar ${base.name}`}
                />
              </span>
              <span className="item-card__desc">
                {base.docCount} documento{base.docCount === 1 ? '' : 's'}
                {base.description ? ` · ${base.description}` : ''}
              </span>
              <span className="page-list-item__actions">
                <span
                  role="button"
                  className="mini-btn"
                  title="Baixar a base como .zip para compartilhar"
                  onClick={(e) => {
                    e.stopPropagation();
                    void exportBase(base);
                  }}
                >
                  Exportar
                </span>
                <span
                  role="button"
                  className="mini-btn mini-btn--danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeBase(base);
                  }}
                >
                  Excluir
                </span>
              </span>
            </div>
          ))}
          {bases.length === 0 && (
            <EmptyState icon="📚" title="Nenhuma base ainda" hint="Crie a primeira acima." />
          )}
        </Panel>

        <Panel
          title={selected ? `Documentos · ${selected.name}` : 'Documentos'}
          count={selected ? docs.length : undefined}
          actions={
            selected && (
              <>
                <input
                  ref={uploadInputRef}
                  type="file"
                  multiple
                  accept=".md,.txt,.xlsx,.xlsm,.xls,.docx,.pdf"
                  hidden
                  onChange={(e) => {
                    if (e.target.files?.length) void uploadDocs(e.target.files);
                    e.target.value = '';
                  }}
                />
                <button
                  className="btn btn--sm"
                  disabled={busy}
                  onClick={() => uploadInputRef.current?.click()}
                  title="Upload — enviar arquivos do computador (.md, .txt, Excel, Word, PDF)"
                  aria-label="Upload de arquivos"
                >
                  ⬆
                </button>
                <button
                  className="btn btn--sm"
                  disabled={busy}
                  onClick={() => setUrlFormOpen((open) => !open)}
                  title="Adicionar documento a partir de uma URL (GitHub Pages, markdown publicado…)"
                  aria-label="Adicionar por URL"
                >
                  🔗
                </button>
                {docs.some((d) => d.sourceUrl) && (
                  <button
                    className="btn btn--sm"
                    disabled={busy}
                    onClick={() => void syncDocs()}
                    title="Sincronizar todos os documentos com fonte remota"
                    aria-label="Sincronizar documentos remotos"
                  >
                    ⟳
                  </button>
                )}
                <button
                  className="btn btn--sm"
                  onClick={() => {
                    setDocName('novo-documento.md');
                    setDocContent('');
                  }}
                  title="Novo documento em branco"
                  aria-label="Novo documento"
                >
                  ＋
                </button>
              </>
            )
          }
        >
          {selected ? (
            <>
              {urlFormOpen && (
                <div className="panel__form-block">
                  <div className="field">
                    <label>URL do documento</label>
                    <input
                      value={remoteUrl}
                      onChange={(e) => setRemoteUrl(e.target.value)}
                      placeholder="https://exemplo.github.io/docs/guia.html"
                    />
                  </div>
                  <div className="field">
                    <label>Nome do documento (opcional)</label>
                    <input
                      value={remoteName}
                      onChange={(e) => setRemoteName(e.target.value)}
                      placeholder="derivado da URL se vazio"
                    />
                  </div>
                  <button
                    className="btn btn--primary"
                    disabled={busy || !remoteUrl.trim()}
                    onClick={() => void addRemoteDoc()}
                  >
                    ＋ Adicionar da URL
                  </button>
                </div>
              )}
              {docs.map((doc) => (
                <div
                  className={`page-list-item${docName === doc.name ? ' page-list-item--active' : ''}`}
                  key={doc.name}
                  onClick={() => void openDoc(doc)}
                  role="button"
                  title={doc.sourceUrl}
                >
                  <span className="item-card__name">{doc.sourceUrl ? '🔗' : '📄'} {doc.name}</span>
                  <span className="item-card__desc">
                    {(doc.size / 1024).toFixed(1)} KB
                    {doc.sourceUrl ? ` · ${new URL(doc.sourceUrl).hostname}` : ''}
                    {doc.syncError ? ' · ⚠ erro no último sync' : ''}
                  </span>
                  <span className="page-list-item__actions">
                    {doc.sourceUrl && (
                      <span
                        role="button"
                        className="mini-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          void syncDocs(doc.name);
                        }}
                      >
                        Sincronizar
                      </span>
                    )}
                    <span
                      role="button"
                      className="mini-btn mini-btn--danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeDoc(doc);
                      }}
                    >
                      Excluir
                    </span>
                  </span>
                </div>
              ))}
              {docs.length === 0 && (
                <EmptyState icon="📄" title="Base vazia" hint="Crie o primeiro documento acima." />
              )}
            </>
          ) : (
            <EmptyState
              icon="👈"
              title="Nenhuma base selecionada"
              hint="Selecione uma base para ver os documentos."
            />
          )}
        </Panel>

        {selected && docName ? (
          <Panel title="Editor" className="panel--form">
            {(() => {
              const opened = docs.find((d) => d.name === docName);
              if (!opened?.sourceUrl) return null;
              return (
                <p className="page-hint">
                  🔗 Sincronizado de <code>{opened.sourceUrl}</code>
                  {opened.syncedAt ? ` em ${new Date(opened.syncedAt).toLocaleString()}` : ''}
                  {opened.syncError ? ` · ⚠ último sync falhou: ${opened.syncError}` : ''}
                  . Edições manuais são sobrescritas ao sincronizar.
                </p>
              );
            })()}
            <div className="field">
              <label>Nome do documento</label>
              <input value={docName} onChange={(e) => setDocName(e.target.value)} />
            </div>
            <div className="field page-card__grow">
              <label>Conteúdo (markdown)</label>
              <textarea
                className="page-card__editor"
                value={docContent}
                onChange={(e) => setDocContent(e.target.value)}
                placeholder="Cole aqui o conteúdo que o assistente deve conhecer…"
              />
            </div>
            <div className="form-actions">
              <button
                className="btn btn--primary"
                disabled={busy || !docName.trim()}
                onClick={() => void saveDoc()}
              >
                Salvar documento
              </button>
            </div>
          </Panel>
        ) : (
          <Panel className="panel--placeholder">
            <EmptyState
              icon="✏️"
              title="Nenhum documento aberto"
              hint="Abra ou crie um documento para editar."
            />
          </Panel>
        )}
      </div>
    </PageShell>
  );
}

import { useEffect, useState } from 'react';
import type { KnowledgeBase, KnowledgeDoc } from '@aiportal/shared';
import { api } from '../../api/client';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';
import { PageShell } from './PageShell';

export function KnowledgePage() {
  const toast = useUi((s) => s.toast);
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

  const toggleBase = async (base: KnowledgeBase) => {
    const updated = await api.patchKnowledgeBase(base.id, { enabled: !base.enabled });
    setBases((list) => list.map((b) => (b.id === updated.id ? updated : b)));
    if (selected?.id === updated.id) setSelected(updated);
  };

  const removeBase = async (base: KnowledgeBase) => {
    if (!window.confirm(`Excluir a base "${base.name}" e todos os seus documentos?`)) return;
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

  const removeDoc = async (doc: KnowledgeDoc) => {
    if (!selected) return;
    if (!window.confirm(`Excluir o documento "${doc.name}"?`)) return;
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
      title="Bases de conhecimento"
      subtitle="Documentos .md/.txt injetados no contexto das conversas. Bases globais valem para tudo; bases de projeto, só nas conversas do projeto."
    >
      <div className="page-cols page-cols--three">
        <div>
          <div className="page-card" style={{ marginBottom: 14 }}>
            <h3 className="page-card__title">Nova base</h3>
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
              <select
                value={newBaseScope}
                onChange={(e) => setNewBaseScope(e.target.value as 'global' | 'project')}
              >
                <option value="global">Global</option>
                <option value="project" disabled={!projectId}>
                  {projectName ? `Projeto: ${projectName}` : 'Projeto atual (abra um projeto)'}
                </option>
              </select>
            </div>
            <button
              className="btn btn--primary"
              disabled={busy || !newBaseName.trim()}
              onClick={() => void createBase()}
            >
              Criar base
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
            <div className="empty-state">Nenhuma base ainda. Crie a primeira acima.</div>
          )}
        </div>

        <div>
          {selected ? (
            <>
              <div className="sidebar__section-title" style={{ padding: '0 0 6px' }}>
                Documentos · {selected.name}
              </div>
              <button
                className="btn"
                style={{ marginBottom: 10 }}
                onClick={() => {
                  setDocName('novo-documento.md');
                  setDocContent('');
                }}
              >
                ＋ Novo documento
              </button>
              {docs.map((doc) => (
                <div
                  className={`page-list-item${docName === doc.name ? ' page-list-item--active' : ''}`}
                  key={doc.name}
                  onClick={() => void openDoc(doc)}
                  role="button"
                >
                  <span className="item-card__name">📄 {doc.name}</span>
                  <span className="item-card__desc">{(doc.size / 1024).toFixed(1)} KB</span>
                  <span className="page-list-item__actions">
                    <span
                      role="button"
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
              {docs.length === 0 && <div className="empty-state">Base vazia.</div>}
            </>
          ) : (
            <div className="empty-state">Selecione uma base para ver os documentos.</div>
          )}
        </div>

        <div>
          {selected && docName ? (
            <div className="page-card">
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
              <button
                className="btn btn--primary"
                disabled={busy || !docName.trim()}
                onClick={() => void saveDoc()}
              >
                Salvar documento
              </button>
            </div>
          ) : (
            <div className="empty-state page-card page-card--placeholder">
              Abra ou crie um documento para editar.
            </div>
          )}
        </div>
      </div>
    </PageShell>
  );
}

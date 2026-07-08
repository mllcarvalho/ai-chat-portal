import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bookmark,
  BookOpen,
  ChevronDown,
  FileText,
  Folder,
  Globe,
  Import,
  Link,
  Mail,
  Maximize2,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  SquarePen,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react';
import {
  DEFAULT_PORT,
  PORT_RANGE,
  slugifyCommand,
  type KnowledgeBase,
  type KnowledgeDoc,
} from '@aiportal/shared';
import { api, getToken } from '../../api/client';
import { extractDocumentText, isConvertibleDocument } from '../../lib/extractDocument';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';
import { Dropdown } from '../common/Dropdown';
import { MarkdownEditorModal } from '../common/MarkdownEditorModal';
import { Modal } from '../common/Modal';
import { Select } from '../common/Select';
import { EmptyState, PageShell, Panel } from './PageShell';

/** Hostname de uma URL para exibição — URL inválida não pode quebrar a lista. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

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
  const [docQuery, setDocQuery] = useState('');
  const [docName, setDocName] = useState('');
  const [docContent, setDocContent] = useState('');
  const [newBaseName, setNewBaseName] = useState('');
  const [newBaseScope, setNewBaseScope] = useState<'global' | 'project'>('global');
  const [busy, setBusy] = useState(false);
  const [baseModal, setBaseModal] = useState(false);
  const [expandDoc, setExpandDoc] = useState(false);
  const [urlFormOpen, setUrlFormOpen] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteName, setRemoteName] = useState('');
  const [captureModal, setCaptureModal] = useState(false);
  const [movingDoc, setMovingDoc] = useState<KnowledgeDoc | undefined>();

  /**
   * Bookmarklet "Enviar para o portal": roda DENTRO da aba onde a página está
   * aberta (e autenticada, ex.: SharePoint via SSO), extrai o conteúdo
   * renderizado e posta no servidor local. Tenta a porta atual do portal e,
   * se ela mudou (failover entre janelas), varre a faixa de portas. Sites cuja
   * CSP (connect-src) bloqueia fetch para 127.0.0.1 caem no plano B: um popup
   * da página-ponte do portal recebe o conteúdo por postMessage — que a CSP
   * não alcança — e salva de lá (same-origin).
   */
  const bookmarklet = useMemo(() => {
    const ports = [
      ...new Set([
        Number(window.location.port) || DEFAULT_PORT,
        ...Array.from({ length: PORT_RANGE + 1 }, (_, i) => DEFAULT_PORT + i),
      ]),
    ];
    const code = [
      '(function(){',
      `var P=${JSON.stringify(ports)};`,
      "var m=document.querySelector('main,[role=\"main\"],[data-automation-id=\"contentScrollRegion\"],#spPageCanvasContent')||document.body;",
      'var h=m.outerHTML;if(h.length>3000000)h=h.slice(0,3000000);',
      `var b=JSON.stringify({token:${JSON.stringify(getToken())},title:document.title,url:location.href,html:h});`,
      'function n(t,e){var d=document.createElement("div");d.textContent=t;',
      'd.style.cssText="position:fixed;top:16px;right:16px;z-index:2147483647;background:"+(e?"#c93a2c":"#16294b")+";color:#fff;padding:10px 14px;border-radius:8px;font:13px/1.4 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:340px";',
      'document.body.appendChild(d);setTimeout(function(){d.remove()},6000)}',
      'function u(i){return "http://127.0.0.1:"+P[i]}',
      'function T(){try{return AbortSignal.timeout(1500)}catch(_){return undefined}}',
      // plano B (CSP bloqueou o fetch): popup da ponte + postMessage
      'function p(){var i=0,t,w=window.open(u(0)+"/api/capture/bridge","aiportal_capture","width=440,height=230");',
      'if(!w){n("O navegador bloqueou o popup do portal — permita popups neste site e clique de novo",1);return}',
      'function x(){i++;if(i>=P.length){try{w.close()}catch(_){}n("Portal não encontrado — ele está aberto no VS Code?",1);return}',
      'try{w.location=u(i)+"/api/capture/bridge"}catch(_){}t=setTimeout(x,1400)}',
      't=setTimeout(x,1400);',
      'window.addEventListener("message",function(e){var d=e.data;if(!d||e.origin.indexOf("http://127.0.0.1:")!==0)return;',
      'if(d.type==="aiportal-bridge-ready"){clearTimeout(t);e.source.postMessage({type:"aiportal-capture",payload:JSON.parse(b)},e.origin)}',
      'if(d.type==="aiportal-capture-result"){if(d.ok)n("✓ Salvo no portal: "+d.doc+" (base \\""+d.base+"\\")");else n("Portal: "+(d.error||"erro"),1)}})}',
      'function a(i){if(i>=P.length){p();return}',
      'fetch(u(i)+"/api/capture",{method:"POST",headers:{"Content-Type":"text/plain"},body:b,signal:T()})',
      '.then(function(r){return r.json()})',
      '.then(function(d){if(d&&d.ok)n("✓ Salvo no portal: "+d.doc+" (base \\""+d.base+"\\")");else n("Portal: "+((d&&d.error)||"erro"),1)})',
      '.catch(function(){a(i+1)})}',
      'a(0);',
      '})()',
    ].join('');
    return `javascript:${encodeURIComponent(code)}`;
  }, []);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // busca por nome nos documentos da base aberta
  const docNeedle = docQuery.trim().toLowerCase();
  const shownDocs = docNeedle
    ? docs.filter((d) => d.name.toLowerCase().includes(docNeedle))
    : docs;

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

  /**
   * Recarrega bases e documentos sob demanda — capturas do navegador chegam
   * por fora desta tela (bookmarklet) e não aparecem sozinhas.
   */
  const refresh = async () => {
    setBusy(true);
    try {
      await reload();
      if (selected) setDocs(await api.listKnowledgeDocs(selected.id).catch(() => []));
    } finally {
      setBusy(false);
    }
  };

  const select = async (base: KnowledgeBase) => {
    setSelected(base);
    setDocName('');
    setDocContent('');
    setDocQuery('');
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
      setBaseModal(false);
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

  const emailShare = async (kind: 'knowledge', id: string) => {
    try {
      const result = await api.shareByEmail(kind, id);
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
      setBaseModal(false);
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

  const moveDocTo = async (target: KnowledgeBase) => {
    if (!selected || !movingDoc) return;
    setBusy(true);
    try {
      await api.moveKnowledgeDoc(selected.id, movingDoc.name, target.id);
      if (docName === movingDoc.name) {
        setDocName('');
        setDocContent('');
      }
      toast(`"${movingDoc.name}" movido para "${target.name}".`, 'ok');
      setMovingDoc(undefined);
      setDocs(await api.listKnowledgeDocs(selected.id));
      await reload();
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
      icon={<BookOpen className="icon icon--lg" aria-hidden />}
      title="Bases de conhecimento"
      subtitle="Documentos usados como contexto das conversas — enviados do computador ou sincronizados de uma URL."
      actions={
        <>
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
            onClick={() => setBaseModal(true)}
            title="Importar uma base exportada em .zip"
          >
            <Package className="icon" aria-hidden /> Importar .zip
          </button>
          <button
            className="btn"
            onClick={() => setCaptureModal(true)}
            title="Capturar páginas abertas no navegador (SharePoint, intranet…) sem configurar nada"
          >
            <Bookmark className="icon" aria-hidden /> Capturar do navegador
          </button>
          <button className="btn btn--primary" onClick={() => setBaseModal(true)}>
            <Plus className="icon" aria-hidden /> Nova base
          </button>
        </>
      }
    >
      <div className="page-cols page-cols--three">
        <Panel title="Bases" count={bases.length}>
          {bases.map((base) => (
            <div
              className={`page-list-item${selected?.id === base.id ? ' page-list-item--active' : ''}`}
              key={base.id}
              onClick={() => void select(base)}
              role="button"
            >
              <span className="item-card__name" style={{ justifyContent: 'space-between' }}>
                <span>
                  {base.scope === 'project' ? (
                    <Folder className="icon" aria-hidden />
                  ) : (
                    <Globe className="icon" aria-hidden />
                  )}{' '}
                  {base.name}
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
                  className="mini-btn"
                  title="Enviar por email (abre o cliente com o .zip anexado)"
                  onClick={(e) => {
                    e.stopPropagation();
                    void emailShare('knowledge', base.id);
                  }}
                >
                  <Mail className="icon" aria-hidden />
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
            <EmptyState
              icon={<BookOpen className="icon icon--lg" aria-hidden />}
              title="Nenhuma base ainda"
              hint="Use “Nova base” no topo para criar a primeira."
              action={
                <button className="btn btn--primary" onClick={() => setBaseModal(true)}>
                  <Plus className="icon" aria-hidden /> Nova base
                </button>
              }
            />
          )}
        </Panel>

        <Panel
          title={selected ? `Documentos · ${selected.name}` : 'Documentos'}
          count={selected ? docs.length : undefined}
          actions={
            <>
              <button
                className="btn btn--sm"
                disabled={busy}
                onClick={() => void refresh()}
                title="Atualizar as listas — capturas do navegador não aparecem sozinhas"
                aria-label="Atualizar listas"
              >
                <RefreshCw className="icon" aria-hidden />
              </button>
              {selected && (
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
                {docs.some((d) => d.sourceUrl) && (
                  <button
                    className="btn btn--sm"
                    disabled={busy}
                    onClick={() => void syncDocs()}
                    title="Sincronizar todos os documentos com fonte remota"
                    aria-label="Sincronizar documentos remotos"
                  >
                    <RotateCw className="icon" aria-hidden />
                  </button>
                )}
                <Dropdown
                  trigger={(open, toggle) => (
                    <button
                      className="btn btn--sm"
                      disabled={busy}
                      onClick={toggle}
                      aria-expanded={open}
                      title="Adicionar documento"
                    >
                      <Plus className="icon icon--sm" aria-hidden /> Adicionar{' '}
                      <ChevronDown className="icon icon--sm" aria-hidden />
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      <button
                        className="dropdown__item"
                        onClick={() => {
                          close();
                          setDocName('novo-documento.md');
                          setDocContent('');
                        }}
                      >
                        <SquarePen className="icon icon--sm" aria-hidden /> Documento em branco
                      </button>
                      <button
                        className="dropdown__item"
                        onClick={() => {
                          close();
                          uploadInputRef.current?.click();
                        }}
                      >
                        <Upload className="icon icon--sm" aria-hidden /> Upload de arquivos…
                      </button>
                      <button
                        className="dropdown__item"
                        onClick={() => {
                          close();
                          setUrlFormOpen((open) => !open);
                        }}
                      >
                        <Link className="icon icon--sm" aria-hidden /> A partir de URL…
                      </button>
                    </>
                  )}
                </Dropdown>
              </>
              )}
            </>
          }
        >
          {selected ? (
            <>
              {docs.length > 0 && (
                <div className="panel-search panel-search--block">
                  <Search className="icon icon--sm" aria-hidden />
                  <input
                    value={docQuery}
                    onChange={(e) => setDocQuery(e.target.value)}
                    placeholder="Buscar documento…"
                    aria-label="Buscar documento por nome"
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setDocQuery('');
                    }}
                  />
                  {docQuery && (
                    <button
                      title="Limpar busca"
                      aria-label="Limpar busca"
                      onClick={() => setDocQuery('')}
                    >
                      <X className="icon icon--sm" aria-hidden />
                    </button>
                  )}
                </div>
              )}
              {urlFormOpen && (
                <div className="panel__form-block">
                  <div className="field">
                    <label>URL do documento</label>
                    <input
                      value={remoteUrl}
                      onChange={(e) => setRemoteUrl(e.target.value)}
                      placeholder="https://exemplo.github.io/docs/guia.html ou https://empresa.sharepoint.com/sites/…"
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
                    <Plus className="icon" aria-hidden /> Adicionar da URL
                  </button>
                </div>
              )}
              {shownDocs.map((doc) => (
                <div
                  className={`page-list-item${docName === doc.name ? ' page-list-item--active' : ''}`}
                  key={doc.name}
                  onClick={() => void openDoc(doc)}
                  role="button"
                  title={doc.sourceUrl}
                >
                  <span className="item-card__name">
                    {doc.sourceUrl ? (
                      <Link className="icon" aria-hidden />
                    ) : (
                      <FileText className="icon" aria-hidden />
                    )}{' '}
                    {doc.name}
                  </span>
                  <span className="item-card__desc">
                    {(doc.size / 1024).toFixed(1)} KB
                    {doc.sourceUrl ? ` · ${hostnameOf(doc.sourceUrl)}` : ''}
                    {doc.syncError ? (
                      <>
                        {' · '}
                        <TriangleAlert className="icon icon--sm" aria-hidden /> erro no último sync
                      </>
                    ) : (
                      ''
                    )}
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
                      className="mini-btn"
                      title="Mover para outra base de conhecimento"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMovingDoc(doc);
                      }}
                    >
                      Mover
                    </span>
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
                <EmptyState
                  icon={<FileText className="icon icon--lg" aria-hidden />}
                  title="Base vazia"
                  hint="Crie o primeiro documento acima."
                />
              )}
              {docs.length > 0 && shownDocs.length === 0 && (
                <EmptyState
                  icon={<Search className="icon icon--lg" aria-hidden />}
                  title="Nada encontrado"
                  hint="Nenhum documento com esse nome nesta base."
                />
              )}
            </>
          ) : (
            <EmptyState
              icon={<ArrowLeft className="icon icon--lg" aria-hidden />}
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
                  <Link className="icon icon--sm" aria-hidden /> Sincronizado de{' '}
                  <code>{opened.sourceUrl}</code>
                  {opened.syncedAt ? ` em ${new Date(opened.syncedAt).toLocaleString()}` : ''}
                  {opened.syncError ? (
                    <>
                      {' · '}
                      <TriangleAlert className="icon icon--sm" aria-hidden /> último sync falhou:{' '}
                      {opened.syncError}
                    </>
                  ) : (
                    ''
                  )}
                  . Edições manuais são sobrescritas ao sincronizar.
                </p>
              );
            })()}
            <div className="field">
              <label>Nome do documento</label>
              <input value={docName} onChange={(e) => setDocName(e.target.value)} />
            </div>
            <div className="field page-card__grow">
              <div className="field__label-row">
                <label>Conteúdo (markdown)</label>
                <button
                  className="btn btn--sm btn--ghost"
                  onClick={() => setExpandDoc(true)}
                  title="Editar em tela cheia (com visualização do markdown)"
                >
                  <Maximize2 className="icon" aria-hidden /> Expandir
                </button>
              </div>
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
              icon={<Pencil className="icon icon--lg" aria-hidden />}
              title="Nenhum documento aberto"
              hint="Abra ou crie um documento para editar."
            />
          </Panel>
        )}
      </div>

      {selected && docName && expandDoc && (
        <MarkdownEditorModal
          title={`${docName} (markdown)`}
          value={docContent}
          onChange={setDocContent}
          placeholder="Cole aqui o conteúdo que o assistente deve conhecer…"
          onClose={() => setExpandDoc(false)}
        />
      )}

      {baseModal && (
        <Modal title="Nova base de conhecimento" onClose={() => setBaseModal(false)}>
          <div className="field">
            <label>Nome</label>
            <input
              value={newBaseName}
              autoFocus
              onChange={(e) => setNewBaseName(e.target.value)}
              placeholder="ex: Glossário do produto"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newBaseName.trim()) void createBase();
              }}
            />
          </div>
          <div className="field">
            <label>Escopo</label>
            <Select
              value={newBaseScope}
              onChange={(value) => setNewBaseScope(value as 'global' | 'project')}
              options={[
                {
                  value: 'global',
                  label: <><Globe className="icon" aria-hidden /> Global</>,
                  hint: 'Vale em todas as conversas',
                },
                {
                  value: 'project',
                  label: (
                    <>
                      <Folder className="icon" aria-hidden />{' '}
                      {projectName ? `Projeto: ${projectName}` : 'Projeto atual'}
                    </>
                  ),
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
            style={{ width: '100%', justifyContent: 'center' }}
          >
            <Plus className="icon" aria-hidden /> Criar base
          </button>
          <div className="panel__divider">ou importe uma base existente</div>
          <button
            className="btn"
            disabled={busy}
            onClick={() => importInputRef.current?.click()}
            title="Importar uma base exportada em .zip (usa o escopo selecionado acima)"
            style={{ width: '100%', justifyContent: 'center' }}
          >
            <Package className="icon" aria-hidden /> Importar .zip
          </button>
        </Modal>
      )}

      {movingDoc && selected && (
        <Modal title="Mover documento" onClose={() => setMovingDoc(undefined)}>
          <p style={{ marginTop: 0 }}>
            Mover <strong>{movingDoc.name}</strong> de "{selected.name}" para:
          </p>
          {bases
            .filter((b) => b.id !== selected.id)
            .map((b) => (
              <button
                key={b.id}
                className="btn"
                disabled={busy}
                style={{ width: '100%', justifyContent: 'flex-start', marginBottom: 6 }}
                onClick={() => void moveDocTo(b)}
              >
                {b.scope === 'project' ? (
                  <Folder className="icon" aria-hidden />
                ) : (
                  <Globe className="icon" aria-hidden />
                )}{' '}
                {b.name}
                <span style={{ color: 'var(--text-dim)', marginLeft: 'auto', fontSize: 12 }}>
                  {b.docCount} doc{b.docCount === 1 ? '' : 's'}
                </span>
              </button>
            ))}
          {bases.filter((b) => b.id !== selected.id).length === 0 && (
            <p style={{ color: 'var(--text-dim)', margin: 0 }}>
              Não há outra base para receber o documento — crie uma em "Nova base" primeiro.
            </p>
          )}
        </Modal>
      )}

      {captureModal && (
        <Modal title="Capturar do navegador" onClose={() => setCaptureModal(false)}>
          <p style={{ marginTop: 0 }}>
            Para páginas que exigem login no navegador (SharePoint, intranet…): o botão abaixo roda
            na própria aba onde a página está aberta e envia o conteúdo para o portal — sem
            configurar nada no Entra ID.
          </p>
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              padding: '14px 0',
            }}
          >
            <a
              className="btn btn--primary"
              href={bookmarklet}
              draggable
              onClick={(e) => e.preventDefault()}
              title="Arraste este botão para a barra de favoritos do navegador"
            >
              <Import className="icon" aria-hidden /> Enviar para o portal
            </a>
          </div>
          <ol style={{ margin: '0 0 10px', paddingLeft: 20, lineHeight: 1.7 }}>
            <li>
              <strong>Arraste o botão acima</strong> para a barra de favoritos (Ctrl/Cmd+Shift+B
              mostra a barra).
            </li>
            <li>Abra a página que quer capturar, já logado normalmente.</li>
            <li>
              Clique no favorito: a página vira um documento na base{' '}
              <strong>"Capturas do navegador"</strong>. Clicar de novo na mesma página atualiza o
              documento.
            </li>
          </ol>
          <p style={{ color: 'var(--text-dim)', fontSize: 12.5, margin: 0 }}>
            O favorito carrega o token do seu portal — não compartilhe. Se o portal estiver
            fechado ou o token mudar, gere o favorito de novo aqui. Em páginas com política de
            segurança rígida (CSP), o envio abre uma janelinha do portal para completar a captura
            — permita popups do site se o navegador perguntar. Depois de capturado, dá para mover
            o documento da base "Capturas do navegador" para qualquer outra base (botão "Mover").
          </p>
        </Modal>
      )}
    </PageShell>
  );
}

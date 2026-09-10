import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bookmark,
  BookOpen,
  ChevronDown,
  Download,
  FileText,
  FileType,
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
  FolderInput,
  Trash2,
  Users,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react';
import {
  DEFAULT_PORT,
  PORT_RANGE,
  slugifyCommand,
  type KnowledgeBase,
  type KnowledgeCollection,
  type KnowledgeCollectionSync,
  type KnowledgeDoc,
} from '@aiportal/shared';
import { api, getToken } from '../../api/client';
import { getServer } from '../../api/server';
import { isConvertibleDocument } from '../../lib/extractDocument';
import { useCatalog } from '../../stores/catalogStore';
import { useSessions } from '../../stores/sessionsStore';
import { useUi } from '../../stores/uiStore';
import { Dropdown } from '../common/Dropdown';
import { MarkdownEditorModal } from '../common/MarkdownEditorModal';
import { Modal } from '../common/Modal';
import { Select } from '../common/Select';
import { useSharedRevision } from '../../lib/useSharedRevision';
import { EmptyState, PageShell, Panel } from './PageShell';

/** Hostname de uma URL para exibição — URL inválida não pode quebrar a lista. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Teto do arquivo original guardado numa base (o upload vai em base64). */
const MAX_DOC_BYTES = 7 * 1024 * 1024;
const DOC_LIMIT_LABEL = '7 MB';

/** Lê o arquivo como base64 puro (sem o prefixo data:…;base64,). */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('Falha ao ler o arquivo'));
    reader.readAsDataURL(file);
  });
}

export function KnowledgePage() {
  const toast = useUi((s) => s.toast);
  const confirm = useUi((s) => s.confirm);
  const session = useSessions((s) => s.current);
  const viewProjectId = useSessions((s) => s.viewProjectId);
  const projects = useSessions((s) => s.projects);
  const libraries = useCatalog((s) => s.libraries);

  const projectId = session?.projectId ?? viewProjectId ?? undefined;
  const projectName = projects.find((p) => p.id === projectId)?.name;

  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [selected, setSelected] = useState<KnowledgeBase | undefined>();
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [docQuery, setDocQuery] = useState('');
  const [docName, setDocName] = useState('');
  const [docContent, setDocContent] = useState('');
  const [newBaseName, setNewBaseName] = useState('');
  const [newBaseScope, setNewBaseScope] = useState<'global' | 'project' | 'shared'>('global');
  const [newBaseLibraryId, setNewBaseLibraryId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [baseModal, setBaseModal] = useState(false);
  const [expandDoc, setExpandDoc] = useState(false);
  const [urlFormOpen, setUrlFormOpen] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteName, setRemoteName] = useState('');
  /** "Varrer o site": a URL vira um GRUPO de páginas em vez de um documento só. */
  const [crawlMode, setCrawlMode] = useState(false);
  const [crawlMaxPages, setCrawlMaxPages] = useState(25);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
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
        // portal hospedado: a extensão está no ?server= (127.0.0.1:PORT), não na origem da página
        Number(new URL(getServer() || window.location.href).port) || DEFAULT_PORT,
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
  /** Documento aberto é um arquivo original (PDF/Word/Excel/PPT)? */
  const openedIsBinary = !!docs.find((d) => d.name === docName)?.binary;
  const shownDocs = docNeedle
    ? docs.filter(
        (d) =>
          d.name.toLowerCase().includes(docNeedle) ||
          (d.title ?? '').toLowerCase().includes(docNeedle),
      )
    : docs;

  /*
   * Um site varrido traz dezenas de páginas. Soltas na lista, elas afogam os
   * documentos avulsos da base — então cada site vira um grupo recolhível e
   * só os avulsos ficam no nível de cima.
   */
  const collections = selected?.collections ?? [];
  const docsByCollection = new Map<string, KnowledgeDoc[]>();
  const looseDocs: KnowledgeDoc[] = [];
  for (const doc of shownDocs) {
    const group = doc.collection && collections.some((c) => c.id === doc.collection)
      ? doc.collection
      : undefined;
    if (group) docsByCollection.set(group, [...(docsByCollection.get(group) ?? []), doc]);
    else looseDocs.push(doc);
  }
  // durante uma busca os grupos abrem sozinhos: esconder o que casou seria pior
  const groupOpen = (id: string) => !!docNeedle || !collapsedGroups[id];

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

  /*
   * Base mexida por outra pessoa na pasta da equipe entra sozinha. Silencioso
   * de propósito: NÃO mexe em `busy` (piscaria os botões) nem no documento
   * aberto no editor — recarregar por baixo de quem está digitando seria pior
   * que o problema.
   */
  useSharedRevision('knowledge', () => {
    void (async () => {
      await reload();
      if (selected) setDocs(await api.listKnowledgeDocs(selected.id).catch(() => docs));
    })();
  });

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
        libraryId: newBaseScope === 'shared' ? newBaseLibraryId ?? libraries[0]?.id : undefined,
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

  /**
   * Move a base para uma biblioteca compartilhada: a pasta inteira (documentos
   * e fontes) vai para a rede e todo mundo que aponta para ela passa a ver.
   */
  const shareBase = async (base: KnowledgeBase) => {
    const target = libraries.find((lib) => lib.available);
    if (!target) return;
    const ok = await confirm({
      title: 'Compartilhar com a equipe',
      message:
        `Mover a base "${base.name}" (${base.docCount} documento${base.docCount === 1 ? '' : 's'}) ` +
        `para a biblioteca "${target.name}"? Ela sai da sua área e passa a valer para todos que ` +
        'usam essa pasta — inclusive as edições daqui para a frente.',
      confirmLabel: 'Mover para a biblioteca',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.patchKnowledgeBase(base.id, { scope: 'shared', libraryId: target.id });
      await reload();
      toast(`"${base.name}" agora é compartilhada (${target.name}).`, 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Caminho de volta do "Compartilhar": tira a base da pasta da equipe e a
   * traz para a área local de quem clica. Sem isto, compartilhar era um
   * caminho só de ida — o escopo da base não é editável em lugar nenhum.
   */
  const unshareBase = async (base: KnowledgeBase) => {
    const libName = libraries.find((lib) => lib.id === base.libraryId)?.name ?? 'equipe';
    const ok = await confirm({
      title: 'Trazer de volta para esta máquina',
      message:
        `Tirar a base "${base.name}" (${base.docCount} documento${base.docCount === 1 ? '' : 's'}) ` +
        `da biblioteca "${libName}"? Os arquivos voltam para a sua área e a base SOME para todas ` +
        'as pessoas que usam essa pasta compartilhada.',
      confirmLabel: 'Trazer de volta',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.patchKnowledgeBase(base.id, { scope: 'global' });
      await reload();
      toast(`"${base.name}" voltou a ser só desta máquina.`, 'ok');
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
      const zipBase64 = await toBase64(file);
      const base = await api.importKnowledgeBase(zipBase64, {
        name: file.name.replace(/\.zip$/i, ''),
        scope: newBaseScope,
        projectId: newBaseScope === 'project' ? projectId : undefined,
        libraryId: newBaseScope === 'shared' ? newBaseLibraryId ?? libraries[0]?.id : undefined,
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
        const name = file.name;
        if (isConvertibleDocument(name)) {
          // sobe o ARQUIVO ORIGINAL: o portal guarda o PDF/planilha como veio e
          // extrai o texto no servidor (antes o binário era descartado e só
          // sobrava um .md, sem como abrir o documento de novo)
          if (file.size > MAX_DOC_BYTES) {
            toast(
              `"${name}" tem ${(file.size / 1024 / 1024).toFixed(1)} MB e o limite é ${DOC_LIMIT_LABEL} — ` +
                'anexe só a parte relevante ou referencie a pasta na conversa.',
              'error',
            );
            continue;
          }
          await api.uploadKnowledgeDoc(selected.id, name, await toBase64(file));
        } else if (/\.(md|txt)$/i.test(name)) {
          await api.writeKnowledgeDoc(selected.id, name, await file.text());
        } else {
          toast(`"${name}" ignorado — use .md, .txt, PDF, Word, Excel ou PowerPoint.`, 'info');
          continue;
        }
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

  /** Resumo humano do que a varredura fez — o toast precisa dizer algo útil. */
  const crawlSummary = (r: KnowledgeCollectionSync): string => {
    const parts = [`${r.docs.filter((d) => d.collection === r.collection.id).length} páginas`];
    if (r.added) parts.push(`${r.added} nova(s)`);
    if (r.updated) parts.push(`${r.updated} atualizada(s)`);
    if (r.removed) parts.push(`${r.removed} removida(s)`);
    if (r.errors.length) parts.push(`${r.errors.length} falhou(ram)`);
    if (r.truncated) parts.push('teto de páginas atingido');
    return parts.join(' · ');
  };

  const crawlSite = async () => {
    if (!selected || !remoteUrl.trim()) return;
    setBusy(true);
    try {
      const result = await api.crawlKnowledgeSite(selected.id, remoteUrl.trim(), {
        maxPages: crawlMaxPages,
      });
      setRemoteUrl('');
      setRemoteName('');
      setUrlFormOpen(false);
      setDocs(await api.listKnowledgeDocs(selected.id));
      await reload();
      toast(`"${result.collection.name}" varrido: ${crawlSummary(result)}.`, 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const syncCollectionNow = async (collection: KnowledgeCollection) => {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await api.syncKnowledgeCollection(selected.id, collection.id);
      setDocs(await api.listKnowledgeDocs(selected.id));
      await reload();
      toast(`"${collection.name}" sincronizado: ${crawlSummary(result)}.`, 'ok');
    } catch (err) {
      await reload();
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeCollection = async (collection: KnowledgeCollection) => {
    if (!selected) return;
    const pages = docs.filter((d) => d.collection === collection.id).length;
    const ok = await confirm({
      title: 'Remover site da base',
      message:
        `Remover "${collection.name}" e as ${pages} página${pages === 1 ? '' : 's'} que vieram ` +
        'dele? O site continua no ar — só sai desta base de conhecimento.',
      confirmLabel: 'Remover',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.deleteKnowledgeCollection(selected.id, collection.id);
      setDocs(await api.listKnowledgeDocs(selected.id));
      await reload();
      toast(`"${collection.name}" removido da base.`, 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  /** Linha de um documento — reusada solta e dentro do grupo de um site. */
  const renderDoc = (doc: KnowledgeDoc) => (
    <div
      className={`page-list-item${docName === doc.name ? ' page-list-item--active' : ''}`}
      key={doc.name}
      onClick={() => void openDoc(doc)}
      role="button"
      title={doc.sourceUrl ?? doc.name}
    >
      <span className="page-list-item__row">
        <span className="item-card__name" title={doc.name}>
          {doc.sourceUrl ? (
            <Link className="icon" aria-hidden />
          ) : doc.binary ? (
            <FileType className="icon" aria-hidden />
          ) : (
            <FileText className="icon" aria-hidden />
          )}{' '}
          {/* página de site se apresenta pelo título; o nome do arquivo é ruído */}
          {doc.title ?? doc.name}
        </span>
      </span>
      <span className="item-card__desc">
        {(doc.size / 1024).toFixed(1)} KB
        {doc.binary ? ' · arquivo original + texto extraído' : ''}
        {doc.title ? ` · ${doc.name}` : doc.sourceUrl ? ` · ${hostnameOf(doc.sourceUrl)}` : ''}
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
            title="Sincronizar com a fonte remota"
            aria-label="Sincronizar documento"
            onClick={(e) => {
              e.stopPropagation();
              void syncDocs(doc.name);
            }}
          >
            <RefreshCw className="icon" aria-hidden />
          </span>
        )}
        <span
          role="button"
          className="mini-btn"
          title="Mover para outra base de conhecimento"
          aria-label="Mover documento"
          onClick={(e) => {
            e.stopPropagation();
            setMovingDoc(doc);
          }}
        >
          <FolderInput className="icon" aria-hidden />
        </span>
        <span
          role="button"
          className="mini-btn mini-btn--danger"
          title="Excluir documento"
          aria-label="Excluir documento"
          onClick={(e) => {
            e.stopPropagation();
            void removeDoc(doc);
          }}
        >
          <Trash2 className="icon" aria-hidden />
        </span>
      </span>
    </div>
  );

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
              {/* o toggle fica à ESQUERDA (como nas linhas de MCP): a direita
                  da linha é onde a barra de ações flutua no hover */}
              <span className="page-list-item__row">
                <button
                  className={`switch${base.enabled ? ' switch--on' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void toggleBase(base);
                  }}
                  title={base.enabled ? 'Ativa no contexto' : 'Inativa'}
                  aria-label={`Alternar ${base.name}`}
                />
                <span className="item-card__name" title={base.name}>
                  {base.scope === 'project' ? (
                    <Folder className="icon" aria-hidden />
                  ) : base.scope === 'shared' ? (
                    <Users className="icon" aria-hidden />
                  ) : (
                    <Globe className="icon" aria-hidden />
                  )}{' '}
                  {base.name}
                </span>
              </span>
              <span className="item-card__desc">
                {base.docCount} documento{base.docCount === 1 ? '' : 's'}
                {base.scope === 'shared'
                  ? ` · compartilhada (${libraries.find((l) => l.id === base.libraryId)?.name ?? 'equipe'})`
                  : ''}
                {base.description ? ` · ${base.description}` : ''}
              </span>
              <span className="page-list-item__actions">
                {base.scope === 'shared' ? (
                  <span
                    role="button"
                    className="mini-btn"
                    title="Tirar da biblioteca da equipe e trazer de volta para esta máquina"
                    aria-label="Descompartilhar base"
                    onClick={(e) => {
                      e.stopPropagation();
                      void unshareBase(base);
                    }}
                  >
                    <Globe className="icon" aria-hidden />
                  </span>
                ) : (
                  libraries.some((lib) => lib.available) && (
                    <span
                      role="button"
                      className="mini-btn"
                      title="Mover esta base para uma pasta compartilhada da equipe"
                      aria-label="Compartilhar base com a equipe"
                      onClick={(e) => {
                        e.stopPropagation();
                        void shareBase(base);
                      }}
                    >
                      <Users className="icon" aria-hidden />
                    </span>
                  )
                )}
                <span
                  role="button"
                  className="mini-btn"
                  title="Baixar a base como .zip para compartilhar"
                  aria-label="Exportar base"
                  onClick={(e) => {
                    e.stopPropagation();
                    void exportBase(base);
                  }}
                >
                  <Download className="icon" aria-hidden />
                </span>
                <span
                  role="button"
                  className="mini-btn"
                  title="Enviar por email (abre o cliente com o .zip anexado)"
                  aria-label="Enviar base por email"
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
                  title="Excluir base"
                  aria-label="Excluir base"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeBase(base);
                  }}
                >
                  <Trash2 className="icon" aria-hidden />
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
                  accept=".md,.txt,.xlsx,.xlsm,.xls,.docx,.pptx,.pdf"
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
                        <Upload className="icon icon--sm" aria-hidden /> Upload de arquivos (PDF,
                        Word, Excel, PPT, .md)…
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
                    <label>{crawlMode ? 'URL inicial do site' : 'URL do documento'}</label>
                    <input
                      value={remoteUrl}
                      onChange={(e) => setRemoteUrl(e.target.value)}
                      placeholder="https://exemplo.github.io/docs/guia.html ou https://empresa.sharepoint.com/sites/…"
                    />
                  </div>
                  <div className="field">
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={crawlMode}
                        onChange={(e) => setCrawlMode(e.target.checked)}
                      />
                      Varrer o site inteiro a partir dessa URL
                    </label>
                    <span className="field__hint">
                      Traz uma página por documento, agrupadas num só item da lista. A varredura
                      segue o <code>sitemap.xml</code> do site (ou os links, se não houver) e fica
                      presa ao mesmo endereço e à mesma pasta da URL informada.
                    </span>
                  </div>
                  {crawlMode && (
                    <div className="field">
                      <label>Máximo de páginas</label>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={crawlMaxPages}
                        onChange={(e) =>
                          setCrawlMaxPages(Math.max(1, Math.min(100, Number(e.target.value) || 1)))
                        }
                      />
                    </div>
                  )}
                  {/* na varredura o nome vem do título de cada página */}
                  {!crawlMode && (
                    <div className="field">
                      <label>Nome do documento (opcional)</label>
                      <input
                        value={remoteName}
                        onChange={(e) => setRemoteName(e.target.value)}
                        placeholder="derivado da URL se vazio"
                      />
                    </div>
                  )}
                  <button
                    className="btn btn--primary"
                    disabled={busy || !remoteUrl.trim()}
                    onClick={() => void (crawlMode ? crawlSite() : addRemoteDoc())}
                  >
                    <Plus className="icon" aria-hidden />{' '}
                    {crawlMode ? 'Varrer o site' : 'Adicionar da URL'}
                  </button>
                </div>
              )}
              {looseDocs.map(renderDoc)}
              {collections.map((collection) => {
                const pages = docsByCollection.get(collection.id) ?? [];
                if (docNeedle && pages.length === 0) return null;
                const open = groupOpen(collection.id);
                return (
                  <div className="doc-group" key={collection.id}>
                    <div className="doc-group__head">
                      <button
                        className="doc-group__toggle"
                        onClick={() =>
                          setCollapsedGroups((s) => ({ ...s, [collection.id]: open }))
                        }
                        aria-expanded={open}
                        title={open ? 'Recolher' : 'Expandir'}
                      >
                        <ChevronDown
                          className={`icon doc-group__chevron${open ? ' doc-group__chevron--open' : ''}`}
                          aria-hidden
                        />
                        <Globe className="icon" aria-hidden />
                        <span className="doc-group__name" title={collection.rootUrl}>
                          {collection.name}
                        </span>
                        <span className="doc-group__count">
                          {pages.length} pág{pages.length === 1 ? '' : 's'}
                        </span>
                      </button>
                      <span className="doc-group__actions">
                        <button
                          className="icon-btn"
                          disabled={busy}
                          title={`Re-varrer o site (até ${collection.maxPages} páginas) e atualizar as páginas`}
                          aria-label="Sincronizar site"
                          onClick={() => void syncCollectionNow(collection)}
                        >
                          <RotateCw className="icon" aria-hidden />
                        </button>
                        <button
                          className="icon-btn icon-btn--danger"
                          disabled={busy}
                          title="Remover o site e suas páginas desta base"
                          aria-label="Remover site"
                          onClick={() => void removeCollection(collection)}
                        >
                          <Trash2 className="icon" aria-hidden />
                        </button>
                      </span>
                    </div>
                    {collection.syncError && (
                      <p className="doc-group__error">
                        <TriangleAlert className="icon icon--sm" aria-hidden />{' '}
                        {collection.syncError}
                      </p>
                    )}
                    {open && (
                      <div className="doc-group__docs">
                        {pages.map(renderDoc)}
                        {pages.length === 0 && (
                          <p className="doc-group__empty">
                            Nenhuma página — sincronize para trazer de novo.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
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
          <Panel title={openedIsBinary ? 'Documento' : 'Editor'} className="panel--form">
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
              <input value={docName} onChange={(e) => setDocName(e.target.value)} disabled={openedIsBinary} />
            </div>
            <div className="field page-card__grow">
              <div className="field__label-row">
                <label>{openedIsBinary ? 'Texto extraído (somente leitura)' : 'Conteúdo (markdown)'}</label>
                <span className="field__label-row__actions">
                  {openedIsBinary && (
                    <button
                      className="btn btn--sm btn--ghost"
                      title="Baixar o arquivo original para abrir no aplicativo de sempre"
                      onClick={() => void api.downloadKnowledgeDoc(selected.id, docName)}
                    >
                      <Download className="icon" aria-hidden /> Baixar original
                    </button>
                  )}
                  <button
                    className="btn btn--sm btn--ghost"
                    onClick={() => setExpandDoc(true)}
                    title="Ver em tela cheia (com visualização do markdown)"
                  >
                    <Maximize2 className="icon" aria-hidden /> Expandir
                  </button>
                </span>
              </div>
              <textarea
                className="page-card__editor"
                value={docContent}
                onChange={(e) => setDocContent(e.target.value)}
                readOnly={openedIsBinary}
                placeholder="Cole aqui o conteúdo que o assistente deve conhecer…"
              />
              {openedIsBinary && (
                <p className="field__hint">
                  O arquivo original fica guardado na base; este é o texto que o assistente lê. Para
                  alterar o conteúdo, edite o documento na origem e envie de novo.
                </p>
              )}
            </div>
            {!openedIsBinary && (
              <div className="form-actions">
                <button
                  className="btn btn--primary"
                  disabled={busy || !docName.trim()}
                  onClick={() => void saveDoc()}
                >
                  Salvar documento
                </button>
              </div>
            )}
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
              onChange={(value) => {
                const scope = value as 'global' | 'project' | 'shared';
                setNewBaseScope(scope);
                if (scope === 'shared' && !newBaseLibraryId) {
                  setNewBaseLibraryId(libraries.find((lib) => lib.available)?.id);
                }
              }}
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
                {
                  value: 'shared',
                  label: <><Users className="icon" aria-hidden /> Compartilhada</>,
                  hint: libraries.length
                    ? 'Fica na pasta da equipe — todo mundo vê'
                    : 'Configure uma biblioteca em Configurações',
                  disabled: libraries.length === 0,
                },
              ]}
            />
          </div>
          {newBaseScope === 'shared' && (
            <div className="field">
              <label>Biblioteca</label>
              <Select
                value={newBaseLibraryId ?? libraries[0]?.id ?? ''}
                onChange={setNewBaseLibraryId}
                options={libraries.map((lib) => ({
                  value: lib.id,
                  label: <><Users className="icon" aria-hidden /> {lib.name}</>,
                  hint: lib.available ? lib.path : 'indisponível agora',
                  disabled: !lib.available,
                }))}
              />
            </div>
          )}
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

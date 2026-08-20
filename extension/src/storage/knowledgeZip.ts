import * as path from 'node:path';
import JSZip from 'jszip';
import type { KnowledgeBase, KnowledgeCollection } from '@aiportal/shared';
import {
  createBase,
  deleteBase,
  deleteDoc,
  getBase,
  getDocSources,
  listBases,
  listDocs,
  patchBase,
  readDoc,
  readDocRaw,
  setDocSources,
  writeBinaryDoc,
  writeDoc,
  isBinaryDoc,
  type DocSource,
} from './knowledgeStore';

/** Metadados gravados no base.json do zip — sem id/escopo, que são atribuídos no import. */
interface ZipMeta {
  name: string;
  description?: string;
  exportedAt: string;
  /** Identidade de origem: reimports atualizam a base existente em vez de duplicar. */
  originId?: string;
  /**
   * Sites varridos. Sem isto, quem importasse receberia as páginas soltas: o
   * sources.json até diz a que coleção cada doc pertence, mas sem a coleção
   * correspondente no destino o grupo (e o botão de re-sincronizar o site)
   * não existiria.
   */
  collections?: KnowledgeCollection[];
}

/** Empacota a base (documentos + metadados + fontes remotas) para compartilhar. */
export async function exportBaseZip(baseId: string): Promise<Buffer> {
  const base = getBase(baseId);
  if (!base) throw new Error('Base de conhecimento não encontrada');
  const zip = new JSZip();
  const meta: ZipMeta = {
    name: base.name,
    description: base.description,
    exportedAt: new Date().toISOString(),
    originId: base.importedFrom ?? base.id,
    collections: base.collections?.length ? base.collections : undefined,
  };
  zip.file('base.json', JSON.stringify(meta, null, 2));
  const sources = getDocSources(baseId);
  if (Object.keys(sources).length > 0) {
    zip.file('sources.json', JSON.stringify(sources, null, 2));
  }
  for (const doc of listDocs(baseId)) {
    // binário vai no zip como o arquivo original (a conversão em texto é
    // regenerada no destino, e o PDF/planilha continua abrindo lá)
    if (isBinaryDoc(doc.name)) {
      const raw = readDocRaw(baseId, doc.name);
      if (raw) zip.file(doc.name, raw);
      continue;
    }
    const content = readDoc(baseId, doc.name);
    if (content !== undefined) zip.file(doc.name, content);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Cria uma base a partir de um zip exportado (ou de qualquer zip com .md/.txt).
 * Zips com originId fazem upsert: se a base de origem (ou uma cópia já importada
 * dela) existe, é atualizada no lugar — docs substituídos — em vez de duplicar.
 */
export async function importBaseZip(
  zipData: Buffer,
  input: {
    scope: 'global' | 'project' | 'shared';
    projectId?: string;
    libraryId?: string;
    fallbackName?: string;
    /** enabled da base quando o import CRIA (updates preservam o toggle atual). */
    enabledOnCreate?: boolean;
  },
): Promise<KnowledgeBase> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipData);
  } catch {
    throw new Error('Arquivo inválido — envie um .zip');
  }

  let entries = Object.values(zip.files).filter(
    (f) => !f.dir && !f.name.startsWith('__MACOSX/') && !path.basename(f.name).startsWith('.'),
  );
  // zip de uma pasta inteira: remove o prefixo comum (ex.: "minha-base/doc.md")
  const prefix = commonDirPrefix(entries.map((f) => f.name));
  const nameOf = (entry: (typeof entries)[number]) => entry.name.slice(prefix.length);
  entries = entries.filter((f) => !nameOf(f).includes('/'));

  const metaEntry = entries.find((f) => nameOf(f) === 'base.json');
  const sourcesEntry = entries.find((f) => nameOf(f) === 'sources.json');
  const docEntries = entries.filter((f) =>
    /\.(md|txt|pdf|docx|xlsx|xlsm|xls|pptx)$/i.test(nameOf(f)),
  );
  if (docEntries.length === 0) {
    throw new Error('O zip não contém documentos (.md, .txt, .pdf, .docx, .xlsx, .xls ou .pptx)');
  }

  let name = input.fallbackName?.trim() || 'Base importada';
  let description: string | undefined;
  let originId: string | undefined;
  let collections: KnowledgeCollection[] = [];
  if (metaEntry) {
    try {
      const meta = JSON.parse(await metaEntry.async('string')) as Partial<ZipMeta>;
      if (meta.name?.trim()) name = meta.name.trim();
      if (meta.description?.trim()) description = meta.description.trim();
      if (typeof meta.originId === 'string') originId = meta.originId;
      if (Array.isArray(meta.collections)) collections = meta.collections;
    } catch {
      // base.json ilegível — segue com o nome de fallback
    }
  }

  // upsert por origem: a própria base de origem (restore) ou uma cópia já importada
  let existing: KnowledgeBase | undefined;
  if (originId) {
    existing =
      getBase(originId) ?? listBases(input.projectId).find((b) => b.importedFrom === originId);
  }
  const base =
    existing ??
    createBase({
      name,
      description,
      scope: input.scope,
      projectId: input.projectId,
      libraryId: input.libraryId,
      enabled: input.enabledOnCreate,
      importedFrom: originId,
    });
  if (!base) throw new Error('Projeto não encontrado');

  const imported = new Set<string>();
  const errors: string[] = [];
  for (const entry of docEntries) {
    const docName = nameOf(entry);
    try {
      if (isBinaryDoc(docName)) {
        await writeBinaryDoc(base.id, docName, await entry.async('nodebuffer'));
      } else {
        writeDoc(base.id, docName, await entry.async('string'));
      }
      imported.add(docName);
    } catch (err) {
      errors.push(`"${docName}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (imported.size === 0) {
    if (!existing) deleteBase(base.id);
    throw new Error(`Nenhum documento pôde ser importado — ${errors.join(' · ')}`);
  }

  if (existing) {
    patchBase(base.id, { name, description });
    // docs que saíram da nova versão são removidos (semântica de substituição)
    const zipDocNames = new Set(docEntries.map(nameOf));
    for (const doc of listDocs(base.id)) {
      if (!zipDocNames.has(doc.name)) deleteDoc(base.id, doc.name);
    }
  }

  let sources: Record<string, DocSource> = {};
  if (sourcesEntry) {
    try {
      const parsed = JSON.parse(await sourcesEntry.async('string')) as Record<string, DocSource>;
      sources = Object.fromEntries(
        Object.entries(parsed).filter(
          ([docName, source]) => imported.has(docName) && typeof source?.url === 'string',
        ),
      );
    } catch {
      // sources.json ilegível — docs viram locais comuns
    }
  }
  // update substitui o mapeamento inteiro (inclusive limpando-o se a nova versão não tem fontes)
  if (existing || Object.keys(sources).length > 0) setDocSources(base.id, sources);

  // só entram as coleções que de fato têm páginas importadas — coleção vazia
  // vira um grupo fantasma na lista
  const used = new Set(Object.values(sources).map((s) => s.collection).filter(Boolean));
  const kept = collections.filter((c) => used.has(c.id));
  if (existing || kept.length > 0) patchBase(base.id, { collections: kept });

  return getBase(base.id) ?? base;
}

function commonDirPrefix(names: string[]): string {
  if (names.length === 0) return '';
  const first = names[0];
  const slash = first.indexOf('/');
  if (slash < 0) return '';
  const prefix = first.slice(0, slash + 1);
  return names.every((n) => n.startsWith(prefix)) ? prefix : '';
}

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  KnowledgeBase,
  KnowledgeCollection,
  KnowledgeCollectionSync,
  KnowledgeDoc,
} from '@aiportal/shared';
import { slugifyCommand } from '@aiportal/shared';
import { readJson, writeFileAtomic, writeJsonAtomic } from './jsonStore';
import { PROJECT_META_DIR, ensureDir, knowledgeDir } from './paths';
import { getProject, listProjects, projectDir } from './projectStore';
import {
  docNameForUrl,
  fetchRemoteContent,
  htmlToMarkdown,
  normalizeSourceUrl,
  sanitizeMarkdown,
} from './remoteFetch';
import { fetchSharePointContent, isSharePointUrl } from './sharepointFetch';
import {
  CRAWL_DEFAULT_DEPTH,
  CRAWL_DEFAULT_MAX_PAGES,
  crawlSite,
  type CrawlResult,
} from './siteCrawl';
import { bufferAsText } from './extractBinary';
import {
  SHARED_KNOWLEDGE_DIR,
  getLibrary,
  libraryDir,
  libraryDirs,
  setSharedBaseEnabled,
  sharedBaseEnabled,
} from './sharedLibrary';

const DOC_EXTENSIONS = ['.md', '.txt'];
/**
 * Documentos que entram como ARQUIVO ORIGINAL: o PDF/planilha/apresentação
 * fica na base como veio (para baixar e abrir no aplicativo de sempre) e o
 * texto usado no contexto e na busca sai de uma conversão cacheada em
 * .cache/<doc>.md. Antes, a UI convertia no navegador e jogava o original
 * fora — quem precisava do arquivo de novo ficava sem.
 */
const BINARY_DOC_EXTENSIONS = ['.pdf', '.docx', '.xlsx', '.xlsm', '.xls', '.pptx'];
const DOC_LIMIT = 512 * 1024;
/**
 * Teto do arquivo original guardado na base. 7 MB porque o upload chega em
 * base64 (≈ +33%) e o router recusa payload acima de 10 MB — acima disso a
 * pessoa referencia a pasta em vez de copiar o arquivo para dentro do portal.
 */
const BINARY_DOC_LIMIT = 7 * 1024 * 1024;
const SOURCES_FILE = 'sources.json';
/** Conversões dos documentos binários (texto que alimenta contexto e busca). */
const CACHE_DIR = '.cache';

export function isBinaryDoc(name: string): boolean {
  return BINARY_DOC_EXTENSIONS.includes(path.extname(name).toLowerCase());
}

type BaseMeta = Omit<KnowledgeBase, 'docCount'>;

/** Fonte remota de um documento sincronizado (sources.json, indexado pelo nome do doc). */
export interface DocSource {
  url: string;
  syncedAt?: string;
  error?: string;
  /**
   * Id da coleção (site varrido) dona do documento. É o que mantém as dezenas
   * de páginas de um mesmo site AGRUPADAS na lista, no contexto do modelo e no
   * re-sync, em vez de virarem .md soltos no meio dos documentos avulsos.
   */
  collection?: string;
  /** Título da página, exibido no lugar do nome do arquivo. */
  title?: string;
}

function readSources(dir: string): Record<string, DocSource> {
  return readJson<Record<string, DocSource>>(path.join(dir, SOURCES_FILE)) ?? {};
}

function writeSources(dir: string, sources: Record<string, DocSource>): void {
  writeJsonAtomic(path.join(dir, SOURCES_FILE), sources);
}

function baseDirFor(
  scope: 'global' | 'project' | 'shared',
  projectId?: string,
  libraryId?: string,
): string | undefined {
  if (scope === 'global') return knowledgeDir();
  if (scope === 'shared') {
    if (!libraryId) return undefined;
    const lib = getLibrary(libraryId);
    return lib ? libraryDir(lib, SHARED_KNOWLEDGE_DIR) : undefined;
  }
  if (!projectId) return undefined;
  const project = getProject(projectId);
  if (!project) return undefined;
  return path.join(projectDir(project), PROJECT_META_DIR, 'knowledge');
}

function readBasesIn(dir: string): KnowledgeBase[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const bases: KnowledgeBase[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = readJson<BaseMeta>(path.join(dir, entry.name, 'base.json'));
    if (meta?.id) bases.push({ ...meta, docCount: listDocsIn(path.join(dir, entry.name)).length });
  }
  return bases.sort((a, b) => a.name.localeCompare(b.name));
}

function listDocsIn(dir: string): KnowledgeDoc[] {
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const sources = readSources(dir);
  const docs: KnowledgeDoc[] = [];
  for (const file of files) {
    if (!file.isFile()) continue;
    const ext = path.extname(file.name).toLowerCase();
    if (!DOC_EXTENSIONS.includes(ext) && !BINARY_DOC_EXTENSIONS.includes(ext)) continue;
    const stat = fs.statSync(path.join(dir, file.name));
    const source = sources[file.name];
    docs.push({
      name: file.name,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      ...(isBinaryDoc(file.name) && { binary: true as const }),
      sourceUrl: source?.url,
      syncedAt: source?.syncedAt,
      syncError: source?.error,
      collection: source?.collection,
      title: source?.title,
    });
  }
  return docs.sort((a, b) => a.name.localeCompare(b.name));
}

/** Bases globais + as compartilhadas + (se informado) as do projeto. */
export function listBases(projectId?: string): KnowledgeBase[] {
  const bases = readBasesIn(knowledgeDir());
  if (projectId) {
    const dir = baseDirFor('project', projectId);
    if (dir) bases.push(...readBasesIn(dir));
  }
  for (const { lib, dir } of libraryDirs(SHARED_KNOWLEDGE_DIR)) {
    bases.push(
      ...readBasesIn(dir).map((b) => ({
        ...b,
        scope: 'shared' as const,
        projectId: undefined,
        libraryId: lib.id,
        // ligar/desligar uma base compartilhada é decisão de cada pessoa
        enabled: sharedBaseEnabled(b.id, b.enabled),
      })),
    );
  }
  return bases;
}

function findBaseDir(id: string): string | undefined {
  const globalDir = path.join(knowledgeDir(), id);
  if (fs.existsSync(path.join(globalDir, 'base.json'))) return globalDir;
  for (const project of listProjects()) {
    const dir = path.join(projectDir(project), PROJECT_META_DIR, 'knowledge', id);
    if (fs.existsSync(path.join(dir, 'base.json'))) return dir;
  }
  for (const { dir: libDir } of libraryDirs(SHARED_KNOWLEDGE_DIR)) {
    const dir = path.join(libDir, id);
    if (fs.existsSync(path.join(dir, 'base.json'))) return dir;
  }
  return undefined;
}

/** A pasta da base está dentro de uma biblioteca compartilhada? */
function isSharedBaseDir(dir: string): boolean {
  const parent = path.resolve(path.dirname(dir));
  return libraryDirs(SHARED_KNOWLEDGE_DIR).some((entry) => path.resolve(entry.dir) === parent);
}

/** Biblioteca dona da pasta, quando compartilhada. */
function libraryOfBaseDir(dir: string): string | undefined {
  const parent = path.resolve(path.dirname(dir));
  return libraryDirs(SHARED_KNOWLEDGE_DIR).find((entry) => path.resolve(entry.dir) === parent)?.lib
    .id;
}

export function getBase(id: string): KnowledgeBase | undefined {
  const dir = findBaseDir(id);
  if (!dir) return undefined;
  const meta = readJson<BaseMeta>(path.join(dir, 'base.json'));
  if (!meta) return undefined;
  const libraryId = libraryOfBaseDir(dir);
  const base: KnowledgeBase = { ...meta, docCount: listDocsIn(dir).length };
  if (!libraryId) return base;
  return {
    ...base,
    scope: 'shared',
    projectId: undefined,
    libraryId,
    enabled: sharedBaseEnabled(base.id, base.enabled),
  };
}

export function createBase(input: {
  name: string;
  description?: string;
  scope: 'global' | 'project' | 'shared';
  projectId?: string;
  libraryId?: string;
  enabled?: boolean;
  importedFrom?: string;
}): KnowledgeBase | undefined {
  const parent = baseDirFor(input.scope, input.projectId, input.libraryId);
  if (!parent) return undefined;
  const now = new Date().toISOString();
  const meta: BaseMeta = {
    id: crypto.randomUUID(),
    name: input.name,
    description: input.description,
    scope: input.scope,
    projectId: input.scope === 'project' ? input.projectId : undefined,
    libraryId: input.scope === 'shared' ? input.libraryId : undefined,
    enabled: input.enabled ?? true,
    importedFrom: input.importedFrom,
    createdAt: now,
    updatedAt: now,
  };
  const dir = path.join(parent, meta.id);
  ensureDir(dir);
  writeJsonAtomic(path.join(dir, 'base.json'), meta);
  return { ...meta, docCount: 0 };
}

export function patchBase(
  id: string,
  patch: Partial<Pick<KnowledgeBase, 'name' | 'description' | 'enabled' | 'collections'>>,
): KnowledgeBase | undefined {
  const dir = findBaseDir(id);
  if (!dir) return undefined;
  const meta = readJson<BaseMeta>(path.join(dir, 'base.json'));
  if (!meta) return undefined;
  // base compartilhada: o enabled é preferência local, o resto vai para a pasta
  if (isSharedBaseDir(dir) && patch.enabled !== undefined) {
    setSharedBaseEnabled(id, patch.enabled);
    const { enabled: _ignored, ...rest } = patch;
    patch = rest;
    if (Object.keys(patch).length === 0) return getBase(id);
  }
  const updated: BaseMeta = { ...meta, ...patch, updatedAt: new Date().toISOString() };
  writeJsonAtomic(path.join(dir, 'base.json'), updated);
  return getBase(id);
}

/**
 * Move a base inteira (pasta, documentos e fontes) para outro escopo — em
 * especial para uma biblioteca compartilhada. É o que faz um agente
 * compartilhado ser útil de verdade: sem levar as bases junto, quem receber o
 * agente vê vínculos para ids que não existem na máquina dele.
 */
export function moveBaseToScope(
  id: string,
  target: { scope: 'global' | 'project' | 'shared'; projectId?: string; libraryId?: string },
): KnowledgeBase | undefined {
  const dir = findBaseDir(id);
  if (!dir) return undefined;
  const meta = readJson<BaseMeta>(path.join(dir, 'base.json'));
  if (!meta) return undefined;
  const parent = baseDirFor(target.scope, target.projectId, target.libraryId);
  if (!parent) return undefined;
  const destination = path.join(parent, id);
  if (path.resolve(destination) !== path.resolve(dir)) {
    ensureDir(parent);
    if (fs.existsSync(destination)) {
      throw new Error('Já existe uma base com este id no destino');
    }
    try {
      fs.renameSync(dir, destination);
    } catch (err) {
      // disco local → pasta de rede são volumes diferentes: rename não vale
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      fs.cpSync(dir, destination, { recursive: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const updated: BaseMeta = {
    ...meta,
    scope: target.scope,
    projectId: target.scope === 'project' ? target.projectId : undefined,
    libraryId: target.scope === 'shared' ? target.libraryId : undefined,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(destination, 'base.json'), updated);
  return getBase(id);
}

export function deleteBase(id: string): boolean {
  const dir = findBaseDir(id);
  if (!dir) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function safeDocName(name: string): string {
  const base = path.basename(name);
  const ext = path.extname(base).toLowerCase();
  if (base !== name || (!DOC_EXTENSIONS.includes(ext) && !BINARY_DOC_EXTENSIONS.includes(ext))) {
    throw new Error(
      'Documento deve ser .md, .txt, .pdf, .docx, .xlsx, .xls ou .pptx, sem subpastas',
    );
  }
  return base;
}

/** Caminho da conversão em texto de um documento binário. */
function cachePathFor(dir: string, docName: string): string {
  return path.join(dir, CACHE_DIR, `${docName}.md`);
}

/** A conversão existe e é mais nova que o arquivo original? */
function cacheIsFresh(dir: string, docName: string): boolean {
  try {
    const cache = fs.statSync(cachePathFor(dir, docName));
    const doc = fs.statSync(path.join(dir, docName));
    return cache.mtimeMs >= doc.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Converte um documento binário em texto e guarda o resultado no cache. Roda
 * no upload e na primeira leitura; erro de conversão vira o próprio conteúdo
 * do cache (o modelo lê o motivo em vez de silêncio) — mas não se repete a
 * cada leitura.
 */
export async function ensureDocText(baseId: string, name: string): Promise<string | undefined> {
  const dir = findBaseDir(baseId);
  if (!dir) return undefined;
  const docName = safeDocName(name);
  if (!isBinaryDoc(docName)) return readDoc(baseId, docName);
  const cache = cachePathFor(dir, docName);
  if (cacheIsFresh(dir, docName)) {
    try {
      return fs.readFileSync(cache, 'utf8');
    } catch {
      // cache ilegível — reconverte abaixo
    }
  }
  let text: string;
  try {
    const data = fs.readFileSync(path.join(dir, docName));
    text = (await bufferAsText(data, docName)) ?? '';
  } catch (err) {
    text = `[o portal não conseguiu converter "${docName}" em texto: ${
      err instanceof Error ? err.message : String(err)
    }]`;
  }
  ensureDir(path.dirname(cache));
  writeFileAtomic(cache, text);
  return text;
}

export function listDocs(baseId: string): KnowledgeDoc[] {
  const dir = findBaseDir(baseId);
  return dir ? listDocsIn(dir) : [];
}

/**
 * Texto do documento. Para binário devolve a conversão cacheada — quem quiser
 * garantir que ela existe chama ensureDocText (async) antes; aqui a leitura
 * segue síncrona porque contexto e busca percorrem muitos documentos.
 */
export function readDoc(baseId: string, name: string): string | undefined {
  const dir = findBaseDir(baseId);
  if (!dir) return undefined;
  const docName = safeDocName(name);
  try {
    if (isBinaryDoc(docName)) {
      if (!cacheIsFresh(dir, docName)) {
        // documento copiado direto para a pasta (ou cache invalidado): converte
        // em background para a próxima leitura já vir com o texto
        void ensureDocText(baseId, docName).catch(() => undefined);
        return `[${docName}: a conversão em texto está sendo gerada — consulte de novo em instantes]`;
      }
      return fs.readFileSync(cachePathFor(dir, docName), 'utf8');
    }
    return fs.readFileSync(path.join(dir, docName), 'utf8');
  } catch {
    return undefined;
  }
}

/** Bytes do documento como está no disco (download e leitura do original). */
export function readDocRaw(baseId: string, name: string): Buffer | undefined {
  const dir = findBaseDir(baseId);
  if (!dir) return undefined;
  try {
    return fs.readFileSync(path.join(dir, safeDocName(name)));
  } catch {
    return undefined;
  }
}

/** Grava um documento binário (PDF/Word/Excel/PPT) e já deixa a conversão pronta. */
export async function writeBinaryDoc(
  baseId: string,
  name: string,
  data: Buffer,
): Promise<KnowledgeDoc> {
  const dir = findBaseDir(baseId);
  if (!dir) throw new Error('Base de conhecimento não encontrada');
  const docName = safeDocName(name);
  if (!isBinaryDoc(docName)) throw new Error(`"${docName}" não é um documento binário`);
  if (data.length > BINARY_DOC_LIMIT) {
    throw new Error(`Documento excede o limite de ${BINARY_DOC_LIMIT / 1024 / 1024} MB`);
  }
  const file = path.join(dir, docName);
  ensureDir(dir);
  fs.writeFileSync(file, data);
  await ensureDocText(baseId, docName);
  patchBase(baseId, {});
  const stat = fs.statSync(file);
  return { name: docName, size: stat.size, mtime: stat.mtime.toISOString(), binary: true };
}

export function writeDoc(baseId: string, name: string, content: string): KnowledgeDoc {
  const dir = findBaseDir(baseId);
  if (!dir) throw new Error('Base de conhecimento não encontrada');
  if (Buffer.byteLength(content) > DOC_LIMIT) {
    throw new Error(`Documento excede o limite de ${DOC_LIMIT / 1024} KB`);
  }
  const file = path.join(dir, safeDocName(name));
  writeFileAtomic(file, content);
  const stat = fs.statSync(file);
  patchBase(baseId, {});
  return { name: safeDocName(name), size: stat.size, mtime: stat.mtime.toISOString() };
}

export function deleteDoc(baseId: string, name: string): boolean {
  const dir = findBaseDir(baseId);
  if (!dir) return false;
  try {
    const doc = safeDocName(name);
    fs.rmSync(path.join(dir, doc), { force: true });
    fs.rmSync(cachePathFor(dir, doc), { force: true });
    const sources = readSources(dir);
    if (sources[doc]) {
      delete sources[doc];
      writeSources(dir, sources);
    }
    return true;
  } catch {
    return false;
  }
}

/** Move um documento para outra base, levando junto a fonte remota (se houver). */
export function moveDoc(fromBaseId: string, name: string, toBaseId: string): KnowledgeDoc {
  if (fromBaseId === toBaseId) throw new Error('Escolha uma base diferente da atual');
  const fromDir = findBaseDir(fromBaseId);
  const toDir = findBaseDir(toBaseId);
  if (!fromDir || !toDir) throw new Error('Base de conhecimento não encontrada');
  const docName = safeDocName(name);
  const content = readDoc(fromBaseId, docName);
  if (content === undefined) {
    throw new Error(`Documento "${docName}" não existe na base de origem`);
  }
  if (fs.existsSync(path.join(toDir, docName))) {
    throw new Error(`A base de destino já tem um documento "${docName}"`);
  }
  const source = readSources(fromDir)[docName];
  const doc = writeDoc(toBaseId, docName, content);
  if (source) {
    const targetSources = readSources(toDir);
    targetSources[docName] = source;
    writeSources(toDir, targetSources);
  }
  deleteDoc(fromBaseId, docName);
  return {
    ...doc,
    sourceUrl: source?.url,
    syncedAt: source?.syncedAt,
    syncError: source?.error,
    collection: source?.collection,
    title: source?.title,
  };
}

/** Baixa o conteúdo de uma fonte remota, escolhendo o caminho pela URL. */
export async function fetchSourceContent(
  url: string,
): Promise<{ content: string; suggestedName?: string }> {
  if (isSharePointUrl(url)) return fetchSharePointContent(url);
  return { content: await fetchRemoteContent(url) };
}

/**
 * Cria um documento sincronizado de uma URL remota (GitHub Pages, markdown
 * bruto, página/arquivo de SharePoint…): baixa o conteúdo, converte para
 * markdown e registra a fonte para re-sync.
 */
export async function addRemoteDoc(baseId: string, rawUrl: string, name?: string): Promise<KnowledgeDoc> {
  const dir = findBaseDir(baseId);
  if (!dir) throw new Error('Base de conhecimento não encontrada');
  const url = normalizeSourceUrl(rawUrl);
  const fetched = await fetchSourceContent(url);
  let docName = name?.trim() || fetched.suggestedName || docNameForUrl(url);
  if (!/\.(md|txt)$/i.test(docName)) docName = `${docName}.md`;
  docName = safeDocName(docName);
  const doc = writeDoc(baseId, docName, fetched.content);
  const sources = readSources(dir);
  const syncedAt = new Date().toISOString();
  sources[doc.name] = { url, syncedAt };
  writeSources(dir, sources);
  return { ...doc, sourceUrl: url, syncedAt };
}

export interface SyncResult {
  docs: KnowledgeDoc[];
  errors: Array<{ name: string; error: string }>;
}

/** Re-sincroniza um documento remoto (ou todos os da base, se name não for informado). */
export async function syncRemoteDocs(baseId: string, name?: string): Promise<SyncResult> {
  const dir = findBaseDir(baseId);
  if (!dir) throw new Error('Base de conhecimento não encontrada');
  const sources = readSources(dir);
  const names = name ? [safeDocName(name)] : Object.keys(sources);
  const errors: SyncResult['errors'] = [];
  for (const docName of names) {
    const source = sources[docName];
    if (!source) {
      errors.push({ name: docName, error: 'Documento não tem fonte remota' });
      continue;
    }
    try {
      const { content } = await fetchSourceContent(source.url);
      writeDoc(baseId, docName, content);
      sources[docName] = { url: source.url, syncedAt: new Date().toISOString() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sources[docName] = { ...source, error: message };
      errors.push({ name: docName, error: message });
    }
  }
  writeSources(dir, sources);
  return { docs: listDocsIn(dir), errors };
}

/** Fontes remotas da base, para export/import preservar os vínculos de sync. */
export function getDocSources(baseId: string): Record<string, DocSource> {
  const dir = findBaseDir(baseId);
  return dir ? readSources(dir) : {};
}

export function setDocSources(baseId: string, sources: Record<string, DocSource>): void {
  const dir = findBaseDir(baseId);
  if (!dir) throw new Error('Base de conhecimento não encontrada');
  writeSources(dir, sources);
}

/* ---------- coleções: um site varrido vira UM grupo, não 30 .md soltos ---------- */

function slugify(raw: string, max = 28): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

export function listCollections(baseId: string): KnowledgeCollection[] {
  return getBase(baseId)?.collections ?? [];
}

/** Rótulo do grupo: "meudocs.github.io/guia". */
function collectionLabel(root: URL): string {
  return `${root.host}${root.pathname.replace(/\/+$/, '')}`.slice(0, 80);
}

/**
 * Slug único da coleção dentro da base. Vira TAMBÉM o prefixo dos arquivos
 * gerados: assim, mesmo quem abrir a pasta no explorador vê as páginas do
 * mesmo site juntas e em ordem, em vez de intercaladas com os avulsos.
 */
function collectionIdFor(root: URL, taken: Set<string>): string {
  const segments = root.pathname
    .split('/')
    .filter(Boolean)
    .filter((s) => !/\.[a-z0-9]+$/i.test(s));
  const base =
    slugify(segments.slice(-2).join('-')) || slugify(root.hostname.split('.')[0]) || 'site';
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

/** Prefixo de caminho que delimitou a varredura (mesma regra do siteCrawl). */
function rootPrefixOf(root: URL): string {
  const p = root.pathname;
  if (/\.[a-z0-9]+$/i.test(p)) return p.replace(/\/[^/]*$/, '/');
  return p.endsWith('/') ? p : `${p}/`;
}

/** Nome do arquivo de uma página: prefixo da coleção + caminho relativo à raiz. */
function docNameForPage(collectionId: string, pageUrl: string, rootPrefix: string): string {
  let rel = '';
  try {
    const pathname = new URL(pageUrl).pathname;
    rel = pathname.startsWith(rootPrefix) ? pathname.slice(rootPrefix.length) : pathname;
  } catch {
    rel = '';
  }
  rel = rel.replace(/\.(html?|php)$/i, '').replace(/\/+$/, '');
  return `${collectionId}__${slugify(rel, 60) || 'index'}.md`;
}

export type CollectionSyncResult = KnowledgeCollectionSync;

/**
 * Grava o resultado de uma varredura na base: uma página por documento, todas
 * marcadas com o id da coleção. Páginas que sumiram do site desde a última
 * varredura são removidas, para o grupo refletir o site de verdade.
 */
function writeCrawl(
  baseId: string,
  dir: string,
  collection: KnowledgeCollection,
  crawl: CrawlResult,
): CollectionSyncResult {
  const rootPrefix = rootPrefixOf(new URL(collection.rootUrl));
  const sources = readSources(dir);
  const before = new Set(
    Object.entries(sources)
      .filter(([, s]) => s.collection === collection.id)
      .map(([name]) => name),
  );
  const now = new Date().toISOString();
  const kept = new Set<string>();
  let added = 0;
  let updated = 0;
  const errors = [...crawl.errors];

  for (const page of crawl.pages) {
    let docName = docNameForPage(collection.id, page.url, rootPrefix);
    // duas URLs diferentes que colapsam no mesmo slug (ex.: /a/x e /a-x)
    for (let n = 2; kept.has(docName); n += 1) {
      docName = docNameForPage(`${collection.id}`, page.url, rootPrefix).replace(/\.md$/, `-${n}.md`);
    }
    try {
      writeDoc(baseId, docName, page.content);
      sources[docName] = {
        url: page.url,
        syncedAt: now,
        collection: collection.id,
        title: page.title,
      };
      if (before.has(docName)) updated += 1;
      else added += 1;
      kept.add(docName);
    } catch (err) {
      errors.push({ url: page.url, error: err instanceof Error ? err.message : String(err) });
    }
  }

  let removed = 0;
  for (const name of before) {
    if (kept.has(name)) continue;
    if (deleteDoc(baseId, name)) removed += 1;
    delete sources[name];
  }
  writeSources(dir, sources);

  const synced: KnowledgeCollection = {
    ...collection,
    via: crawl.via,
    syncedAt: now,
    syncError: undefined,
  };
  return {
    collection: synced,
    docs: listDocsIn(dir),
    added,
    updated,
    removed,
    errors,
    truncated: crawl.truncated,
  };
}

/**
 * Varre um site a partir de uma URL e traz as páginas para a base como um
 * grupo. É a alternativa ao "adicionar da URL", que só traz UMA página.
 */
export async function addSiteCollection(
  baseId: string,
  rawUrl: string,
  opts: { maxPages?: number; depth?: number } = {},
): Promise<CollectionSyncResult> {
  const dir = findBaseDir(baseId);
  if (!dir) throw new Error('Base de conhecimento não encontrada');
  const rootUrl = normalizeSourceUrl(rawUrl);
  const existing = listCollections(baseId);
  if (existing.some((c) => c.rootUrl === rootUrl)) {
    throw new Error(
      'Este site já foi varrido nesta base — use "Sincronizar" no grupo para atualizar as páginas',
    );
  }
  const maxPages = opts.maxPages ?? CRAWL_DEFAULT_MAX_PAGES;
  const depth = opts.depth ?? CRAWL_DEFAULT_DEPTH;
  const crawl = await crawlSite(rootUrl, { maxPages, depth });
  const collection: KnowledgeCollection = {
    id: collectionIdFor(new URL(rootUrl), new Set(existing.map((c) => c.id))),
    name: collectionLabel(new URL(rootUrl)),
    rootUrl,
    maxPages,
    depth,
  };
  const result = writeCrawl(baseId, dir, collection, crawl);
  saveCollections(baseId, [...existing, result.collection]);
  return result;
}

/**
 * Re-varre um site já trazido. Falha total NÃO apaga o que já está na base: o
 * erro fica registrado no grupo e as páginas antigas continuam valendo — numa
 * rede corporativa, um site fora do ar por um minuto não pode esvaziar a base.
 */
export async function syncCollection(
  baseId: string,
  collectionId: string,
): Promise<CollectionSyncResult> {
  const dir = findBaseDir(baseId);
  if (!dir) throw new Error('Base de conhecimento não encontrada');
  const collections = listCollections(baseId);
  const collection = collections.find((c) => c.id === collectionId);
  if (!collection) throw new Error('Site não encontrado nesta base');
  try {
    const crawl = await crawlSite(collection.rootUrl, {
      maxPages: collection.maxPages,
      depth: collection.depth,
    });
    const result = writeCrawl(baseId, dir, collection, crawl);
    saveCollections(
      baseId,
      collections.map((c) => (c.id === collectionId ? result.collection : c)),
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed: KnowledgeCollection = { ...collection, syncError: message };
    saveCollections(
      baseId,
      collections.map((c) => (c.id === collectionId ? failed : c)),
    );
    throw err;
  }
}

/** Remove o grupo e, por padrão, as páginas que vieram com ele. */
export function deleteCollection(
  baseId: string,
  collectionId: string,
  opts: { keepDocs?: boolean } = {},
): boolean {
  const dir = findBaseDir(baseId);
  if (!dir) return false;
  const collections = listCollections(baseId);
  if (!collections.some((c) => c.id === collectionId)) return false;
  const sources = readSources(dir);
  for (const [name, source] of Object.entries(sources)) {
    if (source.collection !== collectionId) continue;
    if (opts.keepDocs) {
      // vira documento avulso, mantendo o vínculo de sync da página
      sources[name] = { url: source.url, syncedAt: source.syncedAt, error: source.error };
    } else {
      deleteDoc(baseId, name);
      delete sources[name];
    }
  }
  writeSources(dir, sources);
  saveCollections(
    baseId,
    collections.filter((c) => c.id !== collectionId),
  );
  return true;
}

function saveCollections(baseId: string, collections: KnowledgeCollection[]): void {
  patchBase(baseId, { collections });
}

/** Base global que recebe as páginas enviadas pelo bookmarklet do navegador. */
const CAPTURE_BASE_NAME = 'Capturas do navegador';

/**
 * Salva uma página enviada pelo bookmarklet "Enviar para o portal" (o usuário
 * clica nele numa aba onde a página já está renderizada — é assim que
 * conteúdo atrás de SSO, como SharePoint, entra sem app no Entra ID).
 * Capturar a mesma página de novo sobrescreve o documento (re-sync manual).
 */
export function saveCapturedDoc(input: {
  title?: string;
  url?: string;
  html?: string;
  text?: string;
}): { baseName: string; docName: string } {
  let base = listBases().find(
    (b) => b.scope === 'global' && b.name.toLowerCase() === CAPTURE_BASE_NAME.toLowerCase(),
  );
  base ??= createBase({
    name: CAPTURE_BASE_NAME,
    scope: 'global',
    description: 'Páginas enviadas pelo bookmarklet "Enviar para o portal" (SharePoint, intranet…)',
  });
  if (!base) throw new Error('Não foi possível criar a base de capturas');

  const markdown = input.html
    ? sanitizeMarkdown(htmlToMarkdown(input.html), input.url ?? 'about:blank')
    : (input.text ?? '').trim();
  if (!markdown) throw new Error('A página não tem conteúdo de texto extraível');

  const title = input.title?.trim() || 'Página capturada';
  const header =
    `# ${title}\n\n` +
    `> Fonte: ${input.url ?? '(desconhecida)'} — capturada em ${new Date().toLocaleString('pt-BR')}. ` +
    'Para atualizar, clique no bookmarklet de novo na página.\n\n';
  const docName = `${slugifyCommand(title).slice(0, 60) || 'pagina-capturada'}.md`;
  const doc = writeDoc(base.id, docName, header + markdown);
  return { baseName: base.name, docName: doc.name };
}

export interface KnowledgeSnippet {
  baseName: string;
  docName: string;
  content: string;
  /** Site varrido dono do documento (quando veio de uma coleção). */
  collectionName?: string;
  title?: string;
  sourceUrl?: string;
}

/** Entrada do índice injetado no lugar do conteúdo quando as bases não cabem. */
export interface KnowledgeIndexEntry {
  baseName: string;
  docName: string;
  size: number;
  headings: string[];
  /** Rótulo do site varrido dono do documento — o índice agrupa por ele. */
  collectionName?: string;
  /** Título e URL da página de origem (documento vindo de varredura). */
  title?: string;
  sourceUrl?: string;
}

export interface KnowledgeContext {
  snippets: KnowledgeSnippet[];
  index: KnowledgeIndexEntry[];
}

const PER_DOC_CAP = 16_000;
const TOTAL_CAP = 48_000;
/** Teto por chamada de portal_read_knowledge (o modelo continua com offset). */
const READ_TOOL_CAP = 24_000;
const SEARCH_RESULTS = 8;
const SEARCH_SNIPPET_CAP = 1_200;

/** Bases habilitadas (globais + do projeto) mais as vinculadas ao agente da sessão. */
function enabledBases(projectId?: string | null, extraBaseIds?: string[]): KnowledgeBase[] {
  const bases = listBases(projectId ?? undefined).filter((b) => b.enabled);
  const included = new Set(bases.map((b) => b.id));
  for (const id of extraBaseIds ?? []) {
    if (included.has(id)) continue;
    const base = getBase(id);
    if (base) {
      bases.push(base);
      included.add(id);
    }
  }
  return bases;
}

/**
 * Conteúdo das bases habilitadas para injetar no contexto, com teto por
 * documento e total (comportamento clássico: entra tudo, truncando).
 */
export function collectKnowledge(
  projectId?: string | null,
  extraBaseIds?: string[],
): KnowledgeSnippet[] {
  const snippets: KnowledgeSnippet[] = [];
  let total = 0;
  for (const base of enabledBases(projectId, extraBaseIds)) {
    const collectionNames = new Map((base.collections ?? []).map((c) => [c.id, c.name]));
    for (const doc of listDocs(base.id)) {
      if (total >= TOTAL_CAP) return snippets;
      let content = readDoc(base.id, doc.name) ?? '';
      if (content.length > PER_DOC_CAP) {
        content = `${content.slice(0, PER_DOC_CAP)}\n… (documento truncado)`;
      }
      if (total + content.length > TOTAL_CAP) {
        content = `${content.slice(0, TOTAL_CAP - total)}\n… (limite de contexto das bases atingido)`;
      }
      total += content.length;
      snippets.push({
        baseName: base.name,
        docName: doc.name,
        content,
        collectionName: doc.collection ? collectionNames.get(doc.collection) : undefined,
        title: doc.title,
        sourceUrl: doc.sourceUrl,
      });
    }
  }
  return snippets;
}

/**
 * Contexto de conhecimento da conversa. Enquanto o conteúdo cabe no teto,
 * tudo é injetado (zero latência extra). Quando excede E a conversa tem as
 * ferramentas de busca (canSearch), injeta só um índice — o modelo recupera o
 * que precisar com portal_search_knowledge/portal_read_knowledge, em vez de
 * receber 48 KB truncados às cegas.
 */
export function collectKnowledgeContext(
  projectId?: string | null,
  extraBaseIds?: string[],
  canSearch = false,
): KnowledgeContext {
  const bases = enabledBases(projectId, extraBaseIds);
  const totalSize = bases.reduce(
    (sum, base) => sum + listDocs(base.id).reduce((s, d) => s + d.size, 0),
    0,
  );
  if (!canSearch || totalSize <= TOTAL_CAP) {
    return { snippets: collectKnowledge(projectId, extraBaseIds), index: [] };
  }
  const index: KnowledgeIndexEntry[] = [];
  for (const base of bases) {
    const collections = new Map((base.collections ?? []).map((c) => [c.id, c.name]));
    for (const doc of listDocs(base.id)) {
      index.push({
        baseName: base.name,
        docName: doc.name,
        size: doc.size,
        headings: docHeadings(readDoc(base.id, doc.name) ?? ''),
        collectionName: doc.collection ? collections.get(doc.collection) : undefined,
        title: doc.title,
        sourceUrl: doc.sourceUrl,
      });
    }
  }
  return { snippets: [], index };
}

/** Títulos (#/##/###) do documento para o índice; sem títulos, a primeira linha. */
function docHeadings(content: string, max = 6): string[] {
  const headings: string[] = [];
  for (const line of content.split('\n')) {
    const match = /^#{1,3}\s+(.+)/.exec(line.trim());
    if (match) headings.push(match[1].trim().slice(0, 80));
    if (headings.length >= max) return headings;
  }
  if (!headings.length) {
    const first = content.split('\n').find((l) => l.trim());
    if (first) headings.push(first.trim().slice(0, 80));
  }
  return headings;
}

// ---------------------------------------------------------------------------
// Busca lexical para as ferramentas do agente

/**
 * Sin\u00f4nimos/expans\u00f5es do dom\u00ednio banc\u00e1rio \u2014 EDITE AQUI para ensinar novas
 * equival\u00eancias \u00e0 busca. Cada linha agrupa express\u00f5es equivalentes: quando a
 * query cont\u00e9m uma delas, as outras entram na busca com peso menor (0.5).
 * Use min\u00fasculas SEM acento (forma j\u00e1 normalizada); preposi\u00e7\u00f5es curtas
 * ("de", "do"\u2026) s\u00e3o ignoradas automaticamente.
 */
const DOMAIN_SYNONYMS: string[][] = [
  ['pj', 'pessoa juridica'],
  ['pf', 'pessoa fisica'],
  ['cc', 'conta corrente'],
  ['cartao', 'credito'],
  ['prd', 'documento de requisitos'],
  ['pix', 'pagamento instantaneo'],
  ['ir', 'imposto de renda'],
  ['cdb', 'certificado de deposito bancario'],
  ['ted', 'transferencia'],
];

/** Stopwords do portugu\u00eas ignoradas na query e nas expans\u00f5es de sin\u00f4nimo. */
const QUERY_STOPWORDS = new Set([
  'a', 'o', 'e', 'as', 'os', 'um', 'uma', 'de', 'da', 'do', 'das', 'dos',
  'em', 'no', 'na', 'nos', 'nas', 'ao', 'aos', 'se', 'que', 'com', 'por',
  'para', 'sobre', 'como', 'qual', 'quais', 'sao', 'ser', 'tem', 'seu', 'sua',
]);

/** Peso dos termos vindos de expans\u00e3o de sin\u00f4nimo (menor que os da query). */
const SYNONYM_WEIGHT = 0.5;

function normalizeText(text: string): string {
  // Folding de acentos nos dois lados (query e conte\u00fado): NFD separa a letra
  // do diacr\u00edtico e a faixa U+0300\u2013U+036F remove acentos e cedilha.
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Radical m\u00ednimo que o stemmer preserva ao remover um sufixo. */
const MIN_STEM = 3;

function stripSuffix(word: string, suffixes: string[]): string {
  for (const suffix of suffixes) {
    if (word.length - suffix.length >= MIN_STEM && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/**
 * Stemmer leve de portugu\u00eas (RSLP simplificado, sem depend\u00eancias): reduz
 * plural, feminino, diminutivo e sufixos verbais/nominais comuns para que
 * varia\u00e7\u00f5es da mesma palavra convirjam no mesmo radical \u2014 "aprova\u00e7\u00e3o",
 * "aprova\u00e7\u00f5es" e "aprovar" viram "aprov". Recebe palavra j\u00e1 normalizada
 * (min\u00fasculas, sem acento); siglas, c\u00f3digos e palavras curtas ficam intactos.
 */
function stemPt(word: string): string {
  if (word.length < 4 || /[0-9]/.test(word)) return word;
  let w = word;

  // plural
  if (w.endsWith('s') && w.length >= 5) {
    if (w.endsWith('oes') || w.endsWith('aes') || w.endsWith('aos')) w = `${w.slice(0, -3)}ao`;
    else if (w.endsWith('ais') || w.endsWith('eis') || w.endsWith('ois') || w.endsWith('uis')) {
      w = `${w.slice(0, -2)}l`; // canais\u2192canal, papeis\u2192papel
    } else if (w.endsWith('res') && w.length >= 6) w = w.slice(0, -2); // valores\u2192valor
    else if (w.endsWith('ns')) w = `${w.slice(0, -2)}m`; // margens\u2192margem
    else w = w.slice(0, -1);
  }

  // feminino \u2192 forma base
  if (w.endsWith('ona')) w = `${w.slice(0, -3)}ao`; // saldona\u2192saldao
  else if (w.endsWith('ora') && w.length >= 6) w = w.slice(0, -1); // diretora\u2192diretor
  else if (w.endsWith('eira') && w.length >= 6) w = `${w.slice(0, -1)}o`; // financeira\u2192financeiro

  // diminutivo
  w = stripSuffix(w, ['zinho', 'zinha', 'inho', 'inha']);

  // sufixos nominais (do mais longo ao mais curto, um por palavra)
  const beforeNominal = w;
  w = stripSuffix(w, [
    'izacao', 'amento', 'imento', 'adora', 'edora', 'acao', 'icao', 'ucao',
    'encia', 'ancia', 'mente', 'idade', 'agem', 'ismo', 'ista', 'ivel', 'avel',
    'ador', 'edor', 'ante', 'ente', 'eiro', 'oso', 'osa',
  ]);

  // sufixos verbais, s\u00f3 se nenhum nominal foi removido
  if (w === beforeNominal) {
    w = stripSuffix(w, [
      'aria', 'eria', 'iria', 'asse', 'esse', 'isse', 'aram', 'eram', 'iram',
      'avam', 'ando', 'endo', 'indo', 'ado', 'ada', 'ido', 'ida', 'ara', 'era',
      'ira', 'ava', 'ia', 'ou', 'ei', 'ar', 'er', 'ir', 'am', 'em',
    ]);
  }

  // vogal tem\u00e1tica residual (aprovado\u2192aprovad\u2192aprov); "ao" final \u00e9 preservado
  // para "cart\u00e3o"/"cart\u00f5es" convergirem no mesmo radical
  if (w.length > MIN_STEM && !w.endsWith('ao') && /[aeo]$/.test(w)) w = w.slice(0, -1);
  return w;
}

/** Termo de busca j\u00e1 preparado (normalizado + radical + regras de match). */
interface SearchTerm {
  /** Palavra normalizada, como veio da query ou do sin\u00f4nimo. */
  raw: string;
  /** Radical ap\u00f3s o stemming, comparado com o radical das palavras do doc. */
  stem: string;
  /** Termos de 2 letras (siglas "PJ", "IR"\u2026) s\u00f3 casam palavra inteira. */
  wholeWord: boolean;
  /** 1 para termos da query, SYNONYM_WEIGHT para expans\u00f5es de sin\u00f4nimo. */
  weight: number;
  /** \u00cdndice do termo original da query \u2014 expans\u00f5es contam como o mesmo conceito. */
  concept: number;
}

const synonymWords = (variant: string): string[] =>
  variant.split(' ').filter((w) => w.length >= 2 && !QUERY_STOPWORDS.has(w));

/** Tokeniza a query (termos de 2+ letras, sem stopwords) e expande com DOMAIN_SYNONYMS. */
function buildSearchTerms(query: string): SearchTerm[] {
  const tokens = [
    ...new Set(
      normalizeText(query)
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2 && !QUERY_STOPWORDS.has(t)),
    ),
  ];
  const terms: SearchTerm[] = tokens.map((raw, i) => ({
    raw,
    stem: stemPt(raw),
    wholeWord: raw.length === 2,
    weight: 1,
    concept: i,
  }));
  const inQuery = new Set(tokens);
  for (const group of DOMAIN_SYNONYMS) {
    const hit = group.find((variant) => synonymWords(variant).every((w) => inQuery.has(w)));
    if (!hit) continue;
    const concept = terms.find((t) => synonymWords(hit).includes(t.raw))?.concept ?? 0;
    for (const variant of group) {
      if (variant === hit) continue;
      for (const word of synonymWords(variant)) {
        if (inQuery.has(word)) continue;
        terms.push({
          raw: word,
          stem: stemPt(word),
          wholeWord: word.length === 2,
          weight: SYNONYM_WEIGHT,
          concept,
        });
      }
    }
  }
  return terms;
}

interface DocSection {
  heading: string;
  content: string;
}

/** Divide por títulos markdown; seções longas quebram em blocos de parágrafos. */
function splitSections(content: string): DocSection[] {
  const sections: DocSection[] = [];
  let heading = '';
  let buffer: string[] = [];
  const flush = () => {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (!text) return;
    // seções gigantes viram blocos menores para o score não diluir
    for (let i = 0; i < text.length; i += 2_000) {
      sections.push({ heading, content: text.slice(i, i + 2_000) });
    }
  };
  for (const line of content.split('\n')) {
    const match = /^#{1,4}\s+(.+)/.exec(line.trim());
    if (match) {
      flush();
      heading = match[1].trim();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

/** Frequência das palavras e dos radicais de um texto, para lookup O(1) por termo. */
interface TokenIndex {
  words: Map<string, number>;
  stems: Map<string, number>;
}

function indexTokens(text: string): TokenIndex {
  const words = new Map<string, number>();
  const stems = new Map<string, number>();
  for (const token of normalizeText(text).split(/[^a-z0-9]+/)) {
    if (!token) continue;
    words.set(token, (words.get(token) ?? 0) + 1);
    const stem = stemPt(token);
    stems.set(stem, (stems.get(stem) ?? 0) + 1);
  }
  return { words, stems };
}

/** Ocorrências do termo no índice: sigla de 2 letras exige palavra inteira. */
function countTerm(index: TokenIndex, term: SearchTerm): number {
  if (term.wholeWord) return index.words.get(term.raw) ?? 0;
  return index.stems.get(term.stem) ?? 0;
}

export interface KnowledgeHit {
  baseName: string;
  docName: string;
  heading: string;
  snippet: string;
}

/**
 * Busca por palavras-chave nas bases habilitadas da conversa. Query e conteúdo
 * passam por folding de acentos + stemming leve de pt-BR, siglas de 2 letras
 * casam palavra inteira e sinônimos do domínio (DOMAIN_SYNONYMS) expandem a
 * query. Ranqueia seções priorizando quantos termos distintos casam (e
 * presença no nome do documento/título da seção) sobre repetição do mesmo termo.
 */
export function searchKnowledge(
  query: string,
  projectId?: string | null,
  extraBaseIds?: string[],
  baseFilter?: string,
): KnowledgeHit[] {
  const terms = buildSearchTerms(query);
  if (!terms.length) return [];
  const wanted = baseFilter ? normalizeText(baseFilter) : undefined;
  const scored: Array<KnowledgeHit & { score: number }> = [];
  for (const base of enabledBases(projectId, extraBaseIds)) {
    if (wanted && !normalizeText(base.name).includes(wanted)) continue;
    for (const doc of listDocs(base.id)) {
      const content = readDoc(base.id, doc.name);
      if (!content) continue;
      for (const section of splitSections(content)) {
        const body = indexTokens(section.content);
        // nome do documento + título da seção: match aqui vale um boost (×4)
        const head = indexTokens(`${doc.name} ${section.heading}`);
        const matchedConcepts = new Set<number>();
        let score = 0;
        for (const term of terms) {
          const inBody = countTerm(body, term);
          const inHead = countTerm(head, term);
          if (!inBody && !inHead) continue;
          matchedConcepts.add(term.concept);
          score += (Math.min(inBody, 5) + inHead * 4) * term.weight;
        }
        if (!matchedConcepts.size) continue;
        score += matchedConcepts.size * 20;
        scored.push({
          baseName: base.name,
          docName: doc.name,
          heading: section.heading,
          snippet: section.content.slice(0, SEARCH_SNIPPET_CAP),
          score,
        });
      }
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, SEARCH_RESULTS)
    .map(({ score: _score, ...hit }) => hit);
}

/**
 * Lê um documento para a ferramenta portal_read_knowledge. A base pode vir
 * pelo nome (como no índice injetado) ou pelo id.
 */
export function readKnowledgeDoc(
  baseRef: string,
  docName: string,
  projectId?: string | null,
  extraBaseIds?: string[],
  offset = 0,
): string {
  const bases = enabledBases(projectId, extraBaseIds);
  const wanted = normalizeText(baseRef);
  const base =
    bases.find((b) => b.id === baseRef) ??
    bases.find((b) => normalizeText(b.name) === wanted) ??
    bases.find((b) => normalizeText(b.name).includes(wanted));
  if (!base) {
    const known = bases.map((b) => `"${b.name}"`).join(', ');
    throw new Error(`Base "${baseRef}" não encontrada. Bases disponíveis: ${known || '(nenhuma)'}`);
  }
  const docs = listDocs(base.id);
  const doc =
    docs.find((d) => d.name === docName) ??
    docs.find((d) => normalizeText(d.name) === normalizeText(docName));
  if (!doc) {
    const known = docs.map((d) => d.name).join(', ');
    throw new Error(`Documento "${docName}" não existe na base "${base.name}". Documentos: ${known || '(nenhum)'}`);
  }
  const content = readDoc(base.id, doc.name) ?? '';
  const start = Math.max(0, Math.floor(offset));
  if (start >= content.length && content.length > 0) {
    throw new Error(`Offset ${start} além do fim do documento (${content.length} caracteres)`);
  }
  const chunk = content.slice(start, start + READ_TOOL_CAP);
  const remaining = content.length - (start + chunk.length);
  const header = `# ${base.name} — ${doc.name} (caracteres ${start}–${start + chunk.length} de ${content.length})\n\n`;
  const footer =
    remaining > 0
      ? `\n\n… (continua — chame de novo com offset=${start + chunk.length} para os ${remaining} caracteres restantes)`
      : '';
  return `${header}${chunk}${footer}`;
}

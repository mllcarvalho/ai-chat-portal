import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KnowledgeBase, KnowledgeDoc } from '@aiportal/shared';
import { slugifyCommand } from '@aiportal/shared';
import { readJson, writeJsonAtomic } from './jsonStore';
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

const DOC_EXTENSIONS = ['.md', '.txt'];
const DOC_LIMIT = 512 * 1024;
const SOURCES_FILE = 'sources.json';

type BaseMeta = Omit<KnowledgeBase, 'docCount'>;

/** Fonte remota de um documento sincronizado (sources.json, indexado pelo nome do doc). */
export interface DocSource {
  url: string;
  syncedAt?: string;
  error?: string;
}

function readSources(dir: string): Record<string, DocSource> {
  return readJson<Record<string, DocSource>>(path.join(dir, SOURCES_FILE)) ?? {};
}

function writeSources(dir: string, sources: Record<string, DocSource>): void {
  writeJsonAtomic(path.join(dir, SOURCES_FILE), sources);
}

function baseDirFor(scope: 'global' | 'project', projectId?: string): string | undefined {
  if (scope === 'global') return knowledgeDir();
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
    if (!file.isFile() || !DOC_EXTENSIONS.includes(path.extname(file.name).toLowerCase())) continue;
    const stat = fs.statSync(path.join(dir, file.name));
    const source = sources[file.name];
    docs.push({
      name: file.name,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      sourceUrl: source?.url,
      syncedAt: source?.syncedAt,
      syncError: source?.error,
    });
  }
  return docs.sort((a, b) => a.name.localeCompare(b.name));
}

/** Bases globais + (se informado) as do projeto. */
export function listBases(projectId?: string): KnowledgeBase[] {
  const bases = readBasesIn(knowledgeDir());
  if (projectId) {
    const dir = baseDirFor('project', projectId);
    if (dir) bases.push(...readBasesIn(dir));
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
  return undefined;
}

export function getBase(id: string): KnowledgeBase | undefined {
  const dir = findBaseDir(id);
  if (!dir) return undefined;
  const meta = readJson<BaseMeta>(path.join(dir, 'base.json'));
  if (!meta) return undefined;
  return { ...meta, docCount: listDocsIn(dir).length };
}

export function createBase(input: {
  name: string;
  description?: string;
  scope: 'global' | 'project';
  projectId?: string;
  enabled?: boolean;
  importedFrom?: string;
}): KnowledgeBase | undefined {
  const parent = baseDirFor(input.scope, input.projectId);
  if (!parent) return undefined;
  const now = new Date().toISOString();
  const meta: BaseMeta = {
    id: crypto.randomUUID(),
    name: input.name,
    description: input.description,
    scope: input.scope,
    projectId: input.scope === 'project' ? input.projectId : undefined,
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
  patch: Partial<Pick<KnowledgeBase, 'name' | 'description' | 'enabled'>>,
): KnowledgeBase | undefined {
  const dir = findBaseDir(id);
  if (!dir) return undefined;
  const meta = readJson<BaseMeta>(path.join(dir, 'base.json'));
  if (!meta) return undefined;
  const updated: BaseMeta = { ...meta, ...patch, updatedAt: new Date().toISOString() };
  writeJsonAtomic(path.join(dir, 'base.json'), updated);
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
  if (base !== name || !DOC_EXTENSIONS.includes(path.extname(base).toLowerCase())) {
    throw new Error('Documento deve ser um arquivo .md ou .txt sem subpastas');
  }
  return base;
}

export function listDocs(baseId: string): KnowledgeDoc[] {
  const dir = findBaseDir(baseId);
  return dir ? listDocsIn(dir) : [];
}

export function readDoc(baseId: string, name: string): string | undefined {
  const dir = findBaseDir(baseId);
  if (!dir) return undefined;
  try {
    return fs.readFileSync(path.join(dir, safeDocName(name)), 'utf8');
  } catch {
    return undefined;
  }
}

export function writeDoc(baseId: string, name: string, content: string): KnowledgeDoc {
  const dir = findBaseDir(baseId);
  if (!dir) throw new Error('Base de conhecimento não encontrada');
  if (Buffer.byteLength(content) > DOC_LIMIT) {
    throw new Error(`Documento excede o limite de ${DOC_LIMIT / 1024} KB`);
  }
  const file = path.join(dir, safeDocName(name));
  fs.writeFileSync(file, content, 'utf8');
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
  return { ...doc, sourceUrl: source?.url, syncedAt: source?.syncedAt, syncError: source?.error };
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
}

/** Entrada do índice injetado no lugar do conteúdo quando as bases não cabem. */
export interface KnowledgeIndexEntry {
  baseName: string;
  docName: string;
  size: number;
  headings: string[];
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
      snippets.push({ baseName: base.name, docName: doc.name, content });
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
    for (const doc of listDocs(base.id)) {
      index.push({
        baseName: base.name,
        docName: doc.name,
        size: doc.size,
        headings: docHeadings(readDoc(base.id, doc.name) ?? ''),
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

function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function queryTerms(query: string): string[] {
  return [...new Set(normalizeText(query).split(/[^a-z0-9]+/).filter((t) => t.length >= 3))];
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

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) {
    count++;
  }
  return count;
}

export interface KnowledgeHit {
  baseName: string;
  docName: string;
  heading: string;
  snippet: string;
}

/**
 * Busca por palavras-chave nas bases habilitadas da conversa. Ranqueia seções
 * priorizando quantos termos distintos casam (e presença no título) sobre
 * repetição do mesmo termo.
 */
export function searchKnowledge(
  query: string,
  projectId?: string | null,
  extraBaseIds?: string[],
  baseFilter?: string,
): KnowledgeHit[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const wanted = baseFilter ? normalizeText(baseFilter) : undefined;
  const scored: Array<KnowledgeHit & { score: number }> = [];
  for (const base of enabledBases(projectId, extraBaseIds)) {
    if (wanted && !normalizeText(base.name).includes(wanted)) continue;
    for (const doc of listDocs(base.id)) {
      const content = readDoc(base.id, doc.name);
      if (!content) continue;
      for (const section of splitSections(content)) {
        const body = normalizeText(section.content);
        const head = normalizeText(`${doc.name} ${section.heading}`);
        let matched = 0;
        let score = 0;
        for (const term of terms) {
          const inBody = countOccurrences(body, term);
          const inHead = countOccurrences(head, term);
          if (!inBody && !inHead) continue;
          matched++;
          score += Math.min(inBody, 5) + inHead * 4;
        }
        if (!matched) continue;
        score += matched * 20;
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

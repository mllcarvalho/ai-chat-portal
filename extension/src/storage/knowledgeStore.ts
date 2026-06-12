import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KnowledgeBase, KnowledgeDoc } from '@aiportal/shared';
import { readJson, writeJsonAtomic } from './jsonStore';
import { PROJECT_META_DIR, ensureDir, knowledgeDir } from './paths';
import { getProject, listProjects, projectDir } from './projectStore';
import { docNameForUrl, fetchRemoteContent, normalizeSourceUrl } from './remoteFetch';

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

/**
 * Cria um documento sincronizado de uma URL remota (GitHub Pages, markdown bruto…):
 * baixa o conteúdo, converte HTML para markdown e registra a fonte para re-sync.
 */
export async function addRemoteDoc(baseId: string, rawUrl: string, name?: string): Promise<KnowledgeDoc> {
  const dir = findBaseDir(baseId);
  if (!dir) throw new Error('Base de conhecimento não encontrada');
  const url = normalizeSourceUrl(rawUrl);
  let docName = name?.trim() || docNameForUrl(url);
  if (!/\.(md|txt)$/i.test(docName)) docName = `${docName}.md`;
  docName = safeDocName(docName);
  const content = await fetchRemoteContent(url);
  const doc = writeDoc(baseId, docName, content);
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
      const content = await fetchRemoteContent(source.url);
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

export interface KnowledgeSnippet {
  baseName: string;
  docName: string;
  content: string;
}

const PER_DOC_CAP = 16_000;
const TOTAL_CAP = 48_000;

/**
 * Conteúdo das bases habilitadas (globais + do projeto da sessão) para injetar
 * no contexto, com teto por documento e total. extraBaseIds (bases vinculadas
 * ao agente da sessão) entram mesmo desativadas no toggle geral.
 */
export function collectKnowledge(
  projectId?: string | null,
  extraBaseIds?: string[],
): KnowledgeSnippet[] {
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
  const snippets: KnowledgeSnippet[] = [];
  let total = 0;
  for (const base of bases) {
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

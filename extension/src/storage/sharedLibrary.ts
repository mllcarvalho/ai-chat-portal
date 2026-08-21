import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SharedLibrary, SharedLibraryStatus } from '@aiportal/shared';
import { getConfig, patchConfig } from './configStore';
import { readJson, writeJsonAtomic } from './jsonStore';
import { dataRoot } from './paths';

/**
 * Bibliotecas compartilhadas: pastas (normalmente de rede — \\servidor\equipe\…,
 * ou um OneDrive/Drive sincronizado) de onde o portal lê skills, agentes e
 * bases de conhecimento ALÉM dos itens locais. É como as áreas já compartilham
 * arquivo no banco: uma pessoa altera na pasta e todo mundo passa a ver.
 *
 * Layout dentro da pasta — o mesmo formato dos dados locais, para copiar e
 * colar continuar funcionando:
 *   <lib>/skills/<slug>/{skill.json, SKILL.md, anexos…}
 *   <lib>/knowledge/<id>/{base.json, documentos…}
 *   <lib>/agents/<id>.json
 *
 * Pasta de rede é lenta e cai: toda leitura passa por um cache curto e por
 * um teste de disponibilidade, e uma biblioteca fora do ar nunca trava a UI —
 * some das listagens e volta sozinha quando a rede voltar.
 */

export const SHARED_SKILLS_DIR = 'skills';
export const SHARED_KNOWLEDGE_DIR = 'knowledge';
export const SHARED_AGENTS_DIR = 'agents';

/** Quanto tempo um resultado de disponibilidade vale (evita bater no SMB a cada request). */
const AVAILABILITY_TTL_MS = 15_000;

interface Availability {
  ok: boolean;
  error?: string;
  checkedAt: number;
}

const availability = new Map<string, Availability>();

export function listLibraries(): SharedLibrary[] {
  return getConfig().sharedLibraries ?? [];
}

export function getLibrary(id: string): SharedLibrary | undefined {
  return listLibraries().find((lib) => lib.id === id);
}

/** Salva a lista inteira (a UI edita o conjunto). Ids ausentes são gerados. */
export function saveLibraries(input: Array<Partial<SharedLibrary>>): SharedLibrary[] {
  const libraries: SharedLibrary[] = [];
  for (const item of input) {
    const libPath = item.path?.trim();
    if (!libPath) continue;
    libraries.push({
      id: item.id?.trim() || crypto.randomUUID(),
      name: item.name?.trim() || path.basename(libPath.replace(/[/\\]+$/, '')) || 'Biblioteca',
      path: libPath,
    });
  }
  patchConfig({ sharedLibraries: libraries });
  availability.clear();
  return libraries;
}

/**
 * A pasta responde agora? O resultado vale por alguns segundos: numa pasta de
 * rede desconectada cada readdirSync pode levar segundos até dar erro, e as
 * listagens do portal consultam as bibliotecas o tempo todo.
 */
export function isAvailable(lib: SharedLibrary): boolean {
  const cached = availability.get(lib.id);
  const now = Date.now();
  if (cached && now - cached.checkedAt < AVAILABILITY_TTL_MS) return cached.ok;
  let ok = false;
  let error: string | undefined;
  try {
    ok = fs.statSync(lib.path).isDirectory();
    if (!ok) error = 'O caminho não é uma pasta';
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  availability.set(lib.id, { ok, error, checkedAt: now });
  return ok;
}

/** Bibliotecas que respondem agora — é sobre estas que as listagens iteram. */
export function availableLibraries(): SharedLibrary[] {
  return listLibraries().filter(isAvailable);
}

/** Caminho de uma subpasta da biblioteca (criando-a quando `create`). */
export function libraryDir(
  lib: SharedLibrary,
  kind: typeof SHARED_SKILLS_DIR | typeof SHARED_KNOWLEDGE_DIR | typeof SHARED_AGENTS_DIR,
  create = false,
): string {
  const dir = path.join(lib.path, kind);
  if (create) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Subpastas de todas as bibliotecas disponíveis, com a biblioteca de origem. */
export function libraryDirs(
  kind: typeof SHARED_SKILLS_DIR | typeof SHARED_KNOWLEDGE_DIR | typeof SHARED_AGENTS_DIR,
): Array<{ lib: SharedLibrary; dir: string }> {
  return availableLibraries().map((lib) => ({ lib, dir: libraryDir(lib, kind) }));
}

/** Diagnóstico para a tela de Configurações: existe, dá para gravar, o que tem dentro. */
export function libraryStatus(lib: SharedLibrary): SharedLibraryStatus {
  const cached = availability.get(lib.id);
  if (!isAvailable(lib)) {
    return {
      ...lib,
      available: false,
      writable: false,
      error: availability.get(lib.id)?.error ?? cached?.error ?? 'Pasta indisponível',
    };
  }
  let writable = false;
  try {
    fs.accessSync(lib.path, fs.constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  return {
    ...lib,
    available: true,
    writable,
    counts: {
      skills: countEntries(libraryDir(lib, SHARED_SKILLS_DIR)),
      agents: countEntries(libraryDir(lib, SHARED_AGENTS_DIR)),
      knowledgeBases: countEntries(libraryDir(lib, SHARED_KNOWLEDGE_DIR)),
    },
  };
}

function countEntries(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((name) => !name.startsWith('.')).length;
  } catch {
    return 0;
  }
}

/* ---------- detecção de alteração feita por outra pessoa ---------- */

/**
 * Impressão digital das pastas compartilhadas, por tipo. A UI compara o valor
 * entre um poll e outro: mudou, recarrega a lista sozinha.
 *
 * Por que POLLING e não fs.watch: biblioteca compartilhada é pasta de REDE. O
 * FSEvents do macOS não enxerga montagem SMB, e o ReadDirectoryChangesW do
 * Windows em caminho UNC é notoriamente instável (perde evento, morre quando a
 * sessão SMB reconecta). Um hash de mtime+tamanho é chato, mas nunca mente.
 */
export interface SharedRevision {
  skills: string;
  agents: string;
  knowledge: string;
  /** Última varredura concluída (ISO). Ausente = ainda não rodou nenhuma. */
  checkedAt?: string;
  /** Bibliotecas que estavam fora do ar na varredura (a UI avisa sem alarmar). */
  offline: string[];
}

/** Quanto tempo uma varredura vale antes de disparar a próxima. */
const REVISION_TTL_MS = 12_000;
/** Teto de entradas por varredura: pasta de rede grande não pode travar nada. */
const REVISION_MAX_ENTRIES = 4_000;
const REVISION_MAX_DEPTH = 3;

const EMPTY_REVISION: SharedRevision = { skills: '', agents: '', knowledge: '', offline: [] };

let revisionCache: SharedRevision = EMPTY_REVISION;
let revisionAt = 0;
let revisionScanning = false;

/**
 * Hash de nome+mtime+tamanho da árvore. Profundidade e número de entradas são
 * limitados: o layout real é raso (skills/<slug>/SKILL.md, knowledge/<id>/doc)
 * e um teto evita que alguém apontando a raiz de um servidor derrube a
 * varredura.
 */
function fingerprint(dir: string, hash: crypto.Hash, budget: { left: number }, depth = 0): void {
  if (depth > REVISION_MAX_DEPTH || budget.left <= 0) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // pasta some ou nega acesso: entra no hash como "vazia" e a vida segue
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (budget.left <= 0) return;
    if (entry.name.startsWith('.')) continue;
    budget.left -= 1;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      hash.update(`d:${entry.name}\n`);
      fingerprint(full, hash, budget, depth + 1);
      continue;
    }
    try {
      const stat = fs.statSync(full);
      hash.update(`f:${entry.name}:${stat.mtimeMs}:${stat.size}\n`);
    } catch {
      hash.update(`f:${entry.name}:?\n`);
    }
  }
}

function fingerprintKind(
  kind: typeof SHARED_SKILLS_DIR | typeof SHARED_KNOWLEDGE_DIR | typeof SHARED_AGENTS_DIR,
): string {
  const hash = crypto.createHash('sha1');
  const budget = { left: REVISION_MAX_ENTRIES };
  for (const { lib, dir } of libraryDirs(kind)) {
    hash.update(`lib:${lib.id}\n`);
    fingerprint(dir, hash, budget);
  }
  return hash.digest('hex').slice(0, 16);
}

function scanRevision(): void {
  if (revisionScanning) return;
  revisionScanning = true;
  // fora da thread do request: uma pasta de rede lenta não pode segurar a API
  setImmediate(() => {
    try {
      const offline = listLibraries()
        .filter((lib) => !isAvailable(lib))
        .map((lib) => lib.name);
      revisionCache = {
        skills: fingerprintKind(SHARED_SKILLS_DIR),
        agents: fingerprintKind(SHARED_AGENTS_DIR),
        knowledge: fingerprintKind(SHARED_KNOWLEDGE_DIR),
        checkedAt: new Date().toISOString(),
        offline,
      };
      revisionAt = Date.now();
    } catch {
      revisionAt = Date.now(); // erro não vira varredura em loop
    } finally {
      revisionScanning = false;
    }
  });
}

/**
 * Revisão atual (do cache) e, se estiver velha, agenda a próxima varredura.
 * É movida por DEMANDA e não por timer: portal aberto sem ninguém olhando as
 * telas de gestão não fica batendo na rede à toa.
 */
export function sharedRevision(): SharedRevision {
  if (!listLibraries().length) return { ...EMPTY_REVISION, checkedAt: new Date().toISOString() };
  if (Date.now() - revisionAt > REVISION_TTL_MS) scanRevision();
  return revisionCache;
}

/**
 * Preferências LOCAIS sobre itens compartilhados. O toggle "usar no contexto"
 * de uma base compartilhada é de cada pessoa: gravá-lo no base.json da pasta
 * de rede desligaria a base para a equipe inteira sem ninguém entender por quê.
 */
interface SharedPrefs {
  /** baseId → enabled local (ausente = o padrão que veio da biblioteca). */
  knowledgeEnabled?: Record<string, boolean>;
}

function prefsPath(): string {
  return path.join(dataRoot(), 'shared-prefs.json');
}

function readPrefs(): SharedPrefs {
  return readJson<SharedPrefs>(prefsPath()) ?? {};
}

export function sharedBaseEnabled(baseId: string, fallback: boolean): boolean {
  return readPrefs().knowledgeEnabled?.[baseId] ?? fallback;
}

export function setSharedBaseEnabled(baseId: string, enabled: boolean): void {
  const prefs = readPrefs();
  writeJsonAtomic(prefsPath(), {
    ...prefs,
    knowledgeEnabled: { ...prefs.knowledgeEnabled, [baseId]: enabled },
  });
}

/** Erro padrão quando a pessoa tenta gravar numa biblioteca fora do ar. */
export function requireLibrary(id: string): SharedLibrary {
  const lib = getLibrary(id);
  if (!lib) throw new Error('Biblioteca compartilhada não encontrada nas configurações');
  if (!isAvailable(lib)) {
    throw new Error(
      `A biblioteca "${lib.name}" não está acessível agora (${lib.path}). ` +
        'Confira a conexão com a rede e tente de novo.',
    );
  }
  return lib;
}

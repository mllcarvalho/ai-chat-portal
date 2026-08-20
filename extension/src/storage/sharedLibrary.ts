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

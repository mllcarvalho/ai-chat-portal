import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJson, writeJsonAtomic } from './jsonStore';
import { PROJECT_META_DIR, ensureDir } from './paths';

/**
 * Pastas referenciadas de uma pasta de trabalho: um symlink (junction no
 * Windows) na raiz aponta para uma pasta em qualquer lugar da máquina, e o
 * registro em .aiportal/links.json autoriza o alvo no resolveInProject. Os
 * arquivos continuam no local original — ler/escrever pelo link chega neles.
 */
export interface FolderLink {
  /** Nome do symlink na raiz da pasta de trabalho (como aparece na árvore). */
  name: string;
  /** Caminho absoluto (realpath) da pasta original. */
  target: string;
}

function linksPath(workRoot: string): string {
  return path.join(workRoot, PROJECT_META_DIR, 'links.json');
}

export function listLinks(workRoot: string): FolderLink[] {
  return readJson<FolderLink[]>(linksPath(workRoot)) ?? [];
}

/** Alvos autorizados (realpath) — usado pelo guard de caminhos. */
export function linkedRealTargets(workRoot: string): string[] {
  const targets: string[] = [];
  for (const link of listLinks(workRoot)) {
    try {
      targets.push(fs.realpathSync(link.target));
    } catch {
      // alvo removido/inacessível — deixa de ser autorizado
    }
  }
  return targets;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Referencia uma pasta externa: cria o symlink na raiz da pasta de trabalho e
 * registra o alvo. O nome vem do basename do alvo (com sufixo numérico em
 * colisão). Lança erro legível para alvo inválido ou já referenciado.
 */
export function addLink(workRoot: string, target: string): FolderLink {
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch {
    throw new Error(`Pasta não encontrada: ${target}`);
  }
  if (!fs.statSync(real).isDirectory()) {
    throw new Error('O caminho escolhido não é uma pasta');
  }
  ensureDir(workRoot);
  const realRoot = fs.realpathSync(workRoot);
  if (isInside(real, realRoot) || isInside(realRoot, real)) {
    throw new Error('Escolha uma pasta fora da pasta de trabalho do portal');
  }
  // remove do registro entradas cujo symlink sumiu do disco (limpeza)
  const links = listLinks(workRoot).filter((l) => {
    try {
      return fs.lstatSync(path.join(workRoot, l.name)).isSymbolicLink();
    } catch {
      return false;
    }
  });
  const existing = links.find((l) => l.target === real);
  if (existing) {
    throw new Error(`Esta pasta já está referenciada como "${existing.name}"`);
  }
  const base = path.basename(real) || 'pasta';
  let name = base;
  let i = 2;
  while (fs.existsSync(path.join(workRoot, name)) || links.some((l) => l.name === name)) {
    name = `${base}-${i++}`;
  }
  // junction no Windows dispensa privilégio de admin (só vale para pastas)
  fs.symlinkSync(real, path.join(workRoot, name), process.platform === 'win32' ? 'junction' : 'dir');
  const link: FolderLink = { name, target: real };
  writeJsonAtomic(linksPath(workRoot), [...links, link]);
  return link;
}

/** Tira uma entrada do registro (o symlink em si é removido pelo chamador). */
export function removeLinkEntry(workRoot: string, name: string): void {
  const links = listLinks(workRoot);
  const next = links.filter((l) => l.name !== name);
  if (next.length !== links.length) writeJsonAtomic(linksPath(workRoot), next);
}

/** Acompanha um rename de symlink na raiz, mantendo o registro coerente. */
export function renameLinkEntry(workRoot: string, oldName: string, newName: string): void {
  const links = listLinks(workRoot);
  const link = links.find((l) => l.name === oldName);
  if (!link) return;
  writeJsonAtomic(
    linksPath(workRoot),
    links.map((l) => (l === link ? { ...l, name: newName } : l)),
  );
}

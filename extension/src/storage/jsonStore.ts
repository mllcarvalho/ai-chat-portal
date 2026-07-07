import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Leitura tolerante: arquivo ausente retorna undefined; JSON corrompido é
 * renomeado para .bad (preserva evidência) e tratado como ausente.
 */
export function readJson<T>(file: string): T | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    try {
      fs.renameSync(file, `${file}.bad`);
    } catch {
      // se nem renomear der, segue como ausente
    }
    return undefined;
  }
}

/** Escrita atômica (tmp + rename) para nunca corromper dados durante streaming. */
export function writeJsonAtomic(file: string, data: unknown): void {
  writeFileAtomic(file, JSON.stringify(data, null, 2));
}

/** Mesma garantia para conteúdo texto/binário (docs de knowledge, SKILL.md…). */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function deleteFile(file: string): void {
  fs.rmSync(file, { force: true });
}

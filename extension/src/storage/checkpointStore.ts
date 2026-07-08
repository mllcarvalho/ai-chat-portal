import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dataRoot } from './paths';

/**
 * Checkpoints do workspace: antes de cada mutação destrutiva das ferramentas
 * builtin (escrita/edição/exclusão/movimentação), o estado anterior dos alvos
 * é salvo em <dataRoot>/checkpoints/<workspaceKey>/<checkpointId>/ e pode ser
 * restaurado depois pelo botão "Reverter" da UI.
 */

/** Máximo de checkpoints guardados por pasta de trabalho (os mais antigos são removidos). */
const CHECKPOINT_LIMIT = 50;

export type CheckpointOperation = 'write' | 'edit' | 'delete' | 'move';

interface CheckpointEntry {
  /** Caminho relativo à pasta de trabalho. */
  path: string;
  /** Estado ANTES da mutação: absent = não existia (reverter = apagar o atual). */
  kind: 'file' | 'dir' | 'absent';
}

interface CheckpointMeta {
  id: string;
  tool: string;
  operation: CheckpointOperation;
  workRoot: string;
  createdAt: string;
  entries: CheckpointEntry[];
}

function checkpointsRoot(): string {
  return path.join(dataRoot(), 'checkpoints');
}

/** Chave estável e legível da pasta de trabalho: <basename>-<hash do caminho>. */
function workspaceKey(workRoot: string): string {
  const hash = crypto.createHash('sha1').update(workRoot).digest('hex').slice(0, 8);
  const base =
    path
      .basename(workRoot)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .slice(0, 40) || 'ws';
  return `${base}-${hash}`;
}

/** Remove os checkpoints mais antigos além do limite (melhor-esforço). */
function prune(wsDir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(wsDir);
  } catch {
    return;
  }
  if (names.length <= CHECKPOINT_LIMIT) return;
  const dated = names
    .map((name) => {
      let t = 0;
      try {
        t = fs.statSync(path.join(wsDir, name, 'meta.json')).mtimeMs;
      } catch {
        // sem meta.json = checkpoint corrompido; sai primeiro na limpeza
      }
      return { name, t };
    })
    .sort((a, b) => a.t - b.t);
  for (const { name } of dated.slice(0, dated.length - CHECKPOINT_LIMIT)) {
    try {
      fs.rmSync(path.join(wsDir, name), { recursive: true, force: true });
    } catch {
      // limpeza é melhor-esforço
    }
  }
}

/**
 * Salva o estado atual dos alvos antes de uma mutação e devolve o id do
 * checkpoint. Alvos inexistentes entram como "absent" (reverter = apagar);
 * pastas são copiadas recursivamente.
 */
export function createCheckpoint(
  workRoot: string,
  tool: string,
  operation: CheckpointOperation,
  targets: Array<{ absPath: string; relPath: string }>,
): string {
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const wsDir = path.join(checkpointsRoot(), workspaceKey(workRoot));
  const dir = path.join(wsDir, id);
  const entries: CheckpointEntry[] = [];
  for (const target of targets) {
    let kind: CheckpointEntry['kind'] = 'absent';
    if (fs.existsSync(target.absPath)) {
      kind = fs.statSync(target.absPath).isDirectory() ? 'dir' : 'file';
      const snap = path.join(dir, 'files', target.relPath);
      fs.mkdirSync(path.dirname(snap), { recursive: true });
      fs.cpSync(target.absPath, snap, { recursive: true });
    }
    entries.push({ path: target.relPath, kind });
  }
  const meta: CheckpointMeta = {
    id,
    tool,
    operation,
    workRoot,
    createdAt: new Date().toISOString(),
    entries,
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  prune(wsDir);
  return id;
}

/** Localiza a pasta do checkpoint varrendo os workspaces (o id é único). */
function findCheckpointDir(id: string): string | undefined {
  if (!/^[a-z0-9-]+$/.test(id)) return undefined;
  let wsKeys: string[];
  try {
    wsKeys = fs.readdirSync(checkpointsRoot());
  } catch {
    return undefined;
  }
  for (const key of wsKeys) {
    const dir = path.join(checkpointsRoot(), key, id);
    if (fs.existsSync(path.join(dir, 'meta.json'))) return dir;
  }
  return undefined;
}

export interface RevertResult {
  message: string;
  files: string[];
}

/**
 * Restaura o estado salvo no checkpoint: arquivo/pasta volta ao conteúdo
 * anterior; alvo que não existia antes é apagado. Lança erro legível se o
 * checkpoint não existe mais (retenção) ou está corrompido.
 */
export function revertCheckpoint(id: string): RevertResult {
  const dir = findCheckpointDir(id);
  if (!dir) {
    throw new Error('Checkpoint não encontrado — pode ter sido removido pela retenção automática');
  }
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as CheckpointMeta;
  for (const entry of meta.entries) {
    const abs = path.resolve(meta.workRoot, entry.path);
    const rel = path.relative(meta.workRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Checkpoint com caminho fora da pasta de trabalho: ${entry.path}`);
    }
    if (entry.kind === 'absent') {
      fs.rmSync(abs, { recursive: true, force: true });
      continue;
    }
    const snap = path.join(dir, 'files', entry.path);
    if (!fs.existsSync(snap)) {
      throw new Error(`Snapshot ausente para ${entry.path} — não foi possível reverter`);
    }
    fs.rmSync(abs, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.cpSync(snap, abs, { recursive: true });
  }
  const files = meta.entries.map((e) => e.path);
  return {
    message: `Estado anterior restaurado: ${files.join(', ')}`,
    files,
  };
}

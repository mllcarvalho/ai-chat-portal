import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileEntry } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import { resolveInProject, READ_LIMIT, LIST_LIMIT, WRITE_LIMIT } from '../../tools/builtinTools';
import { PROJECT_META_DIR } from '../../storage/paths';

function buildTree(dir: string, base: string, depth: number, count: { n: number }): FileEntry[] {
  if (depth > 8 || count.n >= LIST_LIMIT) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: FileEntry[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === PROJECT_META_DIR || entry.name === 'node_modules') continue;
    if (count.n >= LIST_LIMIT) break;
    count.n++;
    const full = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (entry.isDirectory()) {
      result.push({
        name: entry.name,
        path: rel,
        type: 'dir',
        size: 0,
        mtime: stat.mtime.toISOString(),
        children: buildTree(full, rel, depth + 1, count),
      });
    } else {
      result.push({
        name: entry.name,
        path: rel,
        type: 'file',
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    }
  }
  // pastas primeiro
  return result.sort((a, b) => (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1));
}

/**
 * Rotas de arquivo sobre uma pasta de trabalho resolvida por id — usadas tanto
 * para a pasta do projeto quanto para o workspace de uma conversa avulsa (que
 * pode ainda não existir no disco: GET responde árvore vazia; PUT cria).
 */
export function registerFileRoutes(
  router: Router,
  base: string,
  rootFor: (id: string) => string | undefined,
  ownerNotFound: string,
): void {
  router.get(base, ({ res, params, query }) => {
    const root = rootFor(params.id);
    if (!root) {
      sendError(res, 404, ownerNotFound);
      return;
    }
    if (!fs.existsSync(root)) {
      sendJson(res, 200, []);
      return;
    }
    const rel = query.get('path') || '.';
    let dir: string;
    try {
      dir = resolveInProject(root, rel);
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : 'Caminho inválido');
      return;
    }
    sendJson(res, 200, buildTree(dir, rel === '.' ? '' : rel, 0, { n: 0 }));
  });

  router.put(base, ({ res, params, body }) => {
    const root = rootFor(params.id);
    if (!root) {
      sendError(res, 404, ownerNotFound);
      return;
    }
    const input = (body ?? {}) as { path?: string; content?: string };
    if (!input.path?.trim() || typeof input.content !== 'string') {
      sendError(res, 400, 'path e content são obrigatórios');
      return;
    }
    if (Buffer.byteLength(input.content) > WRITE_LIMIT) {
      sendError(res, 400, `Arquivo excede o limite de ${WRITE_LIMIT / 1024 / 1024} MB`);
      return;
    }
    try {
      fs.mkdirSync(root, { recursive: true });
      const file = resolveInProject(root, input.path.trim());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, input.content, 'utf8');
      sendJson(res, 200, { ok: true, path: input.path.trim() });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : 'Erro ao gravar arquivo');
    }
  });

  router.delete(base, ({ res, params, query }) => {
    const root = rootFor(params.id);
    if (!root) {
      sendError(res, 404, ownerNotFound);
      return;
    }
    const rel = query.get('path');
    if (!rel) {
      sendError(res, 400, 'Parâmetro path é obrigatório');
      return;
    }
    try {
      if (!fs.existsSync(root)) {
        sendError(res, 404, 'Arquivo não encontrado');
        return;
      }
      const file = resolveInProject(root, rel);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        sendError(res, 404, 'Arquivo não encontrado');
        return;
      }
      fs.unlinkSync(file);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : 'Erro ao excluir arquivo');
    }
  });

  router.get(`${base}/download`, ({ res, params, query }) => {
    const root = rootFor(params.id);
    if (!root) {
      sendError(res, 404, ownerNotFound);
      return;
    }
    const rel = query.get('path');
    if (!rel) {
      sendError(res, 400, 'Parâmetro path é obrigatório');
      return;
    }
    try {
      const file = resolveInProject(root, rel);
      const stat = fs.statSync(file);
      if (!stat.isFile()) {
        sendError(res, 400, 'Não é um arquivo');
        return;
      }
      const name = path.basename(file).replace(/"/g, '');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : 'Erro ao ler arquivo');
    }
  });

  router.get(`${base}/content`, ({ res, params, query }) => {
    const root = rootFor(params.id);
    if (!root) {
      sendError(res, 404, ownerNotFound);
      return;
    }
    const rel = query.get('path');
    if (!rel) {
      sendError(res, 400, 'Parâmetro path é obrigatório');
      return;
    }
    try {
      const file = resolveInProject(root, rel);
      const stat = fs.statSync(file);
      if (!stat.isFile()) {
        sendError(res, 400, 'Não é um arquivo');
        return;
      }
      const truncated = stat.size > READ_LIMIT;
      const buf = Buffer.alloc(Math.min(stat.size, READ_LIMIT));
      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, buf, 0, buf.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      sendJson(res, 200, { content: buf.toString('utf8'), truncated });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : 'Erro ao ler arquivo');
    }
  });
}

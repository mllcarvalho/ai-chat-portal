import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileEntry, Project } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import {
  createProject,
  getProject,
  listProjects,
  patchProject,
  projectDir,
  unregisterProject,
} from '../../storage/projectStore';
import { resolveInProject, READ_LIMIT, LIST_LIMIT } from '../../tools/builtinTools';
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

export function registerProjectRoutes(router: Router): void {
  router.get('/api/projects', ({ res }) => {
    sendJson(res, 200, listProjects());
  });

  router.post('/api/projects', ({ res, body }) => {
    const { name } = (body ?? {}) as { name?: string };
    if (!name?.trim()) {
      sendError(res, 400, 'Nome do projeto é obrigatório');
      return;
    }
    sendJson(res, 201, createProject(name.trim()));
  });

  router.patch('/api/projects/:id', ({ res, params, body }) => {
    const patch = (body ?? {}) as Partial<
      Pick<Project, 'name' | 'instructions' | 'defaultAgentId'>
    >;
    const updated = patchProject(params.id, patch);
    if (!updated) {
      sendError(res, 404, 'Projeto não encontrado');
      return;
    }
    sendJson(res, 200, updated);
  });

  router.delete('/api/projects/:id', ({ res, params }) => {
    const ok = unregisterProject(params.id);
    sendJson(res, ok ? 200 : 404, { ok, note: 'A pasta do projeto permanece no disco' });
  });

  router.get('/api/projects/:id/files', ({ res, params, query }) => {
    const project = getProject(params.id);
    if (!project) {
      sendError(res, 404, 'Projeto não encontrado');
      return;
    }
    const rel = query.get('path') || '.';
    let dir: string;
    try {
      dir = resolveInProject(projectDir(project), rel);
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : 'Caminho inválido');
      return;
    }
    sendJson(res, 200, buildTree(dir, rel === '.' ? '' : rel, 0, { n: 0 }));
  });

  router.get('/api/projects/:id/files/content', ({ res, params, query }) => {
    const project = getProject(params.id);
    if (!project) {
      sendError(res, 404, 'Projeto não encontrado');
      return;
    }
    const rel = query.get('path');
    if (!rel) {
      sendError(res, 400, 'Parâmetro path é obrigatório');
      return;
    }
    try {
      const file = resolveInProject(projectDir(project), rel);
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

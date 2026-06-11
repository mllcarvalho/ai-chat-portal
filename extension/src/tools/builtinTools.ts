import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECT_META_DIR } from '../storage/paths';

export const READ_LIMIT = 256 * 1024;
export const WRITE_LIMIT = 2 * 1024 * 1024;
export const LIST_LIMIT = 500;

export interface BuiltinToolDef {
  name: string;
  description: string;
  inputSchema: object;
}

export const BUILTIN_TOOLS: BuiltinToolDef[] = [
  {
    name: 'portal_write_file',
    description:
      'Cria ou sobrescreve um arquivo de texto dentro da pasta do projeto atual. Use caminhos relativos à raiz do projeto.',
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: {
          type: 'string',
          description: 'Caminho relativo à raiz do projeto, ex: docs/resumo.md',
        },
        content: { type: 'string', description: 'Conteúdo completo do arquivo' },
        overwrite: {
          type: 'boolean',
          description: 'Se false, falha caso o arquivo já exista (default true)',
        },
      },
    },
  },
  {
    name: 'portal_read_file',
    description: 'Lê um arquivo de texto da pasta do projeto atual.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Caminho relativo à raiz do projeto' },
      },
    },
  },
  {
    name: 'portal_list_files',
    description: 'Lista os arquivos e pastas do projeto atual.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Subpasta a listar (default: raiz do projeto)' },
        recursive: { type: 'boolean', description: 'Listar recursivamente (default false)' },
      },
    },
  },
];

export const BUILTIN_TOOL_NAMES = BUILTIN_TOOLS.map((t) => t.name);
export const READONLY_BUILTIN_TOOL_NAMES = ['portal_read_file', 'portal_list_files'];

export function isBuiltinTool(name: string): boolean {
  return BUILTIN_TOOL_NAMES.includes(name);
}

/**
 * Resolve um caminho relativo dentro do projeto, rejeitando qualquer escape:
 * caminhos absolutos, "..", symlinks que saem da raiz e a pasta de metadados.
 */
export function resolveInProject(projectRoot: string, relPath: string): string {
  const resolved = path.resolve(projectRoot, relPath);
  const rel = path.relative(projectRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Caminho fora da pasta do projeto: ${relPath}`);
  }
  if (rel === PROJECT_META_DIR || rel.startsWith(PROJECT_META_DIR + path.sep)) {
    throw new Error(`A pasta ${PROJECT_META_DIR} é reservada ao portal`);
  }
  // valida via realpath o ancestral existente mais profundo (protege contra symlinks)
  let ancestor = resolved;
  while (!fs.existsSync(ancestor)) {
    ancestor = path.dirname(ancestor);
  }
  const realRoot = fs.realpathSync(projectRoot);
  const realAncestor = fs.realpathSync(ancestor);
  const relReal = path.relative(realRoot, realAncestor);
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
    throw new Error(`Caminho fora da pasta do projeto: ${relPath}`);
  }
  return resolved;
}

interface ToolOutcome {
  ok: boolean;
  content: string;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Campo "${field}" é obrigatório`);
  return value;
}

function listEntries(
  dir: string,
  base: string,
  recursive: boolean,
  acc: string[],
): void {
  if (acc.length >= LIST_LIMIT) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (acc.length >= LIST_LIMIT) {
      acc.push(`… (limite de ${LIST_LIMIT} entradas atingido)`);
      return;
    }
    if (entry.name === PROJECT_META_DIR || entry.name === 'node_modules') continue;
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) {
      acc.push(`${rel}/`);
      if (recursive) listEntries(path.join(dir, entry.name), rel, true, acc);
    } else {
      const size = fs.statSync(path.join(dir, entry.name)).size;
      acc.push(`${rel} (${size} bytes)`);
    }
  }
}

export function dispatchBuiltinTool(
  name: string,
  input: unknown,
  projectRoot: string,
): ToolOutcome {
  const args = (input ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case 'portal_write_file': {
        const rel = asString(args.path, 'path');
        const content = typeof args.content === 'string' ? args.content : '';
        if (Buffer.byteLength(content) > WRITE_LIMIT) {
          throw new Error(`Conteúdo excede o limite de ${WRITE_LIMIT / 1024 / 1024} MB`);
        }
        const file = resolveInProject(projectRoot, rel);
        if (args.overwrite === false && fs.existsSync(file)) {
          throw new Error(`Arquivo já existe: ${rel}`);
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, 'utf8');
        return { ok: true, content: `Arquivo salvo: ${rel} (${Buffer.byteLength(content)} bytes)` };
      }
      case 'portal_read_file': {
        const rel = asString(args.path, 'path');
        const file = resolveInProject(projectRoot, rel);
        const stat = fs.statSync(file);
        if (!stat.isFile()) throw new Error(`Não é um arquivo: ${rel}`);
        const fd = fs.openSync(file, 'r');
        try {
          const size = Math.min(stat.size, READ_LIMIT);
          const buf = Buffer.alloc(size);
          fs.readSync(fd, buf, 0, size, 0);
          let content = buf.toString('utf8');
          if (stat.size > READ_LIMIT) {
            content += `\n… (arquivo truncado em ${READ_LIMIT / 1024} KB)`;
          }
          return { ok: true, content };
        } finally {
          fs.closeSync(fd);
        }
      }
      case 'portal_list_files': {
        const rel = typeof args.path === 'string' && args.path ? args.path : '.';
        const dir = resolveInProject(projectRoot, rel);
        const acc: string[] = [];
        listEntries(dir, rel === '.' ? '' : rel, args.recursive === true, acc);
        return { ok: true, content: acc.length ? acc.join('\n') : '(pasta vazia)' };
      }
      default:
        return { ok: false, content: `Ferramenta desconhecida: ${name}` };
    }
  } catch (err) {
    return { ok: false, content: err instanceof Error ? err.message : String(err) };
  }
}

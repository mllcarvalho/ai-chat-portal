import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionMode } from '@aiportal/shared';
import { PROJECT_META_DIR, bmadRootDir } from '../storage/paths';
import { createAgent } from '../storage/agentStore';
import { createBase, listBases, writeDoc } from '../storage/knowledgeStore';
import { createSkill, getSkill, listSkills } from '../storage/skillStore';

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
      'Cria ou sobrescreve um arquivo de texto na pasta de trabalho da conversa ' +
      '(a pasta do projeto, ou o workspace próprio da conversa quando ela não está em um projeto). ' +
      'Use caminhos relativos à raiz da pasta de trabalho.',
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: {
          type: 'string',
          description: 'Caminho relativo à pasta de trabalho, ex: docs/resumo.md',
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
    description: 'Lê um arquivo de texto da pasta de trabalho da conversa.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Caminho relativo à pasta de trabalho' },
      },
    },
  },
  {
    name: 'portal_list_files',
    description: 'Lista os arquivos e pastas da pasta de trabalho da conversa.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Subpasta a listar (default: raiz da pasta de trabalho)' },
        recursive: { type: 'boolean', description: 'Listar recursivamente (default false)' },
      },
    },
  },
  {
    name: 'portal_run_command',
    description:
      'Executa um comando de shell (sintaxe bash/POSIX) na pasta de trabalho da conversa. ' +
      'O usuário aprova cada comando na interface antes de ele rodar. Não-interativo: nada de ' +
      'comandos que esperam input. A saída (stdout+stderr) volta truncada quando longa. ' +
      'Se o comando falhar ou for negado, não repita: siga pela alternativa manual quando existir.',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Comando a executar, ex: python3 scripts/gerar.py' },
        timeoutSeconds: {
          type: 'number',
          description: 'Tempo máximo de execução em segundos (default 60, máximo 600)',
        },
      },
    },
  },
  {
    name: 'bmad_read_file',
    description:
      'Lê um arquivo da instalação global do BMAD (workflows, templates, configs — compartilhada por todos os projetos). ' +
      'Caminhos relativos à raiz do BMAD, ex: _bmad/bmm/… ou .agents/skills/bmad-create-prd/SKILL.md. ' +
      'Somente leitura: documentos gerados devem ser gravados com portal_write_file em _bmad-output/ do projeto.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Caminho relativo à raiz da instalação BMAD' },
      },
    },
  },
  {
    name: 'bmad_list_files',
    description:
      'Lista arquivos e pastas da instalação global do BMAD (ex: _bmad/, .agents/skills/).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Subpasta a listar (default: raiz do BMAD)' },
        recursive: { type: 'boolean', description: 'Listar recursivamente (default false)' },
      },
    },
  },
  {
    name: 'portal_load_skill',
    description:
      'Carrega o conteúdo completo de uma skill do catálogo listado nas instruções da conversa. ' +
      'Use ANTES de responder sempre que o pedido do usuário corresponder à descrição de uma skill ' +
      'do catálogo — e então siga as instruções carregadas. ' +
      'Se a skill usar o marcador {{input}}, passe o pedido do usuário no campo input.',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: {
          type: 'string',
          description: 'Comando da skill como aparece no catálogo (sem a barra), ex: bmad-bmm-prd',
        },
        input: {
          type: 'string',
          description: 'Pedido do usuário, para skills que usam marcador de input (opcional)',
        },
      },
    },
  },
  {
    name: 'portal_save_knowledge',
    description:
      'Salva um documento em uma base de conhecimento do portal, criando a base pelo nome se ela não existir. ' +
      'As bases aparecem na página Conhecimento e, quando habilitadas, seus documentos são injetados no contexto dos chats. ' +
      'Use quando o usuário pedir para criar/alimentar uma base de conhecimento ou registrar fatos, decisões e ' +
      'referências que devem persistir entre conversas.',
    inputSchema: {
      type: 'object',
      required: ['base', 'content'],
      properties: {
        base: {
          type: 'string',
          description: 'Nome da base de conhecimento, ex: "Padrões do time"',
        },
        scope: {
          type: 'string',
          enum: ['global', 'project'],
          description:
            'Onde criar a base caso não exista: global (default) = vale para todos os chats; ' +
            'project = só nas conversas deste projeto',
        },
        description: {
          type: 'string',
          description: 'Descrição da base (usada apenas quando a base é criada agora)',
        },
        doc: {
          type: 'string',
          description:
            'Nome do arquivo do documento (.md ou .txt). Se omitido, é derivado do nome da base',
        },
        content: { type: 'string', description: 'Conteúdo do documento (markdown)' },
      },
    },
  },
  {
    name: 'portal_create_skill',
    description:
      'Registra uma skill no AI Product BMAD Chat (aparece no menu Skills e na página Skills). ' +
      'Toda skill funciona das duas formas: injetada no contexto quando ativada E invocável por /comando no chat. ' +
      'Skills são SEMPRE markdown — nunca crie skills como arquivos soltos (.py, .md) com portal_write_file. ' +
      'Boas skills: nome curto e claro; description diz O QUE faz e QUANDO usar (é ela que guia a escolha); ' +
      'conteúdo enxuto, explicando o porquê das regras em vez de listar ordens rígidas.',
    inputSchema: {
      type: 'object',
      required: ['name', 'description', 'content'],
      properties: {
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description: 'project (default) = só neste projeto; global = todos os chats',
        },
        name: { type: 'string', description: 'Nome curto da skill, ex: "Tom executivo"' },
        description: {
          type: 'string',
          description: 'O que a skill faz e quando deve ser usada (1–2 frases)',
        },
        command: {
          type: 'string',
          description:
            'Nome do comando slash sem a barra, ex: "resumir". Se omitido, é derivado do nome.',
        },
        content: {
          type: 'string',
          description:
            'Conteúdo markdown. Use {{input}} onde entra o texto digitado após o /comando (opcional)',
        },
      },
    },
  },
  {
    name: 'portal_create_agent',
    description:
      'Cria um agente (persona reutilizável) no AI Product BMAD Chat — aparece no seletor de agente do chat ' +
      'e na página Agents. Agentes são globais: as instruções deles entram no contexto de qualquer ' +
      'conversa em que o usuário os selecionar. Use quando o usuário pedir um agente/persona ' +
      'especializado (ex: "agente revisor de contratos"). Boas instruções definem papel, tom, ' +
      'o que fazer e o que NUNCA fazer.',
    inputSchema: {
      type: 'object',
      required: ['name', 'instructions'],
      properties: {
        name: { type: 'string', description: 'Nome curto do agente, ex: "Revisor de contratos"' },
        description: {
          type: 'string',
          description: 'O que o agente faz, em 1 frase (aparece no seletor)',
        },
        icon: { type: 'string', description: 'Um emoji para a UI, ex: "⚖️" (opcional)' },
        instructions: {
          type: 'string',
          description: 'Instruções de sistema do agente (markdown): papel, tom, regras',
        },
        defaultMode: {
          type: 'string',
          enum: ['ask', 'plan', 'agent'],
          description: 'Modo padrão das conversas com este agente (default: mantém o da sessão)',
        },
      },
    },
  },
];

export const BUILTIN_TOOL_NAMES = BUILTIN_TOOLS.map((t) => t.name);
export const READONLY_BUILTIN_TOOL_NAMES = [
  'portal_read_file',
  'portal_list_files',
  'portal_load_skill',
  'bmad_read_file',
  'bmad_list_files',
];
/** Ferramentas da instalação global do BMAD (somente leitura, compartilhada). */
export const BMAD_TOOL_NAMES = ['bmad_read_file', 'bmad_list_files'];
/**
 * Ferramentas que SÓ existem em conversas de projeto. As demais valem em
 * qualquer conversa: as de arquivo/comando usam a pasta de trabalho da sessão
 * (projeto ou workspace da conversa avulsa).
 */
export const PROJECT_ONLY_TOOL_NAMES = ['portal_create_skill'];

export function isBuiltinTool(name: string): boolean {
  return BUILTIN_TOOL_NAMES.includes(name);
}

/**
 * Resolve um caminho relativo dentro da pasta de trabalho (projeto ou
 * workspace da conversa), rejeitando qualquer escape: caminhos absolutos,
 * "..", symlinks que saem da raiz e a pasta de metadados.
 */
export function resolveInProject(workRoot: string, relPath: string): string {
  const resolved = path.resolve(workRoot, relPath);
  const rel = path.relative(workRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Caminho fora da pasta de trabalho: ${relPath}`);
  }
  if (rel === PROJECT_META_DIR || rel.startsWith(PROJECT_META_DIR + path.sep)) {
    throw new Error(`A pasta ${PROJECT_META_DIR} é reservada ao portal`);
  }
  // valida via realpath o ancestral existente mais profundo (protege contra symlinks)
  let ancestor = resolved;
  while (!fs.existsSync(ancestor)) {
    ancestor = path.dirname(ancestor);
  }
  const realRoot = fs.realpathSync(workRoot);
  const realAncestor = fs.realpathSync(ancestor);
  const relReal = path.relative(realRoot, realAncestor);
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
    throw new Error(`Caminho fora da pasta de trabalho: ${relPath}`);
  }
  return resolved;
}

/** Resolve um caminho dentro da instalação global do BMAD (somente leitura). */
function resolveInBmad(relPath: string): string {
  const root = bmadRootDir();
  if (!fs.existsSync(root)) {
    throw new Error('BMAD não está instalado. Instale pela tela de um projeto (painel BMAD).');
  }
  const resolved = path.resolve(root, relPath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Caminho fora da instalação BMAD: ${relPath}`);
  }
  return resolved;
}

function readFileClamped(file: string, label: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Arquivo não encontrado: ${label}`);
    }
    throw err;
  }
  if (!stat.isFile()) throw new Error(`Não é um arquivo: ${label}`);
  const fd = fs.openSync(file, 'r');
  try {
    const size = Math.min(stat.size, READ_LIMIT);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    let content = buf.toString('utf8');
    if (stat.size > READ_LIMIT) {
      content += `\n… (arquivo truncado em ${READ_LIMIT / 1024} KB)`;
    }
    return content;
  } finally {
    fs.closeSync(fd);
  }
}

interface ToolOutcome {
  ok: boolean;
  content: string;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Campo "${field}" é obrigatório`);
  return value;
}

function slugify(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'documento'
  );
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
  workRoot: string,
  projectId: string,
): ToolOutcome {
  const args = (input ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case 'portal_save_knowledge': {
        const baseName = asString(args.base, 'base').trim();
        const scope = args.scope === 'project' ? 'project' : 'global';
        if (scope === 'project' && !projectId) {
          throw new Error(
            'Esta conversa não está em um projeto: use scope "global" ou abra um chat de projeto',
          );
        }
        // reaproveita base existente com o mesmo nome (em qualquer escopo visível)
        let base = listBases(projectId || undefined).find(
          (b) => b.name.trim().toLowerCase() === baseName.toLowerCase(),
        );
        let created = false;
        if (!base) {
          base = createBase({
            name: baseName,
            description: typeof args.description === 'string' ? args.description.trim() : undefined,
            scope,
            projectId: scope === 'project' ? projectId : undefined,
          });
          if (!base) throw new Error('Não foi possível criar a base de conhecimento');
          created = true;
        }
        let docName =
          typeof args.doc === 'string' && args.doc.trim() ? args.doc.trim() : slugify(baseName);
        if (!['.md', '.txt'].includes(path.extname(docName).toLowerCase())) docName += '.md';
        const doc = writeDoc(base.id, docName, asString(args.content, 'content'));
        return {
          ok: true,
          content:
            `Documento "${doc.name}" salvo na base "${base.name}"` +
            (created ? ` (base ${scope === 'global' ? 'global' : 'do projeto'} criada)` : '') +
            ' — visível na página Conhecimento; entra no contexto dos chats enquanto a base estiver habilitada.',
        };
      }
      case 'portal_create_skill': {
        const scope = args.scope === 'global' ? 'global' : 'project';
        const command =
          typeof args.command === 'string'
            ? args.command.trim().replace(/^\//, '') || undefined
            : undefined;
        const skill = createSkill({
          scope,
          projectId: scope === 'project' ? projectId : undefined,
          name: asString(args.name, 'name').trim(),
          description: typeof args.description === 'string' ? args.description.trim() : '',
          command,
          content: asString(args.content, 'content'),
        });
        if (!skill) throw new Error('Projeto não encontrado para registrar a skill');
        return {
          ok: true,
          content:
            `Skill "${skill.name}" registrada (${scope === 'project' ? 'do projeto' : 'global'}) — ` +
            `use /${skill.command} no chat ou ative-a no menu Skills para injetá-la no contexto.`,
        };
      }
      case 'portal_create_agent': {
        const defaultMode = (['ask', 'plan', 'agent'] as const).find(
          (m) => m === args.defaultMode,
        ) as SessionMode | undefined;
        const agent = createAgent({
          name: asString(args.name, 'name').trim(),
          description:
            typeof args.description === 'string' ? args.description.trim() : undefined,
          icon: typeof args.icon === 'string' && args.icon.trim() ? args.icon.trim() : undefined,
          instructions: asString(args.instructions, 'instructions'),
          defaultMode,
        });
        return {
          ok: true,
          content:
            `Agente "${agent.name}" criado — já aparece no seletor de agente do chat e pode ser ` +
            'editado na página Agents.',
        };
      }
      case 'portal_load_skill': {
        const command = asString(args.command, 'command').trim().replace(/^\//, '').toLowerCase();
        const visible = listSkills(projectId || undefined);
        const meta = visible.find((s) => s.command === command);
        if (!meta) {
          const known = visible.map((s) => s.command).join(', ');
          throw new Error(
            `Skill "${command}" não encontrada. Comandos visíveis: ${known || '(nenhum)'}`,
          );
        }
        const skill = getSkill(meta.id);
        if (!skill?.content) throw new Error(`Skill "${command}" está sem conteúdo`);
        const input =
          typeof args.input === 'string' && args.input.trim()
            ? args.input
            : '(o pedido do usuário está na conversa)';
        const content = skill.content.includes('{{input}}')
          ? skill.content.replaceAll('{{input}}', input)
          : skill.content;
        return {
          ok: true,
          content: `Skill "${skill.name}" carregada. Siga estas instruções agora:\n\n${content}`,
        };
      }
      case 'portal_write_file': {
        const rel = asString(args.path, 'path');
        const content = typeof args.content === 'string' ? args.content : '';
        if (Buffer.byteLength(content) > WRITE_LIMIT) {
          throw new Error(`Conteúdo excede o limite de ${WRITE_LIMIT / 1024 / 1024} MB`);
        }
        const file = resolveInProject(workRoot, rel);
        if (args.overwrite === false && fs.existsSync(file)) {
          throw new Error(`Arquivo já existe: ${rel}`);
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, 'utf8');
        return { ok: true, content: `Arquivo salvo: ${rel} (${Buffer.byteLength(content)} bytes)` };
      }
      case 'portal_read_file': {
        const rel = asString(args.path, 'path');
        const file = resolveInProject(workRoot, rel);
        return { ok: true, content: readFileClamped(file, rel) };
      }
      case 'portal_list_files': {
        const rel = typeof args.path === 'string' && args.path ? args.path : '.';
        const dir = resolveInProject(workRoot, rel);
        const acc: string[] = [];
        listEntries(dir, rel === '.' ? '' : rel, args.recursive === true, acc);
        return { ok: true, content: acc.length ? acc.join('\n') : '(pasta vazia)' };
      }
      case 'bmad_read_file': {
        const rel = asString(args.path, 'path');
        return { ok: true, content: readFileClamped(resolveInBmad(rel), rel) };
      }
      case 'bmad_list_files': {
        const rel = typeof args.path === 'string' && args.path ? args.path : '.';
        const dir = resolveInBmad(rel);
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

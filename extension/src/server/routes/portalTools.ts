import * as crypto from 'node:crypto';
import type { AgentPreset, Project, Session } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import { getAgent } from '../../storage/agentStore';
import { getConfig } from '../../storage/configStore';
import { ensureDir, sessionWorkspaceDir } from '../../storage/paths';
import { getProject, projectDir } from '../../storage/projectStore';
import { getSession } from '../../storage/sessionStore';
import {
  SUBAGENT_TOOL_NAMES,
  dispatchBuiltinTool,
  isBuiltinTool,
} from '../../tools/builtinTools';
import { getEnabledToolDefs } from '../../tools/toolRegistry';
import { callMcpTool } from '../../tools/mcpManager';
import { executeCommand, startBackgroundCommand } from '../../tools/runCommand';
import { markPortalToolsFetched } from '../../chat/portalMcpPing';
import { activeStream } from '../../chat/streamHub';
import { tokenFor } from '../../chat/activeRequests';
import { waitForApproval } from '../../chat/approvals';
import { waitForAnswer } from '../../chat/questions';
import { parseInput, resolvePersona } from '../../chat/subagent';
import { resolveProvider } from '../../chat/providers';

/**
 * Ponte que dá às CLIs agênticas (Claude Code, Devin) as MESMAS ferramentas
 * que o loop do Copilot oferece, com os mesmos nomes.
 *
 * É isto que faz o BMAD funcionar fora do Copilot: o adaptador das personas
 * manda usar `bmad_read_file`, `portal_write_file`, `portal_run_command` etc.
 * pelo nome. Reescrever os assets por motor seria manter três dialetos do
 * BMAD; expor as ferramentas mantém um só.
 *
 * Quem consome estas rotas é o servidor MCP do portal (mcp/portalMcpServer),
 * que roda como processo separado spawnado pela CLI.
 *
 * Efeito colateral desejado: como a escrita volta a passar pelo
 * portal_write_file, os checkpoints (botão "Reverter") continuam funcionando.
 */

/** Ferramentas que dependem de a pasta de trabalho existir em disco. */
const WORKSPACE_FS_TOOLS = [
  'portal_write_file',
  'portal_read_file',
  'portal_list_files',
  'portal_edit_file',
  'portal_search_files',
  'portal_delete_file',
  'portal_move_file',
];

interface Resolved {
  session: Session;
  agent?: AgentPreset;
  project?: Project;
  workRoot: string;
}

function resolveSession(sessionId: string): Resolved | undefined {
  const session = getSession(sessionId);
  if (!session) return undefined;
  const agent = session.agentId ? getAgent(session.agentId) : undefined;
  const project = session.projectId ? getProject(session.projectId) : undefined;
  // mesma regra do runChat: a pasta do projeto, ou o workspace da sessão avulsa
  const workRoot = project ? projectDir(project) : sessionWorkspaceDir(session.id);
  return { session, agent, project, workRoot };
}

interface PublishedTool {
  name: string;
  description: string;
  inputSchema: object;
}

/**
 * Exatamente o mesmo catálogo que o loop do Copilot monta — builtins MAIS os
 * servidores MCP cadastrados no portal. Reusar getEnabledToolDefs em vez de
 * refiltrar aqui é o que garante paridade de verdade: o liga/desliga da
 * conversa e do agente, as ferramentas indisponíveis (BMAD ausente, máquina
 * sem shell), o modo plan e o teto de ferramentas valem igual nos três motores.
 *
 * `subagent` corta para as de leitura: um subagente do party mode não escreve
 * arquivo nem roda comando, igual ao do Copilot.
 */
function toolsFor(r: Resolved, scope?: string): PublishedTool[] {
  const { defs } = getEnabledToolDefs(r.session, r.agent);
  return defs
    .filter((t) => scope !== 'subagent' || SUBAGENT_TOOL_NAMES.includes(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description ?? '',
      // o MCP exige inputSchema; ferramenta sem schema declarado vira objeto livre
      inputSchema: (t.inputSchema as object | undefined) ?? { type: 'object' },
    }));
}

export function registerPortalToolRoutes(router: Router): void {
  // catálogo que o servidor MCP publica para a CLI
  router.get('/api/portal-tools', ({ res, query }) => {
    const sessionId = query.get('sessionId') ?? '';
    const r = resolveSession(sessionId);
    if (!r) {
      sendError(res, 404, 'Sessão não encontrada');
      return;
    }
    // sinal de vida: é assim que o provider descobre que o processo subiu
    markPortalToolsFetched(sessionId);
    sendJson(res, 200, toolsFor(r, query.get('scope') ?? undefined));
  });

  router.post('/api/portal-tools/call', async ({ res, body }) => {
    const { sessionId, name, input } = (body ?? {}) as {
      sessionId?: string;
      name?: string;
      input?: unknown;
    };
    if (!sessionId || !name) {
      sendError(res, 400, 'sessionId e name são obrigatórios');
      return;
    }
    const r = resolveSession(sessionId);
    if (!r) {
      sendError(res, 404, 'Sessão não encontrada');
      return;
    }
    const scope = typeof (body as { scope?: unknown })?.scope === 'string'
      ? (body as { scope: string }).scope
      : undefined;
    if (!toolsFor(r, scope).some((t) => t.name === name)) {
      sendJson(res, 200, { ok: false, content: `Ferramenta "${name}" não disponível nesta conversa.` });
      return;
    }

    // A ferramenta foi chamada de fora do portal, mas pertence a um turno em
    // andamento: é o stream desse turno que leva a aprovação até a UI e o
    // token dele que morre no "Parar".
    const stream = activeStream(sessionId);
    const token = stream ? tokenFor(stream.requestId) : undefined;

    try {
      const outcome = await callTool(r, name, input, stream, token);
      sendJson(res, 200, outcome);
    } catch (err) {
      sendJson(res, 200, {
        ok: false,
        content: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

type Stream = ReturnType<typeof activeStream>;
type Token = ReturnType<typeof tokenFor>;

async function callTool(
  r: Resolved,
  name: string,
  input: unknown,
  stream: Stream,
  token: Token,
): Promise<{ ok: boolean; content: string }> {
  if (name === 'portal_run_command') return runCommand(r, input, stream, token);
  if (name === 'portal_ask_user') return askUser(input, stream, token);
  if (name === 'portal_spawn_subagent') return spawnSubagent(r, input, token);
  if (isBuiltinTool(name)) {
    if (WORKSPACE_FS_TOOLS.includes(name)) ensureDir(r.workRoot);
    return dispatchBuiltinTool(
      name,
      input,
      r.workRoot,
      r.project?.id ?? '',
      r.agent?.knowledgeBaseIds ?? [],
    );
  }
  // servidor MCP cadastrado no portal: a conexão, as credenciais e o proxy
  // corporativo já estão de pé aqui — a CLI não precisa reconfigurar nada
  const content = await callMcpTool(name, (input ?? {}) as object);
  return { ok: true, content };
}

/** Comando de shell: passa pela mesma aprovação da UI que o loop do Copilot usa. */
async function runCommand(
  r: Resolved,
  input: unknown,
  stream: Stream,
  token: Token,
): Promise<{ ok: boolean; content: string }> {
  const args = (input ?? {}) as {
    command?: unknown;
    timeoutSeconds?: unknown;
    background?: unknown;
  };
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) throw new Error('Campo "command" é obrigatório');

  const bin = command.split(/\s+/)[0] ?? '';
  const allowlisted = !!bin && (getConfig().commandAllowlist ?? []).includes(bin);

  if (!allowlisted) {
    if (!stream || !token) {
      // sem turno ativo não há como pedir aprovação; executar seria rodar um
      // comando arbitrário sem ninguém olhando
      return {
        ok: false,
        content:
          'Não há uma resposta em andamento nesta conversa para pedir aprovação do comando.',
      };
    }
    const callId = crypto.randomUUID();
    stream.send('approval_request', {
      callId,
      toolName: 'portal_run_command',
      command,
      cwd: r.workRoot,
    });
    const verdict = await waitForApproval(stream.requestId, callId, token);
    if (verdict !== 'approved') {
      return {
        ok: false,
        content:
          verdict === 'timeout'
            ? 'A aprovação expirou sem resposta do usuário. Não tente o comando de novo; siga pela alternativa manual quando existir.'
            : 'O usuário negou a execução deste comando. Não insista; siga pela alternativa manual quando existir.',
      };
    }
  }

  ensureDir(r.workRoot);
  if (args.background === true) return startBackgroundCommand(command, r.workRoot);
  if (!token) throw new Error('Não há uma resposta em andamento nesta conversa.');
  return executeCommand(
    command,
    r.workRoot,
    token,
    typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : undefined,
    // shell persistente da conversa: cd/env sobrevivem entre comandos
    r.session.id,
  );
}

/** Pergunta ao usuário: mesma caixa que o portal_ask_user abre no Copilot. */
async function askUser(
  input: unknown,
  stream: Stream,
  token: Token,
): Promise<{ ok: boolean; content: string }> {
  const args = (input ?? {}) as { question?: unknown; options?: unknown };
  const question = typeof args.question === 'string' ? args.question.trim() : '';
  if (!question) throw new Error('Campo "question" é obrigatório');
  if (!stream || !token) {
    return { ok: false, content: 'Não há uma resposta em andamento nesta conversa para perguntar.' };
  }
  const options = (Array.isArray(args.options) ? args.options : [])
    .filter((o): o is string => typeof o === 'string' && !!o.trim())
    .map((o) => o.trim())
    .slice(0, 6);
  const callId = crypto.randomUUID();
  stream.send('user_question', { callId, toolName: 'portal_ask_user', question, options });
  const outcome = await waitForAnswer(stream.requestId, callId, token);
  if (outcome.kind === 'answered') {
    return { ok: true, content: `Resposta do usuário: ${outcome.answer}` };
  }
  return {
    ok: false,
    content:
      outcome.kind === 'timeout'
        ? 'A pergunta expirou sem resposta do usuário. Prossiga com a opção mais razoável e deixe explícito o que assumiu.'
        : 'A pergunta foi cancelada.',
  };
}

/**
 * Party mode fora do Copilot: cada motor roda o subagente com a própria CLI.
 * A persona e a tarefa são resolvidas aqui (mesma lógica dos dois lados), e o
 * motor da conversa decide COMO executar — não há razão para o party mode ser
 * exclusivo de um backend.
 */
async function spawnSubagent(
  r: Resolved,
  input: unknown,
  token: Token,
): Promise<{ ok: boolean; content: string }> {
  if (!token) {
    return { ok: false, content: 'Não há uma resposta em andamento nesta conversa.' };
  }
  const provider = resolveProvider(r.session.provider);
  if (!provider.runSubagent) {
    return {
      ok: false,
      content: `O motor "${provider.id}" não oferece subagentes (party mode).`,
    };
  }
  const parsed = parseInput(input);
  const outcome = await provider.runSubagent({
    persona: resolvePersona(parsed, r.workRoot),
    task: parsed.task,
    label: parsed.label,
    modelId: parsed.modelId,
    workRoot: r.workRoot,
    sessionId: r.session.id,
    projectId: r.project?.id ?? '',
    agentBaseIds: r.agent?.knowledgeBaseIds ?? [],
    token,
  });
  return { ok: outcome.ok, content: outcome.content };
}

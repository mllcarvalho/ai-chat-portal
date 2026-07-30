import type { ChatMessage, MessagePart, Session } from '@aiportal/shared';
import { slugifyCommand } from '@aiportal/shared';
import { getAgent } from './agentStore';
import { getProject } from './projectStore';

/**
 * Export da conversa como um Markdown legível (para download e envio por
 * email): cabeçalho com os metadados da sessão e um "## Usuário"/"## Assistente"
 * por turno. Tool calls não despejam JSON — viram uma linha resumida em
 * pt-BR (ex.: "> 🔧 Criou o arquivo docs/prd.md"), e perguntas/aprovações
 * aparecem resumidas com a resposta do usuário.
 */

type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;
type ToolResultPart = Extract<MessagePart, { type: 'tool_result' }>;

const MODE_LABEL: Record<Session['mode'], string> = {
  ask: 'Ask',
  plan: 'Plan',
  agent: 'Agent',
};

/** Campo string do input da tool, aparado (undefined quando ausente/vazio). */
function inputStr(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Uma linha só, curta o bastante para o resumo não virar parágrafo. */
function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Nome de exibição da persona de um subagente (mesma heurística da UI). */
function subagentLabel(input: Record<string, unknown>): string {
  const label = inputStr(input, 'label') ?? inputStr(input, 'personaAgent');
  if (label) return label;
  const personaPath = inputStr(input, 'personaPath');
  if (personaPath) {
    const base = personaPath.split('/').pop() ?? '';
    const name = base.replace(/\.(md|txt)$/i, '');
    if (name) return name;
  }
  return 'Subagente';
}

/** Resumo em uma linha de uma tool call (sem JSON), com emoji de contexto. */
function toolCallSummary(call: ToolCallPart, result: ToolResultPart | undefined): string {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const s = (key: string) => inputStr(input, key);

  let line: string;
  switch (call.toolName) {
    case 'portal_write_file':
      line = `🔧 Criou o arquivo ${s('path') ?? '(sem caminho)'}`;
      break;
    case 'portal_edit_file':
      line = `🔧 Editou o arquivo ${s('path') ?? '(sem caminho)'}`;
      break;
    case 'portal_read_file':
      line = `📖 Leu o arquivo ${s('path') ?? '(sem caminho)'}`;
      break;
    case 'portal_list_files':
      line = `📖 Listou os arquivos${s('path') ? ` de ${s('path')}` : ' da pasta de trabalho'}`;
      break;
    case 'portal_delete_file':
      line = `🔧 Excluiu ${s('path') ?? '(sem caminho)'}`;
      break;
    case 'portal_move_file':
      line = `🔧 Moveu ${s('from') ?? '?'} para ${s('to') ?? '?'}`;
      break;
    case 'portal_run_command':
      line = `💻 Executou o comando \`${oneLine(s('command') ?? '', 100) || '(vazio)'}\``;
      break;
    case 'portal_command_output':
      line = `💻 Consultou o processo em background ${s('id') ?? ''}`.trim();
      break;
    case 'portal_todo':
      line = '📋 Atualizou o plano de trabalho';
      break;
    case 'portal_search_files':
      line = `🔎 Buscou "${oneLine(s('query') ?? '', 80)}" nos arquivos`;
      break;
    case 'portal_fetch_url':
      line = `🌐 Leu a página ${s('url') ?? '(sem URL)'}`;
      break;
    case 'portal_web_search':
      line = `🌐 Pesquisou na web: "${oneLine(s('query') ?? '', 80)}"`;
      break;
    case 'portal_spawn_subagent':
      line = `🎭 Consultou o subagente "${subagentLabel(input)}"`;
      break;
    case 'portal_ask_user': {
      line = `❓ Perguntou: "${oneLine(s('question') ?? '', 160)}"`;
      if (result?.ok && result.content.trim()) {
        line += ` — resposta: "${oneLine(result.content, 120)}"`;
      }
      break;
    }
    case 'portal_load_skill':
      line = `⚡ Usou a skill /${s('command') ?? '?'}`;
      break;
    case 'portal_read_skill_file':
      line = `📖 Leu o arquivo ${s('path') ?? '?'} da skill /${s('command') ?? '?'}`;
      break;
    case 'portal_search_knowledge':
      line = `📚 Buscou "${oneLine(s('query') ?? '', 80)}" nas bases de conhecimento`;
      break;
    case 'portal_read_knowledge':
      line = `📚 Leu o documento ${s('doc') ?? '?'} da base ${s('base') ?? '?'}`;
      break;
    case 'portal_save_knowledge':
      line = `📚 Salvou um documento na base ${s('base') ?? '?'}`;
      break;
    case 'portal_create_skill':
      line = `⚡ Criou a skill "${s('name') ?? '?'}"`;
      break;
    case 'portal_create_agent':
      line = `🤖 Criou o agente "${s('name') ?? '?'}"`;
      break;
    default: {
      // ferramentas MCP/desconhecidas: nome + alvo quando reconhecível
      const target = s('path') ?? s('url') ?? s('query');
      line = `🔧 Usou a ferramenta ${call.toolName}${target ? ` (${oneLine(target, 80)})` : ''}`;
    }
  }

  if (result && !result.ok) {
    // comando negado na aprovação também chega como tool_result de falha
    line += ' — falhou';
  } else if (call.toolName === 'portal_run_command' && !result) {
    line += ' — sem resultado registrado';
  }
  return line;
}

function renderMessage(message: ChatMessage): string {
  const results = new Map<string, ToolResultPart>();
  for (const part of message.parts) {
    if (part.type === 'tool_result') results.set(part.callId, part);
  }

  const blocks: string[] = [];
  for (const part of message.parts) {
    if (part.type === 'text') {
      if (part.text.trim()) blocks.push(part.text.trim());
    } else if (part.type === 'attachment') {
      blocks.push(`> 📎 Anexo: ${part.name}`);
    } else if (part.type === 'tool_call') {
      blocks.push(`> ${toolCallSummary(part, results.get(part.callId))}`);
    }
    // tool_result: já consumido no resumo da tool_call correspondente
  }
  if (message.error) {
    blocks.push(`> ⚠️ Erro: ${message.error.message}`);
  }
  if (!blocks.length) blocks.push('_(sem conteúdo)_');

  const heading = message.role === 'user' ? '## Usuário' : '## Assistente';
  return `${heading}\n\n${blocks.join('\n\n')}`;
}

/** Serializa a sessão inteira em Markdown legível. */
export function sessionToMarkdown(session: Session): string {
  const meta: string[] = [];
  const created = new Date(session.createdAt);
  meta.push(
    `- **Data:** ${created.toLocaleDateString('pt-BR')} ${created.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    })}`,
  );
  meta.push(`- **Modo:** ${MODE_LABEL[session.mode] ?? session.mode}`);
  if (session.agentId) {
    const agent = getAgent(session.agentId);
    meta.push(`- **Agente:** ${agent?.name ?? session.agentId}`);
  }
  if (session.modelId) meta.push(`- **Modelo:** ${session.modelId}`);
  if (session.projectId) {
    const project = getProject(session.projectId);
    if (project) meta.push(`- **Projeto:** ${project.name}`);
  }
  meta.push(`- **Mensagens:** ${session.messages.length}`);

  const body = session.messages.map(renderMessage).join('\n\n');
  return `# ${session.title}\n\n${meta.join('\n')}\n\n---\n\n${body}\n`;
}

/** Nome de arquivo seguro para o download/anexo (slug do título). */
export function sessionExportFileName(session: Session): string {
  return `${slugifyCommand(session.title) || 'conversa'}.md`;
}

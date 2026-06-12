import * as vscode from 'vscode';
import type {
  AgentPreset,
  ChatMessage,
  Project,
  Session,
  SkillWithContent,
} from '@aiportal/shared';

/** Orçamento de poda: ~3.5 chars/token sobre 85% da janela do modelo. */
const CHARS_PER_TOKEN = 3.5;
const BUDGET_RATIO = 0.85;

const MODE_INSTRUCTIONS: Record<Session['mode'], string> = {
  ask: 'Modo Pergunta: responda diretamente, com clareza. Você não tem ferramentas nesta conversa.',
  plan: 'Modo Planejamento: produza um plano claro e estruturado em markdown antes de qualquer execução. NÃO crie nem modifique arquivos; no máximo leia o que for necessário com as ferramentas de leitura.',
  agent:
    'Modo Agente: use as ferramentas disponíveis sempre que ajudarem a cumprir a tarefa, sem pedir permissão. Explique brevemente o que está fazendo.',
};

export interface KnowledgeSnippet {
  baseName: string;
  docName: string;
  content: string;
}

/** Arquivo do projeto fixado no contexto da sessão. */
export interface ContextFile {
  path: string;
  content: string;
}

export function buildPreamble(opts: {
  session: Session;
  project?: Project;
  agent?: AgentPreset;
  instructionSkills: SkillWithContent[];
  /** Skills visíveis na sessão — viram o catálogo carregável por portal_load_skill. */
  commandSkills?: SkillWithContent[];
  /** Se a ferramenta portal_load_skill está disponível nesta rodada. */
  canLoadSkills?: boolean;
  knowledge?: KnowledgeSnippet[];
  contextFiles?: ContextFile[];
  /** Nota sobre shell/python da máquina (só entra no modo agent). */
  envNote?: string;
}): string {
  const { session, project, agent, instructionSkills, knowledge, contextFiles, envNote } = opts;
  const blocks: string[] = [
    'Você é um assistente de IA do AI Product BMAD Chat, conversando em português brasileiro com analistas de produto.',
    `Data atual: ${new Date().toLocaleDateString('pt-BR', { dateStyle: 'full' })}.`,
    MODE_INSTRUCTIONS[session.mode],
  ];
  if (agent?.instructions) {
    blocks.push(`## Instruções do agente "${agent.name}"\n${agent.instructions}`);
  }
  if (project) {
    if (project.instructions) {
      blocks.push(`## Instruções do projeto "${project.name}"\n${project.instructions}`);
    }
    if (session.mode !== 'ask') {
      blocks.push(
        `Esta conversa pertence ao projeto "${project.name}". Os arquivos gerados devem ficar na pasta do projeto: use as ferramentas portal_write_file, portal_read_file e portal_list_files com caminhos relativos à raiz do projeto.`,
        'Quando o usuário pedir para criar uma skill, use a ferramenta portal_create_skill — skills do portal são markdown registradas no menu Skills, nunca arquivos soltos criados com portal_write_file.',
      );
    }
  } else if (session.mode !== 'ask') {
    blocks.push(
      'Esta conversa não pertence a um projeto, mas tem uma pasta de trabalho própria (o workspace da conversa): ' +
        'use portal_write_file, portal_read_file e portal_list_files com caminhos relativos a essa pasta. ' +
        'O usuário vê e baixa esses arquivos pelo painel Arquivos da conversa.',
    );
  }
  if (session.mode !== 'ask') {
    blocks.push(
      'Quando o usuário pedir para criar um agente (uma persona reutilizável do portal), use a ' +
        'ferramenta portal_create_agent — agentes são globais e ficam no seletor de agente do chat.',
      'Ao continuar a resposta depois de receber resultados de ferramentas, retome de onde parou: ' +
        'nunca repita saudações, apresentações nem informações que você já escreveu nesta mesma ' +
        'resposta. Anuncie uma ação só depois de executá-la, nunca antes de chamar a ferramenta.',
    );
  }
  if (envNote && session.mode === 'agent') {
    blocks.push(envNote);
  }
  for (const skill of instructionSkills) {
    blocks.push(`## Skill ativa: ${skill.name}\n${skill.content}`);
  }
  // catálogo leve (nome + descrição) das skills NÃO ativas, para o modelo
  // carregar sob demanda com portal_load_skill quando o pedido casar
  if (opts.canLoadSkills) {
    const activeIds = new Set(instructionSkills.map((s) => s.id));
    const catalog = (opts.commandSkills ?? []).filter((s) => !activeIds.has(s.id));
    if (catalog.length) {
      const linkedIds = new Set(agent?.skillIds ?? []);
      const hasLinked = catalog.some((s) => linkedIds.has(s.id));
      blocks.push(
        '## Catálogo de skills (não carregadas)\n' +
          'Estas skills existem no portal mas NÃO estão neste contexto — abaixo só comando, nome e descrição. ' +
          'Sempre que o pedido do usuário corresponder à descrição de uma skill, carregue-a com a ferramenta ' +
          'portal_load_skill ANTES de responder e siga as instruções dela. Se mais de uma servir, ' +
          'carregue a mais específica. Não invente skills fora desta lista.' +
          (hasLinked
            ? ' Skills marcadas com [skill deste agente] foram vinculadas ao agente desta conversa — dê preferência a elas em caso de empate.'
            : '') +
          '\n' +
          catalog
            .map(
              (s) =>
                `- ${s.command}: ${s.name}${s.description ? ` — ${s.description}` : ''}${linkedIds.has(s.id) ? ' [skill deste agente]' : ''}`,
            )
            .join('\n'),
      );
    }
  }
  for (const snippet of knowledge ?? []) {
    blocks.push(
      `## Base de conhecimento: ${snippet.baseName} — ${snippet.docName}\n${snippet.content}`,
    );
  }
  for (const file of contextFiles ?? []) {
    blocks.push(
      `## Arquivo do projeto fixado no contexto: ${file.path}\n\`\`\`\n${file.content}\n\`\`\``,
    );
  }
  return blocks.join('\n\n');
}

/** Expande "/comando resto" usando o campo command das skills visíveis. */
export function expandSlashCommand(text: string, commandSkills: SkillWithContent[]): string {
  const match = /^\/([\w-]+)\s*([\s\S]*)$/.exec(text.trim());
  if (!match) return text;
  const [, command, rest] = match;
  const skill = commandSkills.find((s) => s.command === command);
  if (!skill) return text;
  if (skill.content.includes('{{input}}')) {
    return skill.content.replaceAll('{{input}}', rest);
  }
  return rest ? `${skill.content}\n\n${rest}` : skill.content;
}

function userText(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/** Anexos da mensagem viram blocos <anexo> logo após o texto do usuário. */
function attachmentBlocks(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<typeof p, { type: 'attachment' }> => p.type === 'attachment')
    .map((p) => `<anexo nome="${p.name}">\n${p.content}\n</anexo>`)
    .join('\n\n');
}

function approxChars(message: ChatMessage): number {
  return JSON.stringify(message.parts).length;
}

/**
 * Constrói as mensagens da API a partir do histórico persistido.
 * Não há system role: o preâmbulo vai como primeira mensagem User.
 * tool_calls viram Assistant(ToolCallPart) seguidos de User(ToolResultPart).
 */
export function buildMessages(opts: {
  session: Session;
  project?: Project;
  agent?: AgentPreset;
  instructionSkills: SkillWithContent[];
  commandSkills: SkillWithContent[];
  canLoadSkills?: boolean;
  knowledge?: KnowledgeSnippet[];
  contextFiles?: ContextFile[];
  envNote?: string;
  maxInputTokens: number;
}): vscode.LanguageModelChatMessage[] {
  const { session, commandSkills } = opts;
  const preamble = buildPreamble(opts);

  // poda: mantém as mensagens mais recentes que cabem no orçamento
  const budget = Math.max(
    8_000,
    opts.maxInputTokens * BUDGET_RATIO * CHARS_PER_TOKEN - preamble.length,
  );
  let used = 0;
  let startIdx = 0;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    used += approxChars(session.messages[i]);
    if (used > budget && i < session.messages.length - 1) {
      startIdx = i + 1;
      break;
    }
  }

  const result: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(`<instruções>\n${preamble}\n</instruções>`),
  ];

  for (const message of session.messages.slice(startIdx)) {
    if (message.role === 'user') {
      const text = expandSlashCommand(userText(message), commandSkills);
      const attachments = attachmentBlocks(message);
      const combined = [text, attachments].filter(Boolean).join('\n\n');
      if (combined) result.push(vscode.LanguageModelChatMessage.User(combined));
      continue;
    }
    // assistant: texto + tool calls, depois os resultados como User
    const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> =
      [];
    const resultParts: vscode.LanguageModelToolResultPart[] = [];
    for (const part of message.parts) {
      if (part.type === 'text' && part.text) {
        assistantParts.push(new vscode.LanguageModelTextPart(part.text));
      } else if (part.type === 'tool_call') {
        assistantParts.push(
          new vscode.LanguageModelToolCallPart(
            part.callId,
            part.toolName,
            (part.input ?? {}) as object,
          ),
        );
      } else if (part.type === 'tool_result') {
        resultParts.push(
          new vscode.LanguageModelToolResultPart(part.callId, [
            new vscode.LanguageModelTextPart(part.content),
          ]),
        );
      }
    }
    if (assistantParts.length) {
      result.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
    }
    if (resultParts.length) {
      result.push(vscode.LanguageModelChatMessage.User(resultParts));
    }
  }
  return result;
}

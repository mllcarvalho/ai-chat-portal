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

export function buildPreamble(opts: {
  session: Session;
  project?: Project;
  agent?: AgentPreset;
  instructionSkills: SkillWithContent[];
}): string {
  const { session, project, agent, instructionSkills } = opts;
  const blocks: string[] = [
    'Você é um assistente de IA do AI Chat Portal, conversando em português brasileiro com analistas de produto.',
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
      );
    }
  }
  for (const skill of instructionSkills) {
    blocks.push(`## Skill ativa: ${skill.name}\n${skill.content}`);
  }
  return blocks.join('\n\n');
}

/** Expande "/comando resto" usando skills do tipo command. */
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
      if (text) result.push(vscode.LanguageModelChatMessage.User(text));
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

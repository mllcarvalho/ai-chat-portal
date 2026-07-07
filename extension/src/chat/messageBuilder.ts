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

/** Entrada do índice de bases grandes demais para injeção integral. */
export interface KnowledgeIndexEntry {
  baseName: string;
  docName: string;
  size: number;
  headings: string[];
}

/** Arquivo do projeto fixado no contexto da sessão. */
export interface ContextFile {
  path: string;
  content: string;
}

/** A skill de party mode do BMAD está ativa ou carregável nesta rodada? */
function hasPartyModeSkill(opts: {
  instructionSkills: SkillWithContent[];
  commandSkills?: SkillWithContent[];
  canLoadSkills?: boolean;
}): boolean {
  const isParty = (s: SkillWithContent) => s.command === 'bmad-party-mode';
  return (
    opts.instructionSkills.some(isParty) ||
    (!!opts.canLoadSkills && (opts.commandSkills ?? []).some(isParty))
  );
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
  /** Índice injetado no lugar do conteúdo quando as bases excedem o teto. */
  knowledgeIndex?: KnowledgeIndexEntry[];
  contextFiles?: ContextFile[];
  /** Nota sobre shell/python da máquina (só entra no modo agent). */
  envNote?: string;
  /** Usuário RACF do login corporativo — identifica o usuário nas saudações. */
  racfUser?: string;
}): string {
  const { session, project, agent, instructionSkills, knowledge, contextFiles, envNote } = opts;
  const blocks: string[] = [
    'Você é um assistente de IA do BMAD Product Studio, conversando em português brasileiro com analistas de produto.',
    `Data atual: ${new Date().toLocaleDateString('pt-BR', { dateStyle: 'full' })}.`,
    opts.racfUser
      ? `O usuário desta conversa é "${opts.racfUser}" (usuário RACF do Itaú). Ao cumprimentá-lo, ` +
        `use "Olá, ${opts.racfUser}". Fora do RACF você não sabe quem ele é: NUNCA invente nome, ` +
        `apelido ou cargo para o usuário — isso vale também para personas e subagentes (inclua o ` +
        `RACF nas tasks quando a persona precisar se dirigir ao usuário).`
      : 'Você NÃO sabe o nome do usuário desta conversa: cumprimente sem nome (ex.: "Olá!") e ' +
        'NUNCA invente nome, apelido ou cargo para ele — isso vale também para personas e subagentes.',
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
      'Para pareceres INDEPENDENTES de várias personas (ex: comitê de revisores), dispare um ' +
        'portal_spawn_subagent POR PERSONA, todos na mesma rodada — eles rodam em paralelo e cada ' +
        'resposta aparece como um balão próprio no chat, identificado pelo label. Já quando o ' +
        'usuário pedir uma DISCUSSÃO entre personas (debate, roundtable, party mode do BMAD), ' +
        (hasPartyModeSkill(opts)
          ? 'siga o loop da skill bmad-party-mode (se ainda não estiver ativa, carregue-a ANTES ' +
            'com portal_load_skill). '
          : 'conduza rodadas em que cada persona reage às demais. ') +
        'Os subagentes não veem a conversa nem uns aos outros: cada task precisa levar a persona, ' +
        'o contexto da discussão e o que os outros já disseram — tasks genéricas idênticas produzem ' +
        'respostas duplicadas, não um debate. Quando precisar que o usuário escolha ' +
        'entre opções (elicitações de workflow, decisões de rumo), use portal_ask_user em vez de ' +
        'terminar a resposta com a pergunta solta no texto.',
    );
  }
  if (envNote && session.mode === 'agent') {
    blocks.push(envNote);
  }
  for (const skill of instructionSkills) {
    blocks.push(`## Skill ativa: ${skill.name}\n${skill.content}${skillFilesNote(skill)}`);
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
  if (opts.knowledgeIndex?.length) {
    blocks.push(
      '## Bases de conhecimento (índice — conteúdo NÃO carregado)\n' +
        'As bases habilitadas excedem o limite de injeção, então os documentos abaixo NÃO estão ' +
        'neste contexto — só o índice. Sempre que o pedido do usuário tocar nesses assuntos, ' +
        'busque com portal_search_knowledge ANTES de responder e, se os trechos não bastarem, ' +
        'leia o documento com portal_read_knowledge. Nunca responda de memória algo que estas ' +
        'bases documentam, e não invente conteúdo delas.\n' +
        opts.knowledgeIndex
          .map(
            (e) =>
              `- Base "${e.baseName}" — ${e.docName} (${Math.max(1, Math.round(e.size / 1024))} KB)` +
              (e.headings.length ? `: ${e.headings.join('; ')}` : ''),
          )
          .join('\n'),
    );
  }
  for (const file of contextFiles ?? []) {
    blocks.push(
      `## Arquivo do projeto fixado no contexto: ${file.path}\n\`\`\`\n${file.content}\n\`\`\``,
    );
  }
  return blocks.join('\n\n');
}

/** Nota sobre os anexos da pasta da skill (lidos com portal_read_skill_file). */
function skillFilesNote(skill: SkillWithContent): string {
  if (!skill.files?.length) return '';
  return (
    `\n\n> Anexos desta skill — quando as instruções citarem um destes arquivos, leia-o com a ` +
    `ferramenta portal_read_skill_file (command: ${skill.command}): ${skill.files.join(', ')}`
  );
}

/** Expande "/comando resto" usando o campo command das skills visíveis. */
export function expandSlashCommand(text: string, commandSkills: SkillWithContent[]): string {
  const match = /^\/([\w-]+)\s*([\s\S]*)$/.exec(text.trim());
  if (!match) return text;
  const [, command, rest] = match;
  const skill = commandSkills.find((s) => s.command === command);
  if (!skill) return text;
  const expanded = skill.content.includes('{{input}}')
    ? skill.content.replaceAll('{{input}}', rest)
    : rest
      ? `${skill.content}\n\n${rest}`
      : skill.content;
  return expanded + skillFilesNote(skill);
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
    .map((p) => {
      // um anexo contendo a tag literal quebraria a delimitação do bloco
      const safe = p.content.replaceAll('</anexo>', '<\\/anexo>');
      return `<anexo nome="${p.name.replaceAll('"', "'")}">\n${safe}\n</anexo>`;
    })
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
  knowledgeIndex?: KnowledgeIndexEntry[];
  contextFiles?: ContextFile[];
  envNote?: string;
  racfUser?: string;
  maxInputTokens: number;
}): { messages: vscode.LanguageModelChatMessage[]; prunedCount: number } {
  const { session, commandSkills } = opts;
  const rawPreamble = buildPreamble(opts);
  const windowChars = opts.maxInputTokens * BUDGET_RATIO * CHARS_PER_TOKEN;

  // o preâmbulo (skills + knowledge + arquivos fixados) nunca pode sozinho
  // estourar a janela: trunca preservando uma reserva mínima para o histórico
  const preambleLimit = Math.max(16_000, Math.floor(windowChars * 0.75));
  const preamble =
    rawPreamble.length <= preambleLimit
      ? rawPreamble
      : `${rawPreamble.slice(0, preambleLimit)}\n\n… (instruções e contexto fixado truncados: ` +
        'excedem a janela do modelo — remova arquivos fixados ou desabilite bases de conhecimento)';

  // poda: mantém as mensagens mais recentes que cabem no orçamento
  const budget = Math.max(8_000, windowChars - preamble.length);
  let used = 0;
  let startIdx = 0;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    used += approxChars(session.messages[i]);
    if (used > budget && i < session.messages.length - 1) {
      startIdx = i + 1;
      break;
    }
  }
  // nunca começa numa mensagem assistant órfã (tool calls sem o turno do
  // usuário que as originou) — o backend rejeita essa sequência
  while (startIdx > 0 && startIdx < session.messages.length) {
    if (session.messages[startIdx].role === 'user') break;
    startIdx++;
  }

  const result: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(`<instruções>\n${preamble}\n</instruções>`),
  ];
  if (startIdx > 0) {
    result.push(
      vscode.LanguageModelChatMessage.User(
        `(As ${startIdx} mensagens mais antigas desta conversa foram omitidas por limite de ` +
          'contexto. Se o usuário se referir a algo que você não vê aqui, diga que aquele trecho ' +
          'saiu do contexto e peça para ele repetir a informação.)',
      ),
    );
  }

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
    // sessões antigas podem ter tool calls sem resultado (stop no meio das
    // ferramentas antes deste reparo existir): o backend rejeita ToolCallPart
    // órfão, então o desfecho é sintetizado aqui na reconstrução
    const answered = new Set(message.parts.flatMap((p) => (p.type === 'tool_result' ? [p.callId] : [])));
    for (const part of message.parts) {
      if (part.type !== 'tool_call' || answered.has(part.callId)) continue;
      resultParts.push(
        new vscode.LanguageModelToolResultPart(part.callId, [
          new vscode.LanguageModelTextPart('Ferramenta não executada: a resposta foi interrompida.'),
        ]),
      );
    }
    if (assistantParts.length) {
      result.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
    }
    if (resultParts.length) {
      result.push(vscode.LanguageModelChatMessage.User(resultParts));
    }
  }
  return { messages: result, prunedCount: startIdx };
}

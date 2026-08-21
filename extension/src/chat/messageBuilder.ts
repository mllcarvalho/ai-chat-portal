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
  /** Site varrido dono do documento, quando veio de uma coleção. */
  collectionName?: string;
  title?: string;
  sourceUrl?: string;
}

/** Entrada do índice de bases grandes demais para injeção integral. */
export interface KnowledgeIndexEntry {
  baseName: string;
  docName: string;
  size: number;
  headings: string[];
  collectionName?: string;
  title?: string;
  sourceUrl?: string;
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
        `Esta conversa pertence ao projeto "${project.name}". Os arquivos gerados devem ficar na pasta do projeto: use as ferramentas portal_write_file, portal_read_file e portal_list_files com caminhos relativos à raiz do projeto. ` +
          'O usuário vê e baixa esses arquivos pelo painel Arquivos da conversa — você NÃO conhece URLs do portal, então NUNCA escreva links de download ("baixe aqui"): indique o nome do arquivo e o painel Arquivos.',
        'Quando o usuário pedir para criar uma skill, use a ferramenta portal_create_skill — skills do portal são markdown registradas no menu Skills, nunca arquivos soltos criados com portal_write_file.',
      );
    }
  } else if (session.mode !== 'ask') {
    blocks.push(
      'Esta conversa não pertence a um projeto, mas tem uma pasta de trabalho própria (o workspace da conversa): ' +
        'use portal_write_file, portal_read_file e portal_list_files com caminhos relativos a essa pasta. ' +
        'O usuário vê e baixa esses arquivos pelo painel Arquivos da conversa — você NÃO conhece URLs do portal, ' +
        'então NUNCA escreva links de download ("baixe aqui"): indique o nome do arquivo e o painel Arquivos.',
    );
  }
  if (session.mode !== 'ask') {
    blocks.push(
      'Quando o usuário pedir para criar um agente (uma persona reutilizável do portal), use a ' +
        'ferramenta portal_create_agent — agentes são globais e ficam no seletor de agente do chat.',
      'LIMITE POR CHAMADA DE FERRAMENTA: nenhuma chamada pode carregar mais de ~200 linhas de ' +
        'conteúdo. Arquivo longo se escreve SEMPRE em blocos — a primeira chamada de ' +
        'portal_write_file cria o começo e as seguintes continuam com append: true, cada uma com ' +
        'no máximo ~120 linhas. Uma chamada gigante demora minutos para ser transmitida, aparece ' +
        'para o usuário como uma tela parada e pode estourar o tempo limite da rodada.',
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
    // páginas de um site varrido se anunciam pelo site + título, não pelo
    // nome do arquivo gerado (que não diz nada ao modelo nem ao usuário)
    const origin = snippet.collectionName
      ? `${snippet.baseName} · ${snippet.collectionName} — ${snippet.title ?? snippet.docName}`
      : `${snippet.baseName} — ${snippet.docName}`;
    const source = snippet.sourceUrl ? `\nFonte: ${snippet.sourceUrl}` : '';
    blocks.push(`## Base de conhecimento: ${origin}${source}\n${snippet.content}`);
  }
  if (opts.knowledgeIndex?.length) {
    blocks.push(
      '## Bases de conhecimento (índice — conteúdo NÃO carregado)\n' +
        'As bases habilitadas excedem o limite de injeção, então os documentos abaixo NÃO estão ' +
        'neste contexto — só o índice. Sempre que o pedido do usuário tocar nesses assuntos, ' +
        'busque com portal_search_knowledge ANTES de responder e, se os trechos não bastarem, ' +
        'leia o documento com portal_read_knowledge. Nunca responda de memória algo que estas ' +
        'bases documentam, e não invente conteúdo delas.\n' +
        knowledgeIndexLines(opts.knowledgeIndex).join('\n'),
    );
  }
  for (const file of contextFiles ?? []) {
    blocks.push(
      `## Arquivo do projeto fixado no contexto: ${file.path}\n\`\`\`\n${file.content}\n\`\`\``,
    );
  }
  return blocks.join('\n\n');
}

/**
 * Índice das bases, agrupado por site varrido. Um site de documentação vira
 * dezenas de páginas: listadas soltas, viram um paredão de nomes de arquivo
 * indistinguíveis; sob um cabeçalho do site, o modelo entende que são um
 * conjunto e escolhe a página pelo título.
 */
function knowledgeIndexLines(entries: KnowledgeIndexEntry[]): string[] {
  const lines: string[] = [];
  const loose = entries.filter((e) => !e.collectionName);
  for (const e of loose) {
    lines.push(
      `- Base "${e.baseName}" — ${e.docName} (${Math.max(1, Math.round(e.size / 1024))} KB)` +
        (e.headings.length ? `: ${e.headings.join('; ')}` : ''),
    );
  }
  const groups = new Map<string, KnowledgeIndexEntry[]>();
  for (const e of entries) {
    if (!e.collectionName) continue;
    const key = `${e.baseName}\u0000${e.collectionName}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  for (const [key, docs] of groups) {
    const [baseName, collectionName] = key.split('\u0000');
    lines.push(
      `- Base "${baseName}" — site ${collectionName} (${docs.length} página${docs.length === 1 ? '' : 's'}), leia com portal_read_knowledge usando o nome do arquivo:`,
    );
    for (const d of docs) {
      lines.push(`    · ${d.title ?? d.docName} → ${d.docName}${d.sourceUrl ? ` (${d.sourceUrl})` : ''}`);
    }
  }
  return lines;
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

/**
 * Anexos da mensagem viram blocos <anexo> logo após o texto do usuário.
 *
 * `limit` é o total que os anexos de UMA mensagem podem ocupar. Existe porque o
 * portal aceita anexos maiores que a janela dos modelos do Copilot (as CLIs têm
 * janela bem maior) e a mensagem atual é a única que a poda de histórico nunca
 * descarta: sem o corte aqui, um anexo grande derrubaria o turno inteiro com
 * erro de contexto em vez de responder com o que coube.
 */
function attachmentBlocks(message: ChatMessage, limit: number): string {
  const attachments = message.parts.filter(
    (p): p is Extract<typeof p, { type: 'attachment' }> => p.type === 'attachment',
  );
  if (!attachments.length) return '';
  const each = Math.max(4_000, Math.floor(limit / attachments.length));
  return attachments
    .map((p) => {
      // um anexo contendo a tag literal quebraria a delimitação do bloco
      const safe = p.content.replaceAll('</anexo>', '<\\/anexo>');
      const body =
        safe.length <= each
          ? safe
          : `${safe.slice(0, each)}\n\n… (anexo truncado: não cabe na janela deste modelo)`;
      return `<anexo nome="${p.name.replaceAll('"', "'")}">\n${body}\n</anexo>`;
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
}): { messages: vscode.LanguageModelChatMessage[]; prunedCount: number; summarized: boolean } {
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
  // o que os anexos de uma mensagem podem ocupar: o resto da janela fica para o
  // texto do usuário, o histórico próximo e a resposta
  const attachmentLimit = Math.max(8_000, Math.floor(budget * 0.6));
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
  let summarized = false;
  if (startIdx > 0) {
    // se existe um resumo automático cobrindo (parte do) trecho podado, ele
    // entra no lugar da nota seca de omissão — decisões e requisitos antigos
    // continuam disponíveis para o modelo
    const summary = session.historySummary;
    const coveredIdx = summary
      ? session.messages.findIndex((m) => m.id === summary.throughMessageId)
      : -1;
    if (summary && coveredIdx >= 0 && coveredIdx < startIdx) {
      summarized = true;
      const uncovered = startIdx - coveredIdx - 1;
      result.push(
        vscode.LanguageModelChatMessage.User(
          `(As ${startIdx} mensagens mais antigas desta conversa saíram do contexto por limite ` +
            'da janela do modelo. Resumo automático do trecho omitido' +
            (uncovered > 0
              ? ` — as ${uncovered} mensagens omitidas mais recentes ainda não estão cobertas por ele`
              : '') +
            `:)\n\n${summary.summary}`,
        ),
      );
    } else {
      result.push(
        vscode.LanguageModelChatMessage.User(
          `(As ${startIdx} mensagens mais antigas desta conversa foram omitidas por limite de ` +
            'contexto. Se o usuário se referir a algo que você não vê aqui, diga que aquele trecho ' +
            'saiu do contexto e peça para ele repetir a informação.)',
        ),
      );
    }
  }

  for (const message of session.messages.slice(startIdx)) {
    if (message.role === 'user') {
      const text = expandSlashCommand(userText(message), commandSkills);
      const attachments = attachmentBlocks(message, attachmentLimit);
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
  return { messages: result, prunedCount: startIdx, summarized };
}

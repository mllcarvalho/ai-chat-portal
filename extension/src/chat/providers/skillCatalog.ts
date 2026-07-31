import { slugifyCommand, type SkillWithContent } from '@aiportal/shared';
import type { TurnContext } from './types';

/**
 * Catálogo leve das skills que a conversa PODE carregar mas ainda não
 * carregou. Sem ele, os motores de CLI só enxergam as skills ativadas — os
 * `/comando` do portal (inclusive os workflows do BMAD) simplesmente não
 * existiriam para eles, ao contrário do Copilot.
 *
 * Espelha o bloco que o messageBuilder injeta no preâmbulo do Copilot: nome,
 * comando e descrição, com o conteúdo carregado sob demanda por
 * portal_load_skill.
 */
export function skillCatalogBlock(ctx: TurnContext): string | undefined {
  const activeIds = new Set(ctx.instructionSkills.map((s) => s.id));
  const catalog = ctx.commandSkills.filter((s) => !activeIds.has(s.id) && !isDeprecated(s));
  if (!catalog.length) return undefined;

  const linkedIds = new Set(ctx.agent?.skillIds ?? []);
  const hasLinked = catalog.some((s) => linkedIds.has(s.id));

  return (
    '# Catálogo de skills (não carregadas)\n\n' +
    'Estas skills existem no portal mas NÃO estão neste contexto — abaixo só comando, nome e ' +
    'descrição.\n\n' +
    'REGRA: antes de responder QUALQUER pedido, confira esta lista. Se o pedido corresponder à ' +
    'descrição de uma skill, carregue-a com a ferramenta portal_load_skill ANTES de responder e ' +
    'siga as instruções dela — mesmo que o usuário não cite a skill nem escreva /comando, e mesmo ' +
    'que você saiba produzir o resultado sozinho. A skill é que define o processo e o formato que ' +
    'o portal espera: entregar o artefato de cabeça (PRD, épicos, histórias, revisão…) existindo ' +
    'skill para ele conta como resposta ERRADA, por melhor que pareça. Na dúvida entre responder ' +
    'direto e carregar a skill, carregue. Se mais de uma servir, carregue a mais específica. Não ' +
    'invente skills fora desta lista.' +
    (hasLinked
      ? ' Skills marcadas com [skill deste agente] foram vinculadas ao agente desta conversa — ' +
        'dê preferência a elas em caso de empate.'
      : '') +
    '\n\n' +
    catalog.map((s) => describe(s, linkedIds.has(s.id))).join('\n')
  );
}

/**
 * Skills que só existem para redirecionar uma versão antiga do BMAD ficam fora
 * do catálogo: elas competem pelo mesmo pedido que a skill viva (a
 * `bmad-create-prd` e a `bmad-prd` casam ambas com "crie um PRD") e a hesitação
 * entre as duas é justamente o que faz o modelo desistir e responder de cabeça.
 */
function isDeprecated(skill: SkillWithContent): boolean {
  return /^\s*deprecated\b/i.test(skill.name) || /^\s*deprecated\b/i.test(skill.description ?? '');
}

function describe(skill: SkillWithContent, linked: boolean): string {
  const command = skill.command ? `/${skill.command}` : skill.name;
  return `- ${command} — ${skill.name}: ${skill.description}${linked ? ' [skill deste agente]' : ''}`;
}

/**
 * Traduz o `/comando` do portal para uma instrução explícita.
 *
 * Necessário porque as CLIs agênticas têm namespace PRÓPRIO de barra: o
 * `claude -p` com um prompt começando em "/" responde "Unknown command:
 * /bmad-prd" e a mensagem nunca chega ao modelo. Como a barra é a forma que o
 * usuário do portal conhece para invocar skills (e todos os workflows do BMAD
 * são comandos), a tradução acontece aqui em vez de mudar o hábito dele.
 */
export function rewriteSlashCommand(ctx: TurnContext): string {
  const text = ctx.text;
  const match = /^\/([\w-]+)\s*([\s\S]*)$/.exec(text.trim());
  if (!match) return text;

  const [, command, rest] = match;
  const skill = ctx.commandSkills.find((s) => commandOf(s) === command);
  if (!skill) {
    // comando desconhecido: um espaço à frente basta para a CLI não o engolir,
    // e o catálogo no preâmbulo ainda pode fazer o modelo reconhecê-lo
    return ` ${text}`;
  }

  return (
    `O usuário invocou o comando /${command} do portal, que corresponde à skill "${skill.name}". ` +
    `Carregue-a com a ferramenta portal_load_skill (command: "${command}"` +
    (rest.trim() ? `, input: o pedido abaixo` : '') +
    `) ANTES de responder, e então siga as instruções dela.` +
    (rest.trim() ? `\n\nPedido do usuário para a skill:\n${rest.trim()}` : '')
  );
}

function commandOf(skill: SkillWithContent): string {
  return skill.command ?? slugifyCommand(skill.name);
}

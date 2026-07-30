import type { SkillWithContent } from '@aiportal/shared';
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
  const catalog = ctx.commandSkills.filter((s) => !activeIds.has(s.id));
  if (!catalog.length) return undefined;

  const linkedIds = new Set(ctx.agent?.skillIds ?? []);
  const hasLinked = catalog.some((s) => linkedIds.has(s.id));

  return (
    '# Catálogo de skills (não carregadas)\n\n' +
    'Estas skills existem no portal mas NÃO estão neste contexto — abaixo só comando, nome e ' +
    'descrição. Sempre que o pedido do usuário corresponder à descrição de uma skill, carregue-a ' +
    'com a ferramenta portal_load_skill ANTES de responder e siga as instruções dela. O usuário ' +
    'também pode invocá-las escrevendo /comando. Se mais de uma servir, carregue a mais ' +
    'específica. Não invente skills fora desta lista.' +
    (hasLinked
      ? ' Skills marcadas com [skill deste agente] foram vinculadas ao agente desta conversa — ' +
        'dê preferência a elas em caso de empate.'
      : '') +
    '\n\n' +
    catalog.map((s) => describe(s, linkedIds.has(s.id))).join('\n')
  );
}

function describe(skill: SkillWithContent, linked: boolean): string {
  const command = skill.command ? `/${skill.command}` : skill.name;
  return `- ${command} — ${skill.name}: ${skill.description}${linked ? ' [skill deste agente]' : ''}`;
}

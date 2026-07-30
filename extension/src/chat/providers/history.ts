import type { ChatMessage } from '@aiportal/shared';
import type { TurnContext } from './types';

/**
 * Transcrição do histórico da conversa para reenviar a uma CLI que perdeu a
 * sessão do lado dela.
 *
 * Necessário no editar/regenerar: o portal apaga as mensagens a partir do
 * ponto editado, mas a sessão da CLI (retomada com --resume) continuaria com
 * o trecho removido — o modelo "lembraria" do que o usuário acabou de apagar.
 * A saída é começar uma sessão nova; para ela não nascer sem contexto, o
 * histórico que SOBROU volta como transcrição.
 */

/** Teto do replay — conversa longa não pode estourar o prompt. */
const REPLAY_CLAMP = 48 * 1024;
const PART_CLAMP = 4 * 1024;

function clamp(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncado)`;
}

function describe(message: ChatMessage): string[] {
  const label = message.role === 'user' ? 'Usuário' : 'Assistente';
  const lines: string[] = [];
  for (const part of message.parts) {
    if (part.type === 'text' && part.text.trim()) {
      lines.push(`${label}: ${clamp(part.text.trim(), PART_CLAMP)}`);
    } else if (part.type === 'attachment') {
      lines.push(`${label} anexou: ${part.name}`);
    } else if (part.type === 'tool_call') {
      // o resultado não volta: o que importa é o modelo saber o que já foi feito
      lines.push(`Assistente usou a ferramenta ${part.toolName}.`);
    }
  }
  return lines;
}

/**
 * Bloco de histórico para o primeiro turno de uma sessão nova da CLI.
 * `undefined` quando não há nada antes da mensagem atual (conversa nova de
 * verdade), que é o caso comum.
 */
export function historyReplayBlock(ctx: TurnContext): string | undefined {
  // o shell já anexou a mensagem deste turno: ela não entra no replay
  const previous = ctx.session.messages.slice(0, -1);
  if (!previous.length) return undefined;
  const lines = previous.flatMap(describe);
  if (!lines.length) return undefined;
  return (
    '# Histórico da conversa\n\n' +
    'Esta conversa já vinha acontecendo. O trecho abaixo é o que ficou dela ' +
    '(o usuário pode ter editado uma mensagem anterior, descartando o que veio depois). ' +
    'Considere-o o estado atual e siga a partir dele.\n\n' +
    clamp(lines.join('\n'), REPLAY_CLAMP)
  );
}

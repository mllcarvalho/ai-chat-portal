import * as vscode from 'vscode';
import type { LmWireMessage, LmWirePart } from '@aiportal/shared';

/**
 * Serialização das mensagens do modelo para atravessar a ponte da federação.
 * Os dois lados rodam o MESMO código da extensão, então dá para reconstruir os
 * objetos `vscode.LanguageModel*Part` fielmente do outro lado.
 */

export function serializeMessages(messages: vscode.LanguageModelChatMessage[]): LmWireMessage[] {
  return messages.map((msg) => {
    const role: 'user' | 'assistant' =
      msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
    const parts: LmWirePart[] = [];
    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        parts.push({ kind: 'text', text: part.value });
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        parts.push({ kind: 'tool_call', callId: part.callId, name: part.name, input: part.input });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        // o result é um array de parts; no portal só geramos texto
        const text = part.content
          .map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : ''))
          .join('');
        parts.push({ kind: 'tool_result', callId: part.callId, content: text });
      }
    }
    return { role, parts };
  });
}

export function deserializeMessages(wire: LmWireMessage[]): vscode.LanguageModelChatMessage[] {
  return wire.map((msg) => {
    const content: Array<
      | vscode.LanguageModelTextPart
      | vscode.LanguageModelToolCallPart
      | vscode.LanguageModelToolResultPart
    > = [];
    for (const part of msg.parts) {
      if (part.kind === 'text') {
        content.push(new vscode.LanguageModelTextPart(part.text));
      } else if (part.kind === 'tool_call') {
        content.push(
          new vscode.LanguageModelToolCallPart(part.callId, part.name, part.input as object),
        );
      } else {
        content.push(
          new vscode.LanguageModelToolResultPart(part.callId, [
            new vscode.LanguageModelTextPart(part.content),
          ]),
        );
      }
    }
    // o portal só produz User(text|tool_result) e Assistant(text|tool_call);
    // o cast evita a união larga que os overloads do vscode não aceitam juntos
    return msg.role === 'assistant'
      ? vscode.LanguageModelChatMessage.Assistant(content as never)
      : vscode.LanguageModelChatMessage.User(content as never);
  });
}

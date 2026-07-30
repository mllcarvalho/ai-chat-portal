import type * as vscode from 'vscode';

/**
 * O consentimento do Copilot (`canSendRequest`) só é legível pelo
 * ExtensionContext, que nasce na ativação. As rotas recebem o contexto por
 * injeção, mas os providers de chat não são criados por rota — guardar a
 * referência aqui evita arrastar o contexto por toda a cadeia só para uma
 * consulta booleana.
 */
let extensionContext: vscode.ExtensionContext | undefined;

export function setExtensionContext(context: vscode.ExtensionContext): void {
  extensionContext = context;
}

/** undefined = contexto ainda não registrado ou consentimento desconhecido. */
export function canSendRequest(model: vscode.LanguageModelChat): boolean | undefined {
  return extensionContext?.languageModelAccessInformation.canSendRequest(model);
}

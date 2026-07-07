import * as vscode from 'vscode';
import type { EditorContext } from '@aiportal/shared';
import { Router, sendJson } from '../router';

/** Mesmo teto dos anexos do chat (o servidor recusa acima de 512 KB). */
const MAX_CHARS = 512 * 1024;

export function registerEditorRoutes(router: Router): void {
  // arquivo/seleção ativos na janela do VS Code que hospeda o portal
  router.get('/api/editor/context', ({ res }) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme === 'output') {
      sendJson(res, 200, {} satisfies EditorContext);
      return;
    }
    const doc = editor.document;
    const selection = editor.selection.isEmpty ? undefined : editor.selection;
    const text = selection ? doc.getText(selection) : doc.getText();
    const context: EditorContext = {
      file: {
        name: doc.fileName.split(/[\\/]/).pop() ?? 'arquivo',
        languageId: doc.languageId,
        ...(selection
          ? { startLine: selection.start.line + 1, endLine: selection.end.line + 1 }
          : {}),
        content: text.slice(0, MAX_CHARS),
        truncated: text.length > MAX_CHARS,
      },
    };
    sendJson(res, 200, context);
  });
}

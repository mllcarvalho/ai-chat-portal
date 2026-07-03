import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Compartilhamento por email de um artefato exportado (zip/md). Links mailto:
 * não carregam anexo, então a estratégia é abrir o cliente de email já com o
 * arquivo anexado do jeito que cada plataforma permite:
 *   - macOS: `open -a <app> <arquivo>` (equivale a arrastar para o Dock) —
 *     Outlook e Apple Mail criam uma mensagem nova com o anexo;
 *   - Windows: `start outlook.exe /a <arquivo>` (Outlook clássico);
 *   - Linux: `xdg-email --attach`.
 * Se nada disso existir (ex.: "novo Outlook" do Windows, sem CLI de anexo),
 * cai no plano manual: salva o arquivo, abre a pasta com ele selecionado e um
 * rascunho mailto — o usuário só arrasta o anexo.
 */

export type EmailShareMode = 'outlook' | 'mail' | 'xdg' | 'manual';

function tryExec(cmd: string, args: string[], verbatim = false): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000, windowsVerbatimArguments: verbatim }, (err) =>
      resolve(!err),
    );
  });
}

export async function shareByEmail(
  fileName: string,
  data: Buffer,
  subject: string,
): Promise<{ mode: EmailShareMode; file: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiportal-email-'));
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, data);

  if (process.platform === 'darwin') {
    // Outlook primeiro (cenário corporativo); sem ele, o Mail nativo
    if (await tryExec('open', ['-a', 'Microsoft Outlook', file])) return { mode: 'outlook', file };
    if (await tryExec('open', ['-a', 'Mail', file])) return { mode: 'mail', file };
  } else if (process.platform === 'win32') {
    const started = await tryExec(
      'cmd.exe',
      ['/d', '/s', '/c', `start "" outlook.exe /a "${file}"`],
      true,
    );
    if (started) return { mode: 'outlook', file };
  } else {
    if (await tryExec('xdg-email', ['--subject', subject, '--attach', file])) {
      return { mode: 'xdg', file };
    }
  }

  // plano manual: pasta aberta com o arquivo selecionado + rascunho sem anexo
  try {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
  } catch {
    // sem reveal, o caminho completo vai na resposta para a UI mostrar
  }
  void vscode.env.openExternal(
    vscode.Uri.parse(`mailto:?subject=${encodeURIComponent(subject)}`),
  );
  return { mode: 'manual', file };
}

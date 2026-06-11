import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildPortalUrl, clearRuntime, writeRuntime } from './authToken';
import { registerMcpProvider } from './mcpProvider';
import { startServer } from './server/httpServer';
import { buildRouter } from './server/routes/index';
import { loadConfig } from './storage/configStore';
import { withTimeout } from './util';

let portalUrl: string | undefined;

async function doWarmup(context: vscode.ExtensionContext): Promise<void> {
  const models = await withTimeout(
    vscode.lm.selectChatModels({ vendor: 'copilot' }),
    10000,
    [] as readonly vscode.LanguageModelChat[],
  );
  if (!models.length) {
    void vscode.window.showWarningMessage(
      'AI Chat Portal: nenhum modelo do Copilot disponível. Verifique se o GitHub Copilot Chat está instalado e logado.',
    );
    return;
  }
  try {
    // requisição mínima só para disparar o diálogo de consentimento do VS Code
    const response = await models[0].sendRequest(
      [vscode.LanguageModelChatMessage.User('Responda apenas: ok')],
      { justification: 'Autorizar o AI Chat Portal a usar o Copilot' },
    );
    for await (const _ of response.text) {
      break;
    }
    await context.globalState.update('warmupDone', true);
    void vscode.window.showInformationMessage(
      'AI Chat Portal autorizado a usar o Copilot. Pode voltar para o navegador.',
    );
  } catch (err) {
    if (err instanceof vscode.LanguageModelError && err.code === 'NoPermissions') {
      void vscode.window.showWarningMessage(
        'AI Chat Portal: permissão negada para usar o Copilot.',
      );
    } else {
      throw err;
    }
  }
}

function maybeOfferWarmup(context: vscode.ExtensionContext): void {
  if (context.globalState.get('warmupDone')) return;
  const offer = async () => {
    const models = await withTimeout(
      vscode.lm.selectChatModels({ vendor: 'copilot' }),
      10000,
      [] as readonly vscode.LanguageModelChat[],
    );
    if (!models.length) return false;
    if (models.some((m) => context.languageModelAccessInformation.canSendRequest(m) === true)) {
      await context.globalState.update('warmupDone', true);
      return true;
    }
    const choice = await vscode.window.showInformationMessage(
      'O AI Chat Portal precisa da sua autorização para usar os modelos do Copilot.',
      'Autorizar',
    );
    if (choice === 'Autorizar') await doWarmup(context);
    return true;
  };
  void offer().then((hadModels) => {
    if (!hadModels) {
      // modelos podem demorar a aparecer após o startup
      const listener = vscode.lm.onDidChangeChatModels(() => {
        listener.dispose();
        void offer();
      });
      context.subscriptions.push(listener);
    }
  });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = loadConfig();
  const version = (context.extension.packageJSON as { version: string }).version;

  registerMcpProvider(context);

  const router = buildRouter({ context, version });
  const mediaDir = path.join(context.extensionPath, 'media');
  const result = await startServer(router, { config, version, mediaDir });

  if (result) {
    portalUrl = buildPortalUrl(result.port, config.token);
    writeRuntime(result.port, config.token, version);
    context.subscriptions.push({
      dispose: () => {
        result.server.close();
        clearRuntime();
      },
    });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('aiChatPortal.openInBrowser', () => {
      if (portalUrl) {
        void vscode.env.openExternal(vscode.Uri.parse(portalUrl));
      } else {
        void vscode.window.showWarningMessage(
          'AI Chat Portal: o servidor está ativo em outra janela do VS Code.',
        );
      }
    }),
    vscode.commands.registerCommand('aiChatPortal.copyUrl', async () => {
      if (portalUrl) {
        await vscode.env.clipboard.writeText(portalUrl);
        void vscode.window.showInformationMessage('URL do portal copiada.');
      } else {
        void vscode.window.showWarningMessage(
          'AI Chat Portal: o servidor está ativo em outra janela do VS Code.',
        );
      }
    }),
    vscode.commands.registerCommand('aiChatPortal.warmup', () => doWarmup(context)),
  );

  maybeOfferWarmup(context);
}

export function deactivate(): void {
  clearRuntime();
}

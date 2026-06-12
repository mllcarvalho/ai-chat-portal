import * as vscode from 'vscode';
import type { MeInfo } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import { withTimeout } from '../../util';
import type { RouteDeps } from './index';

export function registerAuthRoutes(router: Router, deps: RouteDeps): void {
  router.get('/api/me', async ({ res }) => {
    const session = await withTimeout(
      vscode.authentication.getSession('github', [], { silent: true }),
      5000,
      undefined,
    );
    let label = session?.account.label;
    if (!label) {
      const accounts = await withTimeout(
        vscode.authentication.getAccounts('github'),
        3000,
        [] as readonly vscode.AuthenticationSessionAccountInformation[],
      );
      label = accounts[0]?.label;
    }
    if (!label) {
      sendError(res, 404, 'Nenhuma conta GitHub conectada no VS Code');
      return;
    }
    const me: MeInfo = {
      login: label,
      label,
      avatarUrl: `https://github.com/${encodeURIComponent(label)}.png?size=64`,
    };
    sendJson(res, 200, me);
  });

  router.post('/api/warmup', async ({ res }) => {
    const models = await withTimeout(
      vscode.lm.selectChatModels({ vendor: 'copilot' }),
      5000,
      [] as readonly vscode.LanguageModelChat[],
    );
    const authorized = models.some(
      (m) => deps.context.languageModelAccessInformation.canSendRequest(m) === true,
    );
    if (authorized) {
      sendJson(res, 200, { ok: true, alreadyAuthorized: true });
      return;
    }
    // o diálogo de consentimento precisa partir de uma ação do usuário no VS Code
    void vscode.window
      .showInformationMessage(
        'O AI Product BMAD Chat precisa da sua autorização para usar o Copilot.',
        'Autorizar',
      )
      .then((choice) => {
        if (choice === 'Autorizar') {
          void vscode.commands.executeCommand('aiChatPortal.warmup');
        }
      });
    sendJson(res, 200, { ok: true, needsUserAction: true });
  });
}

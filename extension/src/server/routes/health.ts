import * as vscode from 'vscode';
import type { HealthInfo } from '@aiportal/shared';
import { Router, sendJson } from '../router';
import { withTimeout } from '../../util';
import { getPortalRoot } from '../../storage/paths';
import { envCheckDone, getEnvStatus } from '../../tools/envCheck';
import type { RouteDeps } from './index';

export function registerHealthRoutes(router: Router, deps: RouteDeps): void {
  router.get('/api/health', async ({ res }) => {
    const copilotChatInstalled = !!vscode.extensions.getExtension('GitHub.copilot-chat');
    const models = await withTimeout(
      vscode.lm.selectChatModels({ vendor: 'copilot' }),
      3000,
      [] as readonly vscode.LanguageModelChat[],
    );
    let account: HealthInfo['account'];
    const accounts = await withTimeout(
      vscode.authentication.getAccounts('github'),
      3000,
      [] as readonly vscode.AuthenticationSessionAccountInformation[],
    );
    if (accounts.length) account = { id: accounts[0].id, label: accounts[0].label };
    const needsConsent =
      models.length > 0 &&
      !models.some(
        (m) => deps.context.languageModelAccessInformation.canSendRequest(m) === true,
      );
    const health: HealthInfo = {
      ok: copilotChatInstalled && models.length > 0,
      version: deps.version,
      buildId: deps.buildId,
      hasPortalRoot: !!getPortalRoot(),
      copilotChatInstalled,
      modelCount: models.length,
      account,
      needsConsent,
      // omitido até a detecção da ativação terminar (evita aviso falso na UI)
      ...(envCheckDone() ? { env: getEnvStatus() } : {}),
    };
    sendJson(res, 200, health);
  });

  // Outra janela com build mais novo (ou com o repo do portal) pede para esta sair
  router.post('/api/shutdown', ({ res }) => {
    sendJson(res, 200, { ok: true });
    setTimeout(() => deps.requestShutdown(), 50);
  });
}

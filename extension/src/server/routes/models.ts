import * as vscode from 'vscode';
import type { ModelInfo } from '@aiportal/shared';
import { Router, sendJson } from '../router';
import { withTimeout } from '../../util';
import type { RouteDeps } from './index';

export function registerModelRoutes(router: Router, deps: RouteDeps): void {
  router.get('/api/models', async ({ res }) => {
    const models = await withTimeout(
      vscode.lm.selectChatModels({ vendor: 'copilot' }),
      10000,
      [] as readonly vscode.LanguageModelChat[],
    );
    const infos: ModelInfo[] = models.map((m) => ({
      id: m.id,
      name: m.name,
      family: m.family,
      vendor: m.vendor,
      version: m.version,
      maxInputTokens: m.maxInputTokens,
      canSend: deps.context.languageModelAccessInformation.canSendRequest(m),
    }));
    sendJson(res, 200, infos);
  });
}

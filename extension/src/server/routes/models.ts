import * as vscode from 'vscode';
import type { ModelInfo } from '@aiportal/shared';
import { Router, sendJson } from '../router';
import { withTimeout } from '../../util';
import { getModelBilling, type ModelBilling } from './copilot';
import type { RouteDeps } from './index';

export function registerModelRoutes(router: Router, deps: RouteDeps): void {
  router.get('/api/models', async ({ res }) => {
    const models = await withTimeout(
      vscode.lm.selectChatModels({ vendor: 'copilot' }),
      10000,
      [] as readonly vscode.LanguageModelChat[],
    );
    // billing é cosmético (credits na UI): qualquer falha só omite os campos
    let billing: Map<string, ModelBilling> | undefined;
    try {
      billing = await getModelBilling();
    } catch (err) {
      console.error('[ai-chat-portal] billing indisponível:', err instanceof Error ? err.message : err);
      billing = undefined;
    }
    const infos: ModelInfo[] = models.map((m) => {
      const cost = billing?.get(m.id.toLowerCase()) ?? billing?.get(m.name.toLowerCase());
      return {
        id: m.id,
        name: m.name,
        family: m.family,
        vendor: m.vendor,
        version: m.version,
        maxInputTokens: m.maxInputTokens,
        canSend: deps.context.languageModelAccessInformation.canSendRequest(m),
        ...(cost?.premium !== undefined ? { premium: cost.premium } : {}),
        ...(cost?.multiplier !== undefined ? { multiplier: cost.multiplier } : {}),
        ...(cost?.priceCategory ? { priceCategory: cost.priceCategory } : {}),
      };
    });
    sendJson(res, 200, infos);
  });
}

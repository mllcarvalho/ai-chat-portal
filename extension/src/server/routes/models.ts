import type { ModelInfo, ProviderId } from '@aiportal/shared';
import { Router, sendJson } from '../router';
import { describeProviders, listProviders, resolveProvider } from '../../chat/providers';

export function registerModelRoutes(router: Router): void {
  // ?provider=<id> restringe a um provider; sem filtro, junta todos (o
  // seletor da UI agrupa pelo campo `provider` de cada modelo)
  router.get('/api/models', async ({ res, query }) => {
    const wanted = query.get('provider') as ProviderId | null;
    const providers = wanted ? [resolveProvider(wanted)] : listProviders();
    const lists = await Promise.all(
      providers.map(async (p) => {
        try {
          return await p.listModels();
        } catch (err) {
          // um provider fora do ar não pode esconder os modelos dos outros
          console.error(
            `[ai-chat-portal] modelos de ${p.id} indisponíveis:`,
            err instanceof Error ? err.message : err,
          );
          return [] as ModelInfo[];
        }
      }),
    );
    sendJson(res, 200, lists.flat());
  });

  router.get('/api/providers', async ({ res }) => {
    sendJson(res, 200, await describeProviders());
  });
}

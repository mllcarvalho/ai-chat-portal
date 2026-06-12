import * as vscode from 'vscode';
import type { CopilotQuota } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import { withTimeout } from '../../util';

/**
 * Endpoint interno usado pelo próprio Copilot (é o mesmo que alimenta o ícone
 * no VS Code). Não é API pública: se o formato mudar, a UI só esconde o badge.
 */
const QUOTA_URL = 'https://api.github.com/copilot_internal/user';
const TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const MODELS_URL = 'https://api.githubcopilot.com/models';
const CACHE_TTL = 30_000;
/** Multiplicadores mudam raramente; cache mais longo. */
const BILLING_TTL = 10 * 60_000;

interface QuotaSnapshot {
  entitlement?: number;
  /** Inteiro truncado; preferir quota_remaining, que vem com casas decimais. */
  remaining?: number;
  quota_remaining?: number;
  percent_remaining?: number;
  unlimited?: boolean;
  overage_count?: number;
  overage_permitted?: boolean;
}

interface CopilotUserResponse {
  copilot_plan?: string;
  quota_reset_date?: string;
  quota_snapshots?: { premium_interactions?: QuotaSnapshot };
}

/** Custo em AI credits de um modelo (multiplicador de premium request). */
export interface ModelBilling {
  premium?: boolean;
  multiplier?: number;
  /** Faixa de preço do model picker ("high"/"medium"/...), quando a API não dá o multiplicador. */
  priceCategory?: string;
}

interface CopilotTokenResponse {
  token?: string;
  /** Epoch em segundos. */
  expires_at?: number;
}

interface InternalModel {
  id?: string;
  name?: string;
  billing?: { is_premium?: boolean; multiplier?: number };
  model_picker_price_category?: string;
}

/** O CAPI versiona a resposta: sem este header, os modelos vêm sem `billing`. */
const CAPI_API_VERSION = '2026-06-01';

/** Mesma identidade de plugin do Copilot Chat embutido (alguns campos são gated por ela). */
function editorPluginVersion(): string {
  const ext = vscode.extensions.getExtension('github.copilot-chat');
  const version = (ext?.packageJSON as { version?: string } | undefined)?.version;
  return `copilot-chat/${version ?? '0.52.0'}`;
}

/** Mesmo escopo que o Copilot usa; um conjunto diferente criaria outra sessão. */
const GITHUB_SCOPES = ['read:user'];

let cache: { at: number; data: CopilotQuota } | undefined;
let copilotToken: { token: string; expiresAt: number } | undefined;
let billingCache: { at: number; data: Map<string, ModelBilling> } | undefined;
let consentPending = false;

/**
 * `silent: true` nunca abre o diálogo de consentimento, então enquanto o
 * usuário não autorizar a extensão a usar a conta GitHub a sessão vem vazia
 * mesmo com a conta conectada. Como a chamada parte do navegador (sem gesto
 * no VS Code), o consentimento é pedido por notificação, uma vez só.
 */
function requestGithubConsent(): void {
  if (consentPending) return;
  consentPending = true;
  void vscode.window
    .showInformationMessage(
      'O AI Chat Portal precisa de acesso à sua conta GitHub para mostrar os AI credits do Copilot.',
      'Autorizar',
    )
    .then(async (choice) => {
      try {
        if (choice !== 'Autorizar') return;
        await vscode.authentication.getSession('github', GITHUB_SCOPES, { createIfNone: true });
        // força refetch com a sessão recém-autorizada
        cache = undefined;
        copilotToken = undefined;
        billingCache = undefined;
      } catch {
        // usuário cancelou o diálogo do VS Code
      } finally {
        consentPending = false;
      }
    });
}

async function githubSessionToken(): Promise<string> {
  const session = await withTimeout(
    vscode.authentication.getSession('github', GITHUB_SCOPES, { silent: true }),
    5000,
    undefined,
  );
  if (!session) {
    requestGithubConsent();
    throw new Error(
      'Autorize o AI Chat Portal a acessar sua conta GitHub na janela do VS Code (notificação no canto inferior direito)',
    );
  }
  return session.accessToken;
}

/** Troca o token da conta GitHub pelo token de API do Copilot (curta duração). */
async function fetchCopilotToken(): Promise<string> {
  if (copilotToken && Date.now() < copilotToken.expiresAt) return copilotToken.token;
  const res = await fetch(TOKEN_URL, {
    headers: {
      Authorization: `token ${await githubSessionToken()}`,
      Accept: 'application/json',
      'User-Agent': 'AIChatPortal',
      'Editor-Version': `vscode/${vscode.version}`,
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub respondeu ${res.status} ao obter o token do Copilot`);
  const data = (await res.json()) as CopilotTokenResponse;
  if (!data.token) throw new Error('GitHub não retornou um token do Copilot');
  copilotToken = {
    token: data.token,
    expiresAt: (data.expires_at ? data.expires_at * 1000 : Date.now() + BILLING_TTL) - 60_000,
  };
  return copilotToken.token;
}

/** Resposta crua de GET /models, para o caminho normal e para o debug. */
async function fetchModelsRaw(): Promise<{ status: number; body: string }> {
  const res = await fetch(MODELS_URL, {
    headers: {
      Authorization: `Bearer ${await fetchCopilotToken()}`,
      Accept: 'application/json',
      'User-Agent': 'AIChatPortal',
      'Editor-Version': `vscode/${vscode.version}`,
      'Editor-Plugin-Version': editorPluginVersion(),
      'Copilot-Integration-Id': 'vscode-chat',
      'X-GitHub-Api-Version': CAPI_API_VERSION,
    },
    signal: AbortSignal.timeout(8000),
  });
  return { status: res.status, body: await res.text() };
}

function parseInternalModels(body: string): InternalModel[] {
  const data = JSON.parse(body) as { data?: InternalModel[] } | InternalModel[];
  return Array.isArray(data) ? data : (data.data ?? []);
}

/**
 * Multiplicador de AI credits por modelo, indexado por id e nome em minúsculas.
 * Mesmo aviso do quota: endpoint interno — se mudar, os credits somem da UI.
 */
export async function getModelBilling(): Promise<Map<string, ModelBilling>> {
  if (billingCache && Date.now() - billingCache.at < BILLING_TTL) return billingCache.data;
  const raw = await fetchModelsRaw();
  if (raw.status !== 200) throw new Error(`Copilot respondeu ${raw.status} ao listar os modelos`);
  const map = new Map<string, ModelBilling>();
  for (const model of parseInternalModels(raw.body)) {
    // multiplier/is_premium sumiram da API em 2026 (preço virou por token);
    // ficam só quando presentes, sem default — a UI cai no priceCategory
    const billing: ModelBilling = {
      ...(model.billing?.is_premium !== undefined ? { premium: model.billing.is_premium } : {}),
      ...(model.billing?.multiplier !== undefined ? { multiplier: model.billing.multiplier } : {}),
      ...(model.model_picker_price_category
        ? { priceCategory: model.model_picker_price_category }
        : {}),
    };
    if (!Object.keys(billing).length) continue;
    if (model.id) map.set(model.id.toLowerCase(), billing);
    if (model.name) map.set(model.name.toLowerCase(), billing);
  }
  billingCache = { at: Date.now(), data: map };
  return map;
}

async function fetchQuota(): Promise<CopilotQuota> {
  const res = await fetch(QUOTA_URL, {
    headers: {
      Authorization: `token ${await githubSessionToken()}`,
      Accept: 'application/json',
      'User-Agent': 'AIChatPortal',
      'Editor-Version': `vscode/${vscode.version}`,
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub respondeu ${res.status} ao consultar a cota do Copilot`);
  const data = (await res.json()) as CopilotUserResponse;

  const premium = data.quota_snapshots?.premium_interactions;
  return {
    plan: data.copilot_plan,
    resetDate: data.quota_reset_date,
    ...(premium
      ? {
          premium: {
            entitlement: premium.entitlement ?? 0,
            remaining: premium.quota_remaining ?? premium.remaining ?? 0,
            percentRemaining: premium.percent_remaining ?? 0,
            unlimited: premium.unlimited ?? false,
            overageCount: premium.overage_count ?? 0,
            overagePermitted: premium.overage_permitted ?? false,
          },
        }
      : {}),
  };
}

/**
 * Credits restantes da licença, com fetch fresco (sem cache). Nunca rejeita:
 * undefined cobre plano ilimitado, falha de rede ou sessão não autorizada.
 * Atualiza o cache para a UI pegar carona no valor recém-buscado.
 */
export async function creditsRemaining(): Promise<number | undefined> {
  try {
    const data = await fetchQuota();
    cache = { at: Date.now(), data };
    const premium = data.premium;
    if (!premium || premium.unlimited) return undefined;
    return premium.remaining;
  } catch {
    return undefined;
  }
}

export function registerCopilotRoutes(router: Router): void {
  /**
   * Diagnóstico da cadeia de billing (sessão → token → /models → match com os
   * modelos do vscode.lm). Cada etapa reporta 'ok' ou a mensagem de erro; o
   * corpo cru entra quando nenhum modelo traz `billing`, para ver o formato.
   */
  router.get('/api/copilot/billing-debug', async ({ res }) => {
    const report: Record<string, unknown> = {};
    try {
      await githubSessionToken();
      report.session = 'ok';
      await fetchCopilotToken();
      report.tokenExchange = 'ok';
      const raw = await fetchModelsRaw();
      report.modelsFetch = `HTTP ${raw.status}`;
      const internal = raw.status === 200 ? parseInternalModels(raw.body) : [];
      report.internal = internal.map((m) => ({
        id: m.id,
        name: m.name,
        billing: m.billing,
        priceCategory: m.model_picker_price_category,
      }));
      if (!internal.some((m) => m.billing)) report.rawBodyHead = raw.body.slice(0, 800);
      billingCache = undefined; // garante match com dados recém-buscados
      const map = await getModelBilling().catch((err) => {
        report.billingError = err instanceof Error ? err.message : String(err);
        return undefined;
      });
      const lmModels = await withTimeout(
        vscode.lm.selectChatModels({ vendor: 'copilot' }),
        10000,
        [] as readonly vscode.LanguageModelChat[],
      );
      report.match = lmModels.map((m) => ({
        id: m.id,
        name: m.name,
        family: m.family,
        billing: map?.get(m.id.toLowerCase()) ?? map?.get(m.name.toLowerCase()) ?? null,
      }));
    } catch (err) {
      report.failedWith = err instanceof Error ? err.message : String(err);
    }
    sendJson(res, 200, report);
  });

  router.get('/api/copilot/quota', async ({ res, query }) => {
    const fresh = query.get('fresh') === '1';
    if (!fresh && cache && Date.now() - cache.at < CACHE_TTL) {
      sendJson(res, 200, cache.data);
      return;
    }
    try {
      const data = await fetchQuota();
      cache = { at: Date.now(), data };
      sendJson(res, 200, data);
    } catch (err) {
      sendError(res, 502, err instanceof Error ? err.message : 'Falha ao consultar AI credits');
    }
  });
}

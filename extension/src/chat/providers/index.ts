import { DEFAULT_PROVIDER, type ProviderId, type ProviderInfo } from '@aiportal/shared';
import type { ChatProvider } from './types';
import { copilotProvider } from './copilotProvider';
import { claudeCodeProvider } from './claudeCodeProvider';
import { devinProvider } from './devinProvider';

/** Ordem do seletor da UI. */
const PROVIDERS: ChatProvider[] = [copilotProvider, claudeCodeProvider, devinProvider];

const BY_ID = new Map<ProviderId, ChatProvider>(PROVIDERS.map((p) => [p.id, p]));

/**
 * Provider de uma conversa. Sessão gravada com um provider que não existe
 * mais (downgrade do portal, provider removido) cai no padrão em vez de
 * quebrar a conversa.
 */
export function resolveProvider(id: ProviderId | undefined): ChatProvider {
  return BY_ID.get(id ?? DEFAULT_PROVIDER) ?? BY_ID.get(DEFAULT_PROVIDER)!;
}

export function listProviders(): ChatProvider[] {
  return PROVIDERS;
}

/**
 * Detectar motor custa I/O (spawn de CLI), e o /api/health é consultado a
 * cada 3s na tela de entrada — sem cache seria um processo novo por segundo.
 * A janela é curta de propósito: quem está na tela de entrada acabou de
 * instalar algo e quer ver o check virar verde sem recarregar a página.
 */
const DETECT_TTL_MS = 20_000;
let cache: { at: number; value: ProviderInfo[] } | undefined;
/** Chamadas concorrentes compartilham a mesma detecção em vez de duplicá-la. */
let inFlight: Promise<ProviderInfo[]> | undefined;

/** Disponibilidade de todos os providers, em paralelo (cada um tem seu I/O). */
export async function describeProviders(force = false): Promise<ProviderInfo[]> {
  if (!force && cache && Date.now() - cache.at < DETECT_TTL_MS) return cache.value;
  if (!force && inFlight) return inFlight;
  inFlight = detectAll()
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}

/** Há algum motor pronto para responder? É o que decide a entrada no portal. */
export async function anyProviderAvailable(): Promise<boolean> {
  return (await describeProviders()).some((p) => p.available);
}

/**
 * Motor de uma conversa nova. Numa máquina só com Claude Code, cair no
 * padrão fixo criaria conversas apontando para um Copilot que não responde —
 * então o padrão é o primeiro motor que de fato funciona, preferindo o
 * histórico (Copilot) quando ele está disponível.
 */
export async function defaultProviderId(): Promise<ProviderId> {
  const infos = await describeProviders();
  if (infos.find((p) => p.id === DEFAULT_PROVIDER)?.available) return DEFAULT_PROVIDER;
  return infos.find((p) => p.available)?.id ?? DEFAULT_PROVIDER;
}

async function detectAll(): Promise<ProviderInfo[]> {
  return Promise.all(
    PROVIDERS.map(async (p) => {
      try {
        return await p.describe();
      } catch (err) {
        return {
          id: p.id,
          label: p.id,
          available: false,
          detail: err instanceof Error ? err.message : String(err),
          capabilities: {
            skills: false,
            knowledge: false,
            mcp: false,
            toolToggles: false,
            agents: false,
            modes: false,
            contextFiles: false,
            cost: false,
          },
        } satisfies ProviderInfo;
      }
    }),
  );
}

export type { ChatProvider, TurnContext, TurnResult } from './types';

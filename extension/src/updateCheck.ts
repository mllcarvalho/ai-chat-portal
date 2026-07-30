import { requestInitFor } from './tools/netEnv';

/**
 * Aviso de versão nova: consulta o npm (1x por dia, em background) e compara
 * com a versão instalada. O resultado entra no /api/health e vira um banner
 * dispensável na UI — sem isso cada colega fica para sempre na versão que
 * instalou, tomando erro que já foi corrigido.
 */

/** Pacote npm do instalador deste canal — é o que o usuário roda via npx. */
const INSTALLER_PACKAGE = 'bmad-product-studio-beta';
export const UPDATE_COMMAND = `npx ${INSTALLER_PACKAGE}@latest`;

const TTL_MS = 24 * 60 * 60 * 1000;

let cache: { latest: string | null; at: number } | undefined;
let inflight: Promise<void> | undefined;

function newerThan(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff > 0;
  }
  return false;
}

async function refresh(): Promise<void> {
  const url = `https://registry.npmjs.org/${INSTALLER_PACKAGE}/latest`;
  try {
    const res = await fetch(url, {
      ...requestInitFor(url, { Accept: 'application/json' }),
      signal: AbortSignal.timeout(10_000),
    } as RequestInit);
    const data = res.ok ? ((await res.json()) as { version?: unknown }) : undefined;
    cache = { latest: typeof data?.version === 'string' ? data.version : null, at: Date.now() };
  } catch {
    // sem rede/registry: registra a tentativa para só reconsultar amanhã
    cache = { latest: null, at: Date.now() };
  }
}

/**
 * Versão mais nova publicada, sem bloquear o chamador: devolve o que está em
 * cache e dispara a consulta em background quando ele venceu — a primeira
 * chamada devolve undefined e o banner aparece a partir do health seguinte.
 */
export function updateAvailable(current: string): { latest: string; command: string } | undefined {
  if ((!cache || Date.now() - cache.at > TTL_MS) && !inflight) {
    inflight = refresh().finally(() => {
      inflight = undefined;
    });
  }
  const latest = cache?.latest;
  return latest && newerThan(latest, current) ? { latest, command: UPDATE_COMMAND } : undefined;
}

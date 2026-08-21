/**
 * Sinal de vida do servidor MCP do portal, por conversa.
 *
 * A rota do catálogo (`/api/portal-tools`) marca aqui a cada listagem; os
 * providers de CLI leem no fim do turno. É o ÚNICO sinal confiável de que o
 * processo subiu e falou o protocolo: nenhum agente chama uma ferramenta sem
 * antes listar as ferramentas.
 *
 * Mora num módulo próprio, e não na rota, porque quem lê é o provider e quem
 * escreve é a rota — importar um do outro fecharia um ciclo entre
 * `chat/providers` e `server/routes`.
 */
const fetchedAt = new Map<string, number>();

export function markPortalToolsFetched(sessionId: string): void {
  fetchedAt.set(sessionId, Date.now());
}

export function portalToolsFetchedAt(sessionId: string): number | undefined {
  return fetchedAt.get(sessionId);
}

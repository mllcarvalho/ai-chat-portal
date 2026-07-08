import { Router, sendError, sendJson } from '../router';
import { revertCheckpoint } from '../../storage/checkpointStore';

export function registerCheckpointRoutes(router: Router): void {
  // desfaz a mutação de uma ferramenta: restaura o estado salvo antes dela
  // (arquivo volta ao conteúdo anterior; o que não existia é apagado)
  router.post('/api/checkpoints/:id/revert', ({ res, params }) => {
    try {
      sendJson(res, 200, { ok: true, ...revertCheckpoint(params.id) });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
  });
}

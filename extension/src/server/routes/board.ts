import type { BoardOp } from '@aiportal/shared';
import { CLIENT_HEADER } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import { applyBoardOps, getBoard } from '../../storage/boardStore';

export function registerBoardRoutes(router: Router): void {
  router.get('/api/projects/:id/board', ({ res, params }) => {
    const board = getBoard(params.id);
    if (!board) {
      sendError(res, 404, 'Projeto não encontrado');
      return;
    }
    sendJson(res, 200, board);
  });

  router.post('/api/projects/:id/board/ops', ({ req, res, params, body, auth }) => {
    const { ops } = (body ?? {}) as { ops?: BoardOp[] };
    if (!Array.isArray(ops) || !ops.length || ops.length > 100) {
      sendError(res, 400, 'Informe as operações (1 a 100 por lote)');
      return;
    }
    const origin = req.headers[CLIENT_HEADER.toLowerCase()];
    const revision = applyBoardOps(
      params.id,
      ops,
      auth?.name ?? 'Host',
      typeof origin === 'string' ? origin : undefined,
    );
    if (revision === undefined) {
      sendError(res, 404, 'Projeto não encontrado');
      return;
    }
    sendJson(res, 200, { revision });
  });
}

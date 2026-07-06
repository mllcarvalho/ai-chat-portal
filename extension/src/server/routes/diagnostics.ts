import { Router, sendError, sendJson } from '../router';
import { fixDiagnostic, getDiagnosticsReport, startDiagnostics } from '../../tools/diagnostics';

/**
 * Diagnóstico do ambiente: o front dispara o run em background (na abertura
 * do portal e pelo botão da página) e faz polling no GET — mesmo padrão dos
 * setups guiados de MCP. O fix aplica a correção e já re-dispara o run.
 */
export function registerDiagnosticsRoutes(router: Router): void {
  router.get('/api/diagnostics', ({ res }) => {
    sendJson(res, 200, getDiagnosticsReport());
  });

  router.post('/api/diagnostics/run', ({ res }) => {
    sendJson(res, 200, startDiagnostics());
  });

  router.post('/api/diagnostics/fix', async ({ res, body }) => {
    const id = ((body ?? {}) as { id?: string }).id?.trim();
    if (!id) {
      sendError(res, 400, 'Informe o id da correção');
      return;
    }
    try {
      const message = await fixDiagnostic(id);
      sendJson(res, 200, { ok: true, message, report: startDiagnostics() });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
  });
}

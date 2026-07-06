import { useDiagnostics } from '../../stores/diagnosticsStore';
import { useUi } from '../../stores/uiStore';

/**
 * Aviso do diagnóstico em background: só interrompe quando algum check ficou
 * vermelho (problemCount > 0). Quem está com tudo ok nunca vê este banner.
 */
export function DiagnosticsBanner() {
  const report = useDiagnostics((s) => s.report);
  const dismissed = useDiagnostics((s) => s.bannerDismissed);
  const dismiss = useDiagnostics((s) => s.dismissBanner);
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);

  if (!report || report.running || report.problemCount === 0) return null;
  if (dismissed || view === 'diagnostics') return null;

  const failed = report.checks.filter((c) => c.status === 'fail').map((c) => c.label);
  return (
    <div className="env-banner env-banner--critical" role="status">
      <span className="env-banner__icon">⛔</span>
      <span className="env-banner__text">
        O diagnóstico encontrou {report.problemCount} problema(s) no ambiente:{' '}
        {failed.join(', ')}.
      </span>
      <button className="btn env-banner__action" onClick={() => setView('diagnostics')}>
        Ver diagnóstico
      </button>
      <button className="env-banner__close" onClick={dismiss} aria-label="Dispensar aviso">
        ×
      </button>
    </div>
  );
}

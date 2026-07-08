import { useEffect } from 'react';
import { Check, RefreshCw, Stethoscope, X } from 'lucide-react';
import type { DiagnosticCheck } from '@aiportal/shared';
import { useDiagnostics } from '../../stores/diagnosticsStore';
import { useUi } from '../../stores/uiStore';
import { PageShell, Panel } from './PageShell';

/**
 * Diagnóstico do ambiente: lista as verificações da máquina (ferramentas,
 * rede corporativa, conectividade) com instrução do que regularizar e botão
 * de correção automática quando existe. Roda em background na abertura do
 * portal; aqui dá para reexecutar e acompanhar.
 */
export function DiagnosticsPage() {
  const report = useDiagnostics((s) => s.report);
  const start = useDiagnostics((s) => s.start);
  const refresh = useDiagnostics((s) => s.refresh);
  const fixMessage = useDiagnostics((s) => s.fixMessage);
  const fixError = useDiagnostics((s) => s.fixError);
  const toast = useUi((s) => s.toast);

  // sem report (página aberta antes do run do boot terminar de chegar): busca
  useEffect(() => {
    if (!report) void refresh();
  }, [report, refresh]);

  useEffect(() => {
    if (fixMessage) toast(fixMessage, 'ok');
  }, [fixMessage, toast]);
  useEffect(() => {
    if (fixError) toast(fixError, 'error');
  }, [fixError, toast]);

  const running = report?.running ?? false;
  const problems = report?.problemCount ?? 0;
  const warns = report?.checks.filter((c) => c.status === 'warn').length ?? 0;

  let summary = 'Verificando o ambiente…';
  if (report && !running) {
    if (problems > 0) summary = `${problems} problema(s) para regularizar.`;
    else if (warns > 0) summary = `Tudo essencial OK — ${warns} aviso(s) que limitam recursos específicos.`;
    else summary = 'Tudo certo: a máquina está pronta para o portal e os MCPs.';
  }

  return (
    <PageShell
      icon={<Stethoscope className="icon icon--lg" aria-hidden />}
      title="Diagnóstico do ambiente"
      subtitle="Verifica as ferramentas e a rede corporativa que o portal e os setups de MCP usam."
      actions={
        <button className="btn" onClick={() => void start()} disabled={running}>
          {running ? 'Verificando…' : <><RefreshCw className="icon" aria-hidden /> Verificar novamente</>}
        </button>
      }
    >
      <Panel title={summary} count={report?.checks.length}>
        {(report?.checks ?? []).map((check) => (
          <CheckRow key={check.id} check={check} />
        ))}
        {!report?.checks.length && (
          <p className="check-item__hint">Nenhuma verificação executada ainda.</p>
        )}
      </Panel>
    </PageShell>
  );
}

function CheckRow({ check }: { check: DiagnosticCheck }) {
  const fix = useDiagnostics((s) => s.fix);
  const fixingId = useDiagnostics((s) => s.fixingId);
  const running = useDiagnostics((s) => s.report?.running ?? false);

  const mark =
    check.status === 'ok'
      ? { cls: 'check-item__mark--ok', icon: <Check className="icon icon--sm" aria-hidden /> }
      : check.status === 'fail'
        ? { cls: 'check-item__mark--fail', icon: <X className="icon icon--sm" aria-hidden /> }
        : check.status === 'warn'
          ? { cls: 'check-item__mark--warn', icon: '!' }
          : { cls: 'check-item__mark--run', icon: '…' };

  return (
    <div className="check-item">
      <span className={`check-item__mark ${mark.cls}`}>{mark.icon}</span>
      <div className="check-item__text">
        <div className="check-item__label">{check.label}</div>
        {check.detail && <div className="check-item__hint">{check.detail}</div>}
        {check.hint && check.status !== 'ok' && (
          <div className="check-item__hint check-item__hint--action">{check.hint}</div>
        )}
      </div>
      {check.fixId && check.status !== 'ok' && (
        <button
          className="btn check-item__fix"
          onClick={() => void fix(check.fixId!)}
          disabled={running || fixingId !== undefined}
        >
          {fixingId === check.fixId ? 'Corrigindo…' : (check.fixLabel ?? 'Corrigir')}
        </button>
      )}
    </div>
  );
}

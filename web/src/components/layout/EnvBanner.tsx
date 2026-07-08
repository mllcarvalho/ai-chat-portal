import { useState } from 'react';
import { OctagonAlert, TriangleAlert, X } from 'lucide-react';
import { useCatalog } from '../../stores/catalogStore';

/**
 * Avisos de dependências da máquina detectadas na inicialização do servidor:
 * node é obrigatório; bash e python são opcionais mas limitam funcionalidades.
 */
export function EnvBanner() {
  const env = useCatalog((s) => s.health?.env);
  const [dismissed, setDismissed] = useState(false);

  if (!env || dismissed) return null;

  const problems: Array<{ text: string; critical: boolean }> = [];
  if (!env.node) {
    problems.push({
      text: 'Node.js não foi encontrado no PATH — a instalação do BMAD (npx) e servidores MCP stdio não vão funcionar.',
      critical: true,
    });
  }
  if (!env.bash) {
    problems.push({
      text:
        'bash não foi encontrado' +
        ' — a execução de comandos pelo assistente fica desativada (no Windows, instale o Git Bash).',
      critical: false,
    });
  }
  if (!env.python) {
    problems.push({
      text: 'Python não foi encontrado — comandos python (ex: workflows BMAD) serão pulados, usando o fallback manual.',
      critical: false,
    });
  }
  if (!problems.length) return null;

  const critical = problems.some((p) => p.critical);
  return (
    <div className={`env-banner${critical ? ' env-banner--critical' : ''}`} role="status">
      <span className="env-banner__icon">
        {critical ? (
          <OctagonAlert className="icon" aria-hidden />
        ) : (
          <TriangleAlert className="icon" aria-hidden />
        )}
      </span>
      <span className="env-banner__text">
        {problems.map((p) => p.text).join(' ')}
      </span>
      <button
        className="env-banner__close"
        onClick={() => setDismissed(true)}
        aria-label="Dispensar aviso"
      >
        <X className="icon" aria-hidden />
      </button>
    </div>
  );
}

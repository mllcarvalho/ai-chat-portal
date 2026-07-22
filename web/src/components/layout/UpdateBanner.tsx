import { useState } from 'react';
import { ArrowUpCircle, X } from 'lucide-react';
import { useCatalog } from '../../stores/catalogStore';

/**
 * Aviso de versão nova do portal publicada no npm (vem no /api/health, com
 * cache de 1 dia no backend). Dispensável por sessão — sem ele cada colega
 * fica para sempre na versão que instalou.
 */
export function UpdateBanner() {
  const update = useCatalog((s) => s.health?.update);
  const current = useCatalog((s) => s.health?.version);
  const [dismissed, setDismissed] = useState(false);

  if (!update || dismissed) return null;

  return (
    <div className="env-banner" role="status">
      <span className="env-banner__icon">
        <ArrowUpCircle className="icon" aria-hidden />
      </span>
      <span className="env-banner__text">
        Nova versão do portal disponível ({current} → {update.latest}). Feche o VS Code e rode{' '}
        <code>{update.command}</code> no terminal para atualizar.
      </span>
      <button className="env-banner__close" onClick={() => setDismissed(true)} aria-label="Dispensar aviso">
        <X className="icon" aria-hidden />
      </button>
    </div>
  );
}

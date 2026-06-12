import type { ReactNode } from 'react';
import { useUi } from '../../stores/uiStore';

/** Moldura comum das páginas de gestão (skills, agentes, MCPs, conhecimento). */
export function PageShell(props: {
  icon?: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const setView = useUi((s) => s.setView);
  return (
    <div className="page">
      <div className="page__head">
        {props.icon && <span className="page__icon">{props.icon}</span>}
        <div className="page__head-text">
          <h1 className="page__title">{props.title}</h1>
          {props.subtitle && <p className="page__subtitle">{props.subtitle}</p>}
        </div>
        <div className="page__actions">
          {props.actions}
          <button className="btn" onClick={() => setView('chat')} title="Voltar ao chat">
            ✕ Fechar
          </button>
        </div>
      </div>
      <div className="page__body">{props.children}</div>
    </div>
  );
}

/** Painel com cabeçalho próprio — divide a página em regiões claras. */
export function Panel(props: {
  title?: ReactNode;
  count?: number;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`panel${props.className ? ` ${props.className}` : ''}`}>
      {(props.title !== undefined || props.actions) && (
        <header className="panel__head">
          {props.title !== undefined && (
            <h2 className="panel__title">
              {props.title}
              {props.count !== undefined && <span className="panel__count">{props.count}</span>}
            </h2>
          )}
          {props.actions && <div className="panel__head-actions">{props.actions}</div>}
        </header>
      )}
      <div className="panel__body">{props.children}</div>
    </section>
  );
}

/** Estado vazio com forma: ícone, título e dica — nada de texto solto. */
export function EmptyState(props: {
  icon?: string;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {props.icon && <span className="empty-state__icon">{props.icon}</span>}
      <p className="empty-state__title">{props.title}</p>
      {props.hint && <p className="empty-state__hint">{props.hint}</p>}
      {props.action && <div className="empty-state__action">{props.action}</div>}
    </div>
  );
}

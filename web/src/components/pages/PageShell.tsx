import type { ReactNode } from 'react';
import { useUi } from '../../stores/uiStore';

/** Moldura comum das páginas de gestão (skills, agentes, MCPs, conhecimento). */
export function PageShell(props: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const setView = useUi((s) => s.setView);
  return (
    <div className="page">
      <div className="page__head">
        <div className="page__head-text">
          <h1 className="page__title">{props.title}</h1>
          {props.subtitle && <p className="page__subtitle">{props.subtitle}</p>}
        </div>
        <div className="page__actions">
          {props.actions}
          <button className="btn btn--ghost" onClick={() => setView('chat')}>
            ✕ Fechar
          </button>
        </div>
      </div>
      <div className="page__body">{props.children}</div>
    </div>
  );
}

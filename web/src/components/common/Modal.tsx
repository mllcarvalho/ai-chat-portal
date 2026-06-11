import type { ReactNode } from 'react';
import { useUi } from '../../stores/uiStore';

export function Modal(props: {
  title: string;
  wide?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
}) {
  const closePanel = useUi((s) => s.closePanel);
  const close = props.onClose ?? closePanel;
  return (
    <>
      <div className="overlay" onClick={close} />
      <div className={`modal${props.wide ? ' modal--wide' : ''}`} role="dialog" aria-modal>
        <div className="modal__head">
          <span className="modal__title">{props.title}</span>
          <button className="modal__close" onClick={close} aria-label="Fechar">
            ×
          </button>
        </div>
        <div className="modal__body">{props.children}</div>
        {props.footer && <div className="modal__foot">{props.footer}</div>}
      </div>
    </>
  );
}

export function Drawer(props: { title: string; children: ReactNode; onClose?: () => void }) {
  const closePanel = useUi((s) => s.closePanel);
  const close = props.onClose ?? closePanel;
  return (
    <>
      <div className="overlay" onClick={close} />
      <div className="drawer">
        <div className="modal__head">
          <span className="modal__title">{props.title}</span>
          <button className="modal__close" onClick={close} aria-label="Fechar">
            ×
          </button>
        </div>
        <div className="modal__body">{props.children}</div>
      </div>
    </>
  );
}

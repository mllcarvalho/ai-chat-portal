import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useUi } from '../../stores/uiStore';

/** Dialog de confirmação do portal (substitui o window.confirm nativo). */
export function ConfirmDialog() {
  const state = useUi((s) => s.confirmState);
  const resolveConfirm = useUi((s) => s.resolveConfirm);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!state) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        resolveConfirm(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, resolveConfirm]);

  if (!state) return null;

  return (
    <>
      <div className="overlay" onClick={() => resolveConfirm(false)} />
      <div className="modal modal--confirm" role="alertdialog" aria-modal>
        <div className="modal__head">
          <span className="modal__title">{state.title ?? 'Confirmar'}</span>
          <button className="modal__close" onClick={() => resolveConfirm(false)} aria-label="Fechar">
            <X className="icon" aria-hidden />
          </button>
        </div>
        <div className="modal__body">
          <p className="confirm-dialog__message">{state.message}</p>
        </div>
        <div className="modal__foot">
          <button className="btn btn--ghost" onClick={() => resolveConfirm(false)}>
            {state.cancelLabel ?? 'Cancelar'}
          </button>
          <button
            ref={confirmRef}
            className={`btn ${state.danger ? 'btn--danger' : 'btn--primary'}`}
            onClick={() => resolveConfirm(true)}
          >
            {state.confirmLabel ?? 'Confirmar'}
          </button>
        </div>
      </div>
    </>
  );
}

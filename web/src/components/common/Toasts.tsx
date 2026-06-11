import { useUi } from '../../stores/uiStore';

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast${t.tone === 'error' ? ' toast--error' : t.tone === 'ok' ? ' toast--ok' : ''}`}
          onClick={() => dismiss(t.id)}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

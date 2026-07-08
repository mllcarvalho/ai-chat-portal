import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export type ContextMenuItem =
  | {
      label: string;
      icon?: ReactNode;
      danger?: boolean;
      disabled?: boolean;
      onClick: () => void;
    }
  | 'separator';

/**
 * Menu de contexto (botão direito) posicionado nas coordenadas do clique.
 * O app usa `zoom` no body — as coordenadas do evento (pixels visuais) são
 * convertidas para o espaço "zoomado" antes de posicionar o menu fixed.
 */
function bodyZoom(): number {
  const z = Number(getComputedStyle(document.body).zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

export function ContextMenu(props: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const zoom = bodyZoom();
  const [pos, setPos] = useState({ left: props.x / zoom, top: props.y / zoom });

  // reposiciona para caber na janela (depois de medir o menu renderizado)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const z = bodyZoom();
    const vw = window.innerWidth / z;
    const vh = window.innerHeight / z;
    let left = props.x / z;
    let top = props.y / z;
    if (left + el.offsetWidth > vw - 8) left = Math.max(8, vw - el.offsetWidth - 8);
    if (top + el.offsetHeight > vh - 8) top = Math.max(8, vh - el.offsetHeight - 8);
    setPos({ left, top });
  }, [props.x, props.y, props.items.length]);

  useLayoutEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      props.onClose();
    };
    // pointerdown (e não click): fecha antes de qualquer outra interação começar
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('wheel', close, { capture: true, passive: true });
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', close, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('wheel', close, true);
    };
  }, [props]);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {props.items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="context-menu__sep" />
        ) : (
          <button
            key={i}
            className={`context-menu__item${item.danger ? ' context-menu__item--danger' : ''}`}
            disabled={item.disabled}
            role="menuitem"
            onClick={() => {
              props.onClose();
              item.onClick();
            }}
          >
            <span className="context-menu__icon">{item.icon ?? ''}</span>
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}

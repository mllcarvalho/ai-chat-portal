import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: ReactNode;
  /** Linha menor abaixo do label, no menu. */
  hint?: string;
  disabled?: boolean;
}

/** Select com o visual da plataforma (substitui o <select> nativo). */
export function Select(props: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Variante menor, para cabeçalhos de painel. */
  compact?: boolean;
  /** Alinhamento do menu em relação ao trigger. */
  align?: 'left' | 'right';
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const selected = props.options.find((o) => o.value === props.value);

  return (
    <div className="select" ref={ref}>
      <button
        type="button"
        className={`select__trigger${props.compact ? ' select__trigger--compact' : ''}`}
        disabled={props.disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="select__value">
          {selected?.label ?? <span className="select__placeholder">{props.placeholder ?? '—'}</span>}
        </span>
        <span className={`select__chevron${open ? ' select__chevron--open' : ''}`}>
          <ChevronDown className="icon icon--sm" aria-hidden />
        </span>
      </button>
      {open && (
        <div className={`select__menu${props.align === 'right' ? ' select__menu--right' : ''}`} role="listbox">
          {props.options.map((option) => (
            <button
              type="button"
              key={option.value}
              role="option"
              aria-selected={option.value === props.value}
              className={`select__item${option.value === props.value ? ' select__item--sel' : ''}`}
              disabled={option.disabled}
              onClick={() => {
                props.onChange(option.value);
                setOpen(false);
              }}
            >
              <span className="select__check">
                {option.value === props.value && <Check className="icon icon--sm" aria-hidden />}
              </span>
              <span className="select__item-label">
                {option.label}
                {option.hint && <span className="select__item-hint">{option.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

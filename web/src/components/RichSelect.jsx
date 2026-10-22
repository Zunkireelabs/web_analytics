import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

const RING = '0 0 0 1px var(--input), 0 1px 2px rgba(0,0,0,.03)';
const RING_OPEN = '0 0 0 1px var(--primary), 0 0 0 3px var(--primary-tint)';
const MARGIN = 8;

// A dropdown whose options carry a title and a description. The menu is
// portalled to <body> with fixed positioning so it floats over a Modal's
// scrolling body instead of being clipped by it.
// options: [{ value, label, description, disabled }]
export default function RichSelect({ value, onChange, options, disabled, label, className = '', menuWidth = 300, align = 'right', block = false }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value);

  const place = useCallback(() => {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const width = block ? r.width : menuWidth;
    let left = align === 'right' ? r.right - width : r.left;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN));
    const menuH = menuRef.current?.offsetHeight || 0;
    const below = window.innerHeight - r.bottom - MARGIN;
    const above = r.top - MARGIN;
    const flip = menuH > below && above > below;
    setPos({ left, width, ...(flip ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }), maxHeight: Math.max(120, (flip ? above : below) - 6) });
  }, [align, block, menuWidth]);

  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const reflow = () => place();
    const onDown = (e) => {
      if (triggerRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    // Capture phase on window: Escape closes only this menu, before the parent
    // Modal's own window listener (bubble phase) can see it.
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); triggerRef.current?.focus(); }
    };
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, true);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('resize', reflow);
      window.removeEventListener('scroll', reflow, true);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, place]);

  const openMenu = () => {
    if (disabled) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  const choose = (opt) => {
    if (opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const move = (dir) => {
    let i = active;
    for (let n = 0; n < options.length; n++) {
      i = (i + dir + options.length) % options.length;
      if (!options[i].disabled) break;
    }
    setActive(i);
  };

  const onTriggerKey = (e) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); openMenu(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (options[active]) choose(options[active]); }
    else if (e.key === 'Tab') { setOpen(false); }
  };

  return (
    <>
      <button type="button" ref={triggerRef} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-label={label}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : openMenu())} onKeyDown={onTriggerKey}
        className={`${block ? 'flex w-full' : 'inline-flex min-w-[132px]'} items-center justify-between gap-2.5 h-8 px-2.5 rounded-control bg-white text-[13px] font-medium text-fg disabled:opacity-60 ${className}`.trim()}
        style={{ boxShadow: open ? RING_OPEN : RING }}>
        <span className="truncate">{selected?.label ?? ''}</span>
        <ChevronDown size={12} className="text-faint shrink-0" />
      </button>
      {open && createPortal(
        <div ref={menuRef} id={listId} role="listbox" aria-label={label}
          className="fixed z-[60] bg-white rounded-card p-1 overflow-y-auto"
          style={{ ...(pos || { visibility: 'hidden', top: 0, left: 0 }), boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 20px 40px -12px rgba(0,0,0,.22)' }}>
          {options.map((o, i) => {
            const isSel = o.value === value;
            return (
              <div key={o.value} id={`${listId}-${i}`} role="option" aria-selected={isSel} aria-disabled={o.disabled || undefined}
                onMouseEnter={() => !o.disabled && setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(o)}
                className={`flex items-start gap-2.5 px-2.5 py-2 rounded-control ${o.disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} ${isSel || i === active ? 'bg-muted' : ''}`}>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-fg">{o.label}</div>
                  {o.description && <div className="text-xs leading-[17px] text-faint mt-px">{o.description}</div>}
                </div>
                {isSel && <Check size={14} className="ml-auto text-fg shrink-0 mt-0.5" />}
              </div>
            );
          })}
        </div>,
        document.body
      )}
    </>
  );
}

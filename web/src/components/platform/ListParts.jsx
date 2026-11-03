import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BarChart3, Gauge, GitBranch, MoreVertical, Search } from 'lucide-react';
import Badge from '../Badge.jsx';
import { CONNECTIONS, connectedCount } from '../../lib/workspace-list-view.js';

// Small pieces the All workspaces list is built from: the access badge, the four connection tiles, the project avatar
// and the three-dot menu. Nothing here fetches anything.

const TILE_ICON = { searchConsole: Search, analytics: BarChart3, github: GitBranch, baseline: Gauge };

export const shortDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');

// Client / Trial (with its end date) / Trial ended / New / Waiting / Declined.
export function AccessBadge({ access }) {
  const state = access?.state || 'client';
  if (state === 'client') return <Badge tone="green" dot>Client</Badge>;
  if (state === 'demo') return <Badge tone="amber" dot>Trial{access.endsAt && <span className="ml-1 text-[11px] font-normal opacity-80">ends {shortDate(access.endsAt)}</span>}</Badge>;
  if (state === 'ended') return <Badge tone="red" dot>Trial ended</Badge>;
  if (state === 'pending') return <Badge tone="amber" dot>Waiting for approval</Badge>;
  if (state === 'rejected') return <Badge tone="red" dot>Declined</Badge>;
  return <Badge tone="grey" dot>New</Badge>;
}

// Search Console, Analytics, GitHub, Baseline: connected is green, missing is dashed grey.
export function ConnectionTiles({ project }) {
  return (
    <span className="inline-flex items-center gap-1" role="group" aria-label="Connections">
      {CONNECTIONS.map((c) => {
        const on = Boolean(project.connections?.[c.key]);
        const Icon = TILE_ICON[c.key];
        return (
          <span key={c.key} role="img" aria-label={`${c.label}: ${on ? 'connected' : 'not connected'}`} title={`${c.label}: ${on ? 'connected' : 'not connected'}`}
            className="size-6 rounded-[7px] grid place-items-center"
            style={on ? { background: 'var(--green-tint)', color: 'var(--green)' } : { color: 'var(--faint, #9a9a9a)', border: '1px dashed #cfcfcf' }}>
            <Icon size={13} strokeWidth={on ? 2.2 : 1.8} />
          </span>
        );
      })}
    </span>
  );
}

export const ConnectedCount = ({ project }) => (
  <span className="text-[13px] text-faint whitespace-nowrap tnum"><b className="font-semibold text-fg">{connectedCount(project)}</b> of {CONNECTIONS.length}</span>
);

export function ProjectAvatar({ name, initials }) {
  return <span className="w-7 h-7 rounded-[8px] bg-primary text-white text-[10px] font-medium grid place-items-center shrink-0" aria-hidden="true">{initials}</span>;
}

// The three-dot menu. Drawn in a portal at the button's position so a row's overflow cannot cut it off; Escape closes it
// and puts focus back on the button, arrows move between items.
// items: [{ key, label, hint?, icon?, onSelect, danger?, disabled? }]; an item with `divider` gets a line above it.
export function RowMenu({ label, items }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btn = useRef(null);
  const panel = useRef(null);

  const close = (refocus = false) => { setOpen(false); if (refocus) btn.current?.focus(); };

  useLayoutEffect(() => {
    if (!open || !btn.current || !panel.current) return;
    const r = btn.current.getBoundingClientRect();
    const h = panel.current.offsetHeight;
    const w = panel.current.offsetWidth;
    const below = r.bottom + 6 + h <= window.innerHeight - 8;
    setPos({ top: below ? r.bottom + 6 : Math.max(8, r.top - 6 - h), left: Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) });
    panel.current.querySelector('[role="menuitem"]:not([disabled])')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!panel.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } };
    const off = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', off);
    window.addEventListener('scroll', off, true);
    return () => {
      document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', off); window.removeEventListener('scroll', off, true);
    };
  }, [open]);

  const onPanelKey = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Tab') return;
    const els = [...panel.current.querySelectorAll('[role="menuitem"]:not([disabled])')];
    if (e.key === 'Tab') { e.preventDefault(); close(true); return; }
    e.preventDefault();
    const i = els.indexOf(document.activeElement);
    els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length]?.focus();
  };

  return (
    <>
      <button ref={btn} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setPos(null); setOpen((v) => !v); }}
        className="size-8 rounded-control grid place-items-center text-faint hover:text-fg hover:bg-muted shrink-0"><MoreVertical size={16} /></button>
      {open && createPortal(
        <div ref={panel} role="menu" aria-label={label} onKeyDown={onPanelKey}
          className="fixed z-[70] w-[264px] max-w-[calc(100vw-16px)] rounded-card bg-white p-1.5"
          style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden', boxShadow: '0 0 0 1px var(--border-2), 0 12px 32px rgba(0,0,0,.14)' }}>
          {items.map((it) => (
            <div key={it.key}>
              {it.divider && <div className="my-1 h-px bg-border" />}
              <button type="button" role="menuitem" disabled={it.disabled}
                onClick={() => { close(); it.onSelect(); }}
                className={`w-full flex items-start gap-2.5 text-left px-2.5 py-2 rounded-control disabled:opacity-50 ${it.danger ? 'hover:bg-[#fdecec]' : 'hover:bg-muted focus:bg-muted'} outline-none`}>
                {it.icon && <it.icon size={15} className="mt-0.5 shrink-0" style={{ color: it.danger ? '#b42318' : 'var(--faint, #777)' }} />}
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium leading-5" style={{ color: it.danger ? '#b42318' : 'var(--fg)' }}>{it.label}</span>
                  {it.hint && <span className="block text-xs text-faint leading-[16px] mt-px">{it.hint}</span>}
                </span>
              </button>
            </div>
          ))}
        </div>, document.body)}
    </>
  );
}

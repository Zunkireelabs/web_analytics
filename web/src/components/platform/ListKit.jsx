import { useEffect, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Search } from 'lucide-react';

// Shared pieces for the Platform lists (requests, sign-ups, approvals, workspaces), so each one has the same top: a row of counts,
// a search box, filter pills with their counts, a sort, and paging at the bottom. Kept small and dumb on purpose: the lists own their data.

// counts: [{ label, value, tone?: 'warn', onClick? }]. 'warn' is the amber one, the count that needs staff.
export function SummaryRow({ counts, cols }) {
  return (
    <div className={`grid gap-2 px-4 sm:px-5 pt-3.5 grid-cols-2 sm:grid-cols-3 ${cols === 6 ? 'lg:grid-cols-6' : cols === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-5'}`}>
      {counts.map((c) => {
        const warn = c.tone === 'warn' && Number(c.value) > 0;
        const Tag = c.onClick ? 'button' : 'div';
        return (
          <Tag key={c.label} type={c.onClick ? 'button' : undefined} onClick={c.onClick}
            className="text-left rounded-control px-3 py-2.5 min-w-0"
            style={warn ? { background: '#fff8ef', boxShadow: 'inset 0 0 0 1px #f6e2bf' } : { background: '#faf9f7', boxShadow: 'inset 0 0 0 1px var(--border)' }}>
            <span className="block text-[20px] leading-6 font-semibold tracking-[-0.02em] tnum" style={{ color: warn ? '#8a5300' : 'var(--fg)' }}>{c.value}</span>
            <span className="block text-xs text-faint truncate">{c.label}</span>
          </Tag>
        );
      })}
    </div>
  );
}

// The row under the counts. filters: [{ key, label, count }]. sorts: [{ key, label }].
export function FilterBar({ query, onQuery, placeholder, filters, filter, onFilter, sorts, sort, onSort, children }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const off = () => setOpen(false);
    window.addEventListener('click', off);
    return () => window.removeEventListener('click', off);
  }, [open]);
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 sm:px-5 py-3.5 mt-3.5 border-t border-border">
      <div className="relative basis-full sm:basis-[220px] sm:max-w-[260px] sm:flex-1">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
        <input type="text" value={query} onChange={(e) => onQuery(e.target.value)} placeholder={placeholder} aria-label={placeholder}
          className="h-8 w-full pl-8 pr-3 rounded-control bg-white text-[13px] text-fg outline-none" style={{ boxShadow: '0 0 0 1px var(--input)' }} />
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter">
        {filters.map((f) => (
          <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => onFilter(f.key)}
            className={`h-[30px] px-2.5 rounded-full text-[12.5px] font-medium ${filter === f.key ? 'bg-fg text-white' : 'bg-muted text-text hover:text-fg'}`}>
            {f.label}<em className="not-italic ml-1.5 font-normal opacity-60">{f.count}</em>
          </button>
        ))}
      </div>
      {sorts?.length > 0 && (
        <div className="relative ml-auto" onClick={(e) => e.stopPropagation()}>
          <button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((v) => !v)}
            className="h-8 px-2.5 rounded-control bg-white text-[13px] font-medium text-fg inline-flex items-center gap-1.5" style={{ boxShadow: '0 0 0 1px var(--input)' }}>
            Sort: {sorts.find((s) => s.key === sort)?.label}<ChevronDown size={12} />
          </button>
          {open && (
            <ul role="listbox" className="absolute right-0 top-9 z-20 min-w-[190px] rounded-card bg-white p-1 list-none m-0" style={{ boxShadow: '0 0 0 1px var(--border-2), 0 12px 32px rgba(0,0,0,.12)' }}>
              {sorts.map((s) => (
                <li key={s.key}><button type="button" role="option" aria-selected={sort === s.key} onClick={() => { onSort(s.key); setOpen(false); }}
                  className={`w-full text-left px-2.5 py-1.5 rounded-control text-[13px] ${sort === s.key ? 'bg-primary-tint text-fg font-medium' : 'text-text hover:bg-muted'}`}>{s.label}</button></li>
              ))}
            </ul>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

// Appears only while rows are ticked. `children` are the bulk buttons.
export function BulkBar({ count, onClear, children }) {
  if (!count) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 sm:px-5 py-2.5 border-y text-[13px]" style={{ background: 'var(--primary-tint)', borderColor: 'var(--primary-ring)' }} role="status">
      <b className="font-semibold text-fg">{count} selected</b>
      <span className="flex-1" />
      {children}
      <button type="button" onClick={onClear} className="btn btn--light btn--sm">Clear</button>
    </div>
  );
}

// "1–12 of 112" and page numbers (first, last, and the ones next to the current page).
export function Pager({ total, page, per, onPage, noun = '' }) {
  const pages = Math.max(1, Math.ceil(total / per));
  const p = Math.min(page, pages);
  const from = total ? (p - 1) * per + 1 : 0;
  const to = Math.min(total, p * per);
  const nums = [];
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - p) <= 1) nums.push(i);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 sm:px-5 py-3 border-t border-border text-[13px] text-faint">
      <span className="tnum">{from}–{to} of {total}{noun ? ` ${noun}` : ''}</span>
      <span className="flex-1" />
      {pages > 1 && (
        <nav className="inline-flex items-center gap-1" aria-label="Pages">
          <button type="button" aria-label="Previous page" disabled={p <= 1} onClick={() => onPage(p - 1)} className="size-[30px] grid place-items-center rounded-control disabled:opacity-30 hover:bg-muted"><ChevronLeft size={15} /></button>
          {nums.map((n, i) => (n === '…' ? <span key={`g${i}`} className="px-1">…</span> : (
            <button key={n} type="button" aria-current={n === p ? 'page' : undefined} onClick={() => onPage(n)}
              className={`min-w-[30px] h-[30px] rounded-control text-[13px] font-medium ${n === p ? 'bg-fg text-white' : 'text-text hover:bg-muted'}`}>{n}</button>
          )))}
          <button type="button" aria-label="Next page" disabled={p >= pages} onClick={() => onPage(p + 1)} className="size-[30px] grid place-items-center rounded-control disabled:opacity-30 hover:bg-muted"><ChevronRight size={15} /></button>
        </nav>
      )}
    </div>
  );
}

// Small helper: the page slice, and a page that resets when the list under it changes.
export function usePaged(list, per, resetKey) {
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [resetKey]);
  const pages = Math.max(1, Math.ceil(list.length / per));
  const p = Math.min(page, pages);
  return { page: p, setPage, rows: list.slice((p - 1) * per, p * per) };
}

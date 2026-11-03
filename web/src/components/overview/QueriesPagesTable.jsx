import { useMemo, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { TrayCard } from '../layout/Tray.jsx';
import { paginate } from '../../lib/overview-view.js';

const num = (v) => Number(v || 0);
const pathOf = (v) => { try { return new URL(v).pathname || '/'; } catch { return v || '/'; } };
const SIZES = [10, 25, 50];

const COLS = [
  { key: 'clicks', label: 'Clicks', get: (r) => num(r.clicks), fmt: (v) => v.toLocaleString('en-US'), desc: true },
  { key: 'impressions', label: 'Impressions', get: (r) => num(r.impressions), fmt: (v) => v.toLocaleString('en-US'), desc: true },
  { key: 'ctr', label: 'CTR', get: (r) => (num(r.impressions) > 0 ? num(r.clicks) / num(r.impressions) : 0), fmt: (v) => `${(v * 100).toFixed(1)}%`, desc: true, hide: true },
  { key: 'position', label: 'Position', get: (r) => (r.avg_position == null ? null : num(r.avg_position)), fmt: (v) => (v == null ? '—' : v.toFixed(1)), desc: false, hide: true },
];

// Top queries and top pages in one table, the way Search Console shows them: tabs, sortable number columns,
// a thin bar under each name for its share, and paging. `limit` is how many rows the page asked the server for.
export default function QueriesPagesTable({ queries, pages, limit = 50, loading }) {
  const [tab, setTab] = useState('queries');
  const [sort, setSort] = useState({ key: 'clicks', dir: 'desc' });
  const [size, setSize] = useState(10);
  const [page, setPage] = useState(1);

  const source = tab === 'queries' ? queries : pages;
  const col = COLS.find((c) => c.key === sort.key);
  const sorted = useMemo(() => {
    const rows = [...(source || [])];
    // A missing position (no finalized data) always sorts last, whichever way the column is sorted.
    rows.sort((a, b) => {
      const x = col.get(a); const y = col.get(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return sort.dir === 'desc' ? y - x : x - y;
    });
    return rows;
  }, [source, col, sort.dir]);
  const max = Math.max(1, ...sorted.map((r) => num(r.clicks)));
  const view = paginate(sorted, page, size);
  const capped = (source || []).length >= limit;

  const sortBy = (c) => { setSort((s) => (s.key === c.key ? { key: c.key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key: c.key, dir: c.desc ? 'desc' : 'asc' })); setPage(1); };
  const tabBtn = (id, label) => (
    <button type="button" role="tab" aria-selected={tab === id} onClick={() => { setTab(id); setPage(1); }}
      className={`px-3 pt-3.5 pb-3 text-[12.5px] font-medium uppercase tracking-[.06em] border-b-2 -mb-px ${tab === id ? 'text-primary border-primary' : 'text-faint border-transparent hover:text-text'}`}>{label}</button>
  );

  return (
    <TrayCard>
      <div role="tablist" className="flex gap-1 px-3 border-b border-border">{tabBtn('queries', 'Queries')}{tabBtn('pages', 'Pages')}</div>
      {loading ? (
        <div className="px-4 py-6 space-y-3">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-4 bg-muted rounded-control animate-pulse" />)}</div>
      ) : sorted.length === 0 ? (
        <div className="py-12 text-center text-sm text-faint">No {tab === 'queries' ? 'query' : 'page'} data for this range.</div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{tab === 'queries' ? 'Top queries' : 'Top pages'}</th>
                  {COLS.map((c) => (
                    <th key={c.key} className={`num ${c.hide ? 'hidden sm:table-cell' : ''}`} aria-sort={sort.key === c.key ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none'}>
                      <button type="button" onClick={() => sortBy(c)} className={`inline-flex items-center gap-1 ${sort.key === c.key ? 'text-[#2a5db0]' : 'hover:text-fg'}`}>
                        {c.label}{sort.key === c.key && <span aria-hidden>{sort.dir === 'desc' ? '↓' : '↑'}</span>}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {view.rows.map((r, i) => {
                  const label = tab === 'queries' ? r.dim_value : pathOf(r.dim_value);
                  return (
                    <tr key={`${r.dim_value}-${i}`}>
                      <td className="max-w-0 w-full">
                        <span className="block truncate text-[13.5px]" title={r.dim_value}>{label}</span>
                        <span className="block h-[3px] rounded-full mt-1.5 max-w-[360px]" style={{ background: '#eef3fb' }}>
                          <i className="block h-full rounded-full" style={{ width: `${Math.max(2, (num(r.clicks) / max) * 100)}%`, background: '#9bbcec' }} />
                        </span>
                      </td>
                      {COLS.map((c) => <td key={c.key} className={`num ${c.hide ? 'hidden sm:table-cell' : ''}`}>{c.fmt(c.get(r))}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-end gap-3 px-4 py-2.5 border-t border-border text-[13px] text-text">
            <label className="inline-flex items-center gap-1.5">Rows per page:
              <span className="relative inline-flex items-center">
                <select value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(1); }} className="appearance-none bg-transparent pr-5 text-fg cursor-pointer">
                  {SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <ChevronDown size={12} className="absolute right-0 pointer-events-none" />
              </span>
            </label>
            <span className="tnum">{view.from}–{view.to} of {view.total}{capped ? '+' : ''}</span>
            <span className="inline-flex gap-1">
              <button type="button" aria-label="Previous page" disabled={view.page <= 1} onClick={() => setPage(view.page - 1)} className="p-1 rounded-control disabled:opacity-30 hover:bg-muted"><ChevronLeft size={16} /></button>
              <button type="button" aria-label="Next page" disabled={view.page >= view.pages} onClick={() => setPage(view.page + 1)} className="p-1 rounded-control disabled:opacity-30 hover:bg-muted"><ChevronRight size={16} /></button>
            </span>
          </div>
        </>
      )}
    </TrayCard>
  );
}

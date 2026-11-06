import { TrayCard } from '../layout/Tray.jsx';

const fmt = (v) => Number(v || 0).toLocaleString('en-US');

// Views by page title, from Google Analytics (the card Google's own Analytics shows, here beside the traffic channels).
// `pages` is GET /ga4-pages: [{ title, views, prev_views, change_pct|null }]. Renders nothing when there is no page
// data, which is the normal state until the nightly ingest has run once.
export default function TopPagesCard({ pages, compareLabel, rangeLabel, current, previous, dataQuality }) {
  if (!pages?.length) return null;
  // While the page history is still filling in (or Google withheld some rows), say how much of the period the list
  // really covers instead of presenting a partial list as the whole.
  const notes = [];
  if (current && current.days < current.daysInRange) notes.push(`Based on ${current.days} of ${current.daysInRange} days so far.`);
  else if (compareLabel && previous && previous.days < previous.daysInRange) notes.push(`Change is measured against ${previous.days} of ${previous.daysInRange} days of the previous period.`);
  for (const n of dataQuality?.notes || []) notes.push(n);
  const max = Math.max(1, ...pages.map((p) => Number(p.views || 0)));
  return (
    <TrayCard title="Top pages" subtitle={`Views by page title${rangeLabel ? ` · ${rangeLabel}` : ''} · Google Analytics`}>
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead><tr><th>Page title</th><th className="num">Views</th>{compareLabel && <th className="num hidden sm:table-cell">{compareLabel}</th>}</tr></thead>
          <tbody>
            {pages.map((p) => (
              <tr key={p.title}>
                <td className="max-w-0 w-full">
                  <span className="block truncate text-[13.5px]" title={p.title}>{p.title || '(untitled)'}</span>
                  <span className="block h-[3px] rounded-full mt-1.5 max-w-[360px]" style={{ background: '#eef3fb' }}>
                    <i className="block h-full rounded-full" style={{ width: `${Math.max(2, (Number(p.views || 0) / max) * 100)}%`, background: '#9bbcec' }} />
                  </span>
                </td>
                <td className="num">{fmt(p.views)}</td>
                {compareLabel && <td className="num hidden sm:table-cell">
                  {p.change_pct == null ? <span className="text-faint">—</span>
                    : <span className="font-medium" style={{ color: p.change_pct >= 0 ? '#1a7f4b' : '#b42318' }}>{p.change_pct >= 0 ? '+' : '−'}{Math.abs(Math.round(p.change_pct))}%</span>}
                </td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {notes.length > 0 && <p className="px-4 py-2.5 border-t border-border text-xs text-faint">{notes.join(' ')}</p>}
    </TrayCard>
  );
}

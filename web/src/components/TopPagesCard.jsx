import { useState } from 'react';
import { TrayCard } from './layout/Tray.jsx';
import Button from './Button.jsx';

const num = (v) => Number(v || 0);
const fmt = (v) => num(v).toLocaleString();
const pathname = (v) => { try { return new URL(v).pathname || '/'; } catch { return v || '/'; } };

function labelForRows(rows) {
  const pathCounts = {};
  for (const r of rows) pathCounts[pathname(r.dim_value)] = (pathCounts[pathname(r.dim_value)] || 0) + 1;
  return (v) => {
    const p = pathname(v);
    if (pathCounts[p] <= 1) return p;
    try { return `${new URL(v).hostname}${p}`; } catch { return p; }
  };
}

export default function TopPagesCard({ pages, loading }) {
  const [showAll, setShowAll] = useState(false);
  const rows = [...(pages || [])].sort((a, b) => num(b.impressions) - num(a.impressions));
  const max = Math.max(1, ...rows.map((r) => num(r.impressions)));
  const displayRows = showAll ? rows : rows.slice(0, 10);
  const hasMore = rows.length > 10;
  const labelOf = labelForRows(rows);

  return (
    <TrayCard title="Top pages" subtitle="Landing pages by organic impressions">
      {loading ? (
        <table className="tbl">
          <tbody>
            {Array.from({ length: 5 }).map((_, i) => (
              <tr key={i}>
                <td colSpan={4}><div className="h-4 bg-muted rounded-control animate-pulse" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : rows.length === 0 ? (
        <div className="text-sm text-faint text-center py-10">No page data for this range.</div>
      ) : (
        <>
          <table className="tbl">
            <thead>
              <tr>
                <th className="rank">#</th>
                <th>Page</th>
                <th className="num">Impr.</th>
                <th className="num">Clicks</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((r, i) => {
                const impr = num(r.impressions);
                const share = Math.max((impr / max) * 100, 4);
                return (
                  <tr key={i}>
                    <td className="rank">{i + 1}</td>
                    <td className="bar max-w-0 w-full">
                      <i style={{ width: `${share}%` }} />
                      <span className="block truncate" title={r.dim_value}>{labelOf(r.dim_value)}</span>
                    </td>
                    <td className="num">{fmt(impr)}</td>
                    <td className="num">{fmt(r.clicks)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="tbl-foot">
            <span>Showing {displayRows.length} of {rows.length}</span>
            {hasMore && (
              <Button variant="ghost" size="sm" onClick={() => setShowAll((s) => !s)}>
                {showAll ? 'Show less' : 'View all pages'}
              </Button>
            )}
          </div>
        </>
      )}
    </TrayCard>
  );
}

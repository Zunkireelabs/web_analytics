import { useState } from 'react';
import Section from './layout/Section.jsx';
import Badge from './Badge.jsx';
import Button from './Button.jsx';

const num = (v) => Number(v || 0);
const fmt = (v) => num(v).toLocaleString();

export default function TopQueriesCard({ queries, loading }) {
  const [showAll, setShowAll] = useState(false);
  const rows = [...(queries || [])].sort((a, b) => num(b.impressions) - num(a.impressions));
  const max = Math.max(1, ...rows.map((r) => num(r.impressions)));
  const displayRows = showAll ? rows : rows.slice(0, 6);
  const hasMore = rows.length > 6;

  return (
    <Section label="Search" source="Google Search Console" title="Top queries" subtitle="Ranked by search impressions">
      <div className="card overflow-hidden">
        {loading ? (
          <table className="tbl">
            <tbody>
              {Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  <td colSpan={5}><div className="h-4 bg-muted rounded-control animate-pulse" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : rows.length === 0 ? (
          <div className="text-sm text-faint text-center py-10">No query data for this range.</div>
        ) : (
          <>
            <table className="tbl">
              <thead>
                <tr>
                  <th className="rank">#</th>
                  <th>Query</th>
                  <th className="num">Impr.</th>
                  <th className="num">Clicks</th>
                  <th className="num hidden sm:table-cell">CTR</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((r, i) => {
                  const impr = num(r.impressions);
                  const clicks = num(r.clicks);
                  const ctr = impr > 0 ? (clicks / impr) * 100 : 0;
                  const share = Math.max((impr / max) * 100, 4);
                  return (
                    <tr key={i}>
                      <td className="rank">{i + 1}</td>
                      <td className="bar max-w-0 w-full">
                        <i style={{ width: `${share}%` }} />
                        <span className="flex items-center gap-2">
                          <span className="block truncate" title={r.dim_value}>{r.dim_value}</span>
                          {i === 0 && <Badge tone="primary" className="shrink-0">Top</Badge>}
                        </span>
                      </td>
                      <td className="num">{fmt(impr)}</td>
                      <td className="num">{fmt(clicks)}</td>
                      <td className="num hidden sm:table-cell">{ctr.toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="tbl-foot">
              <span>Showing {displayRows.length} of {rows.length}</span>
              {hasMore && (
                <Button variant="ghost" size="sm" onClick={() => setShowAll((s) => !s)}>
                  {showAll ? 'Show less' : 'View all queries'}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Section>
  );
}

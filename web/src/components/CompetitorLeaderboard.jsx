import { Fragment, useState } from 'react';
import Badge from './Badge.jsx';

// Real, computed structural-readiness score (0-100) — the same schema/FAQ/
// headings/entities/citation-readiness signals ai-visibility.js already
// scores this site's own pages on, applied to each competitor's homepage
// too (server/agents/lib/competitor-analysis.js). Never a fabricated "vs
// competitors" number — every score here is independently recomputed from
// real fetched HTML.
const DETAIL_FIELDS = [
  ['verdict', null],
  ['positioning', 'Positioning'],
  ['contentDepth', 'Content depth'],
  ['seoStructure', 'SEO structure'],
  ['aiVisibility', 'AI visibility'],
];

const SOURCE = {
  both: { label: 'Google rankings + AI market research agree', short: 'Verified' },
  serp: { label: 'Real Google rankings for your top queries', short: 'Google ranking' },
  llm: { label: 'AI market research — not keyword-verified', short: 'AI research' },
  forced: { label: 'Manually specified, not from automatic discovery', short: 'Manually added' },
};

// A real leaderboard — ranks this site against every AI-identified competitor
// by the same computed score, with this site's own row marked so "are we ahead
// or behind" reads in one glance.
export default function CompetitorLeaderboard({ profiles }) {
  const [expanded, setExpanded] = useState(null);

  const ownScore = profiles.find((p) => p.comparison?.ownScore != null)?.comparison?.ownScore ?? null;
  const rows = [
    ownScore != null && { key: 'own', isOwn: true, label: 'This site', score: ownScore },
    ...profiles.filter((p) => p.comparison?.competitorScore != null).map((p) => ({
      key: p.id, isOwn: false, label: p.domain, score: p.comparison.competitorScore, domain: p.domain, comparison: p.comparison,
    })),
  ].filter(Boolean).sort((a, b) => b.score - a.score);

  if (!rows.length) {
    return <div className="border-t border-border text-sm text-faint text-center py-10">No competitors logged yet.</div>;
  }

  return (
    <div className="border-t border-border">
      <table className="tbl">
        <thead>
          <tr>
            <th className="rank">#</th>
            <th>Site</th>
            <th className="num">Score</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const isOpen = expanded === r.key;
            const src = !r.isOwn && SOURCE[r.comparison?.discoverySource];
            const toggle = () => setExpanded(isOpen ? null : r.key);
            return (
              <Fragment key={r.key}>
                <tr
                  className={r.isOwn ? undefined : 'cursor-pointer hover:bg-[#fafafa]'}
                  onClick={r.isOwn ? undefined : toggle}
                  onKeyDown={r.isOwn ? undefined : (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
                  tabIndex={r.isOwn ? undefined : 0}
                  aria-expanded={r.isOwn ? undefined : isOpen}
                >
                  <td className="rank">{i + 1}</td>
                  <td className="bar max-w-0 w-full">
                    <i style={{ width: `${Math.max(r.score, 4)}%` }} />
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className={`truncate ${r.isOwn ? 'font-medium' : ''}`}>{r.label}</span>
                      {r.isOwn && <Badge tone="primary" className="shrink-0">You</Badge>}
                      {src && <span title={src.label} className="text-xs text-faint ml-1.5 shrink-0">{src.short}</span>}
                      {!r.isOwn && (
                        <a href={`https://${r.domain}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                          aria-label={`Open ${r.domain}`} className="text-xs text-faint hover:text-fg shrink-0">↗</a>
                      )}
                    </span>
                  </td>
                  <td className="num whitespace-nowrap">{r.score}/100</td>
                </tr>
                {isOpen && r.comparison && (
                  <tr>
                    <td colSpan={3} className="!p-0">
                      <ul className="bg-[#fcfcfb] text-[13px] text-text px-4 py-3 space-y-1.5">
                        {DETAIL_FIELDS.filter(([k]) => r.comparison[k]).map(([k, label]) => (
                          <li key={k}>
                            {label && <span className="font-medium text-fg">{label}: </span>}
                            {r.comparison[k]}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

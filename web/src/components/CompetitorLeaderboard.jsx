import { useState } from 'react';

// Real, computed structural-readiness score (0-100) — the same schema/FAQ/
// headings/entities/citation-readiness signals ai-visibility.js already
// scores this site's own pages on, applied to each competitor's homepage
// too (server/agents/lib/competitor-analysis.js). Never a fabricated "vs
// competitors" number — every score here is independently recomputed from
// real fetched HTML.
const scoreColor = (score) => (score >= 70 ? '#16A34A' : score >= 40 ? '#f59e0b' : '#EF4444');

const DETAIL_FIELDS = [
  ['verdict', null],
  ['positioning', 'Positioning'],
  ['contentDepth', 'Content depth'],
  ['seoStructure', 'SEO structure'],
  ['aiVisibility', 'AI visibility'],
];

function RankBadge({ rank, isOwn }) {
  return (
    <span className="w-9 h-9 rounded-xl grid place-items-center text-[11px] font-bold shrink-0"
      style={isOwn
        ? { background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)', color: '#fff' }
        : { background: '#f1f5f9', color: '#94a3b8' }}>
      #{rank}
    </span>
  );
}

const SOURCE = {
  both: { label: 'Google rankings + AI market research agree', short: 'Verified', color: '#16A34A', bg: '#f0fdf4', icon: '✓' },
  serp: { label: 'Real Google rankings for your top queries', short: 'Google ranking', color: '#16A34A', bg: '#f0fdf4', icon: '✓' },
  llm: { label: 'AI market research — not keyword-verified', short: 'AI research', color: '#f59e0b', bg: '#fffbeb', icon: '⚠' },
};

// A real leaderboard, not a grid of near-identical cards — ranks this site
// against every AI-identified competitor by the same computed score, with
// this site's own row highlighted so "are we ahead or behind" reads in one
// glance, same spirit as a client-facing "who's beating you" view.
export default function CompetitorLeaderboard({ profiles }) {
  const [expanded, setExpanded] = useState(null);

  const ownScore = profiles.find((p) => p.comparison?.ownScore != null)?.comparison?.ownScore ?? null;
  const rows = [
    ownScore != null && { key: 'own', isOwn: true, label: 'You', score: ownScore },
    ...profiles.filter((p) => p.comparison?.competitorScore != null).map((p) => ({
      key: p.id, isOwn: false, label: p.domain, score: p.comparison.competitorScore, domain: p.domain, comparison: p.comparison,
    })),
  ].filter(Boolean).sort((a, b) => b.score - a.score);

  if (!rows.length) return null;

  return (
    <div>
      <div className="space-y-1">
      {rows.map((r, i) => {
        const isOpen = expanded === r.key;
        return (
          <div key={r.key}>
            <button type="button" disabled={r.isOwn} onClick={() => setExpanded(isOpen ? null : r.key)}
              className={`w-full flex items-center gap-3 px-2.5 py-2.5 rounded-xl transition text-left ${
                r.isOwn ? 'bg-indigo-50/70 cursor-default' : 'hover:bg-slate-50 cursor-pointer'
              }`}>
              <RankBadge rank={i + 1} isOwn={r.isOwn} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={`text-sm font-semibold truncate ${r.isOwn ? 'text-indigo-700' : 'text-slate-800'}`}>{r.label}</span>
                  {r.isOwn && (
                    <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-600 shrink-0">This site</span>
                  )}
                  {!r.isOwn && r.comparison?.discoverySource && SOURCE[r.comparison.discoverySource] && (
                    <span title={SOURCE[r.comparison.discoverySource].label}
                      className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full shrink-0"
                      style={{ color: SOURCE[r.comparison.discoverySource].color, background: SOURCE[r.comparison.discoverySource].bg }}>
                      {SOURCE[r.comparison.discoverySource].icon} {SOURCE[r.comparison.discoverySource].short}
                    </span>
                  )}
                  {!r.isOwn && (
                    <a href={`https://${r.domain}`} target="_blank" rel="noreferrer"
                      className="text-[10px] text-slate-300 hover:text-slate-500 shrink-0">↗</a>
                  )}
                </div>
                <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden mt-1.5 max-w-[220px]">
                  <div className="h-full rounded-full transition-all" style={{ width: `${r.score}%`, background: scoreColor(r.score) }} />
                </div>
              </div>
              <span className="text-sm font-bold tabular-nums shrink-0" style={{ color: scoreColor(r.score) }}>{r.score}/100</span>
              {!r.isOwn && <span className="text-slate-300 text-[10px] shrink-0 w-3 text-center">{isOpen ? '▲' : '▼'}</span>}
              {r.isOwn && <span className="w-3 shrink-0" />}
            </button>
            {isOpen && r.comparison && (
              <div className="ml-12 mr-2 mb-2 mt-0.5 p-3 rounded-xl bg-slate-50 space-y-1.5">
                {DETAIL_FIELDS.filter(([k]) => r.comparison[k]).map(([k, label]) => (
                  <p key={k} className="text-xs text-slate-600 leading-relaxed">
                    {label && <span className="font-semibold text-slate-500">{label}: </span>}
                    {r.comparison[k]}
                  </p>
                ))}
              </div>
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}

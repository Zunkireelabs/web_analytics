import Badge from './Badge.jsx';
import { STATUS } from '../lib/palette.js';

// Real Google-SERP "who outranks you" comparison (server/agents/competitor-
// intelligence.js's rankingComparison) — deliberately never a 0-100 score,
// only real query/domain/position/impressions facts. Distinct from
// CompetitorLeaderboard.jsx (structural/AI-readiness score) and from
// CompetitorBacklinkCard.jsx/ReferringDomainsCard.jsx (Common Crawl).

const SOURCE_LABEL = { dataforseo: 'Live Search Data', 'google-cse': 'Google Search' };

const TITLE = 'Who outranks you on Google';

function EmptyState({ message, value = '—', color }) {
  return (
    <div className="tray-card p-5">
      <div className="flex items-center justify-between gap-2 text-[13px] text-text">
        <span>{TITLE}</span>
        <Badge tone="outline">Google Search</Badge>
      </div>
      <div className="mt-1.5 text-[22px] font-medium tracking-[-0.02em] text-fg tnum">{value}</div>
      <p className="mt-2 text-[13px]" style={{ color: color || 'var(--text)' }}>{message}</p>
    </div>
  );
}

export default function CompetitorRankingCard({ rankingComparison, meta, loading }) {
  if (loading) {
    return (
      <div className="tray-card p-5 space-y-3">
        <div className="h-3 w-40 bg-muted rounded-control animate-pulse" />
        <div className="h-6 w-32 bg-muted rounded-control animate-pulse" />
      </div>
    );
  }

  if (!meta?.hasRun || !rankingComparison) {
    return <EmptyState message="We haven't checked this yet — check back soon." />;
  }

  if (!rankingComparison.serpProviderConfigured) {
    return <EmptyState message={rankingComparison.message} />;
  }

  if (!rankingComparison.checked) {
    return <EmptyState message={rankingComparison.message} />;
  }

  const sourceLabel = SOURCE_LABEL[rankingComparison.source] || rankingComparison.source;

  if (!rankingComparison.rows?.length) {
    return (
      <div className="tray-card p-5">
        <div className="text-[13px] text-text">{TITLE}</div>
        <div className="mt-1.5 text-[22px] font-medium tracking-[-0.02em] text-fg tnum">0</div>
        <p className="mt-2 text-[13px] text-text">
          You currently outrank every tracked competitor on your top real search queries — via {sourceLabel}.
        </p>
      </div>
    );
  }

  return (
    <div className="tray-card p-5">
      <div className="flex items-center justify-between gap-2 text-[13px] text-text">
        <span>{TITLE}</span>
        <Badge tone="outline">{sourceLabel}</Badge>
      </div>

      <div className="mt-2">
        {rankingComparison.rows.slice(0, 5).map((r) => (
          <div key={`${r.query}:${r.competitorDomain}`} className="flex justify-between gap-3 py-2 border-b border-border last:border-0 text-[13px]">
            <div className="min-w-0">
              <div className="text-fg truncate">{r.competitorDomain}</div>
              <div className="text-xs text-faint truncate">
                "{r.query}" — {r.ownPosition == null ? 'you\'re not in the top 20' : `vs your #${r.ownPosition}`} · {r.impressions} impressions
              </div>
            </div>
            <div className="shrink-0 text-right tnum">
              <span style={{ color: STATUS.critical.text }}>#{r.competitorPosition}</span>
              {r.trend != null && r.trend !== 0 && (
                <div className="text-xs" style={{ color: r.trend > 0 ? STATUS.critical.text : STATUS.good.text }}>
                  {r.trend > 0 ? 'rising' : 'falling'}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

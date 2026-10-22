import { timeAgo } from '../api.js';
import { STATUS } from '../lib/palette.js';

// Free Common Crawl referring-domain comparison vs. tracked competitors
// (server/agents/lib/competitor-backlinks.js). Distinct from
// ReferringDomainsCard.jsx (this site's own summary) and from
// AuthorityScoreCard.jsx (DataForSEO-backed) — never merged with either.

function emptyMessage(meta) {
  if (!meta?.hasRun) return "We haven't compared backlinks yet.";
  return meta.message || 'No backlink comparison available yet.';
}

export default function CompetitorBacklinkCard({ backlinkComparison, meta, loading }) {
  if (loading) {
    return (
      <div className="card p-5 space-y-3">
        <div className="h-3 w-40 bg-muted rounded-control animate-pulse" />
        <div className="h-6 w-32 bg-muted rounded-control animate-pulse" />
      </div>
    );
  }

  if (!backlinkComparison) {
    return (
      <div className="card p-5">
        <div className="text-[13px] text-text">Competitor backlink comparison</div>
        <div className="mt-1.5 text-[22px] font-medium tracking-[-0.02em] text-fg tnum">—</div>
        <p className="mt-2 text-[13px] text-text">{emptyMessage(meta)}</p>
      </div>
    );
  }

  const { ownDomain, strongestProfile, largestGap, opportunities } = backlinkComparison;
  const leaderIsOwn = strongestProfile?.domain === ownDomain?.domain;
  const row = 'flex justify-between gap-3 py-2 border-b border-border last:border-0 text-[13px]';

  return (
    <div className="card p-5">
      <div className="text-[13px] text-text">Competitor backlink comparison</div>

      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-[22px] font-medium tracking-[-0.02em] text-fg tnum">{ownDomain.referringDomains}</span>
        <span className="text-sm text-faint font-normal">referring domains (you)</span>
      </div>

      <div className="mt-3">
        <div className={row}>
          <span className="text-fg">Strongest profile</span>
          <span className="tnum text-text truncate" title={strongestProfile.domain}>
            {leaderIsOwn ? 'This site' : strongestProfile.domain} · {strongestProfile.referringDomains}
          </span>
        </div>
        {largestGap ? (
          <div className={row}>
            <span className="text-fg">Largest gap</span>
            <span className="tnum text-right" style={{ color: STATUS.critical.text }}>
              {largestGap.domain} +{largestGap.gap}
            </span>
          </div>
        ) : null}
      </div>

      {largestGap ? (
        <>
          <p className="mt-2 text-[13px] text-text">
            {largestGap.domain} has {largestGap.gap} more referring domain{largestGap.gap === 1 ? '' : 's'} than you.
          </p>
          {opportunities?.length > 0 && (
            <div className="mt-2 space-y-1">
              <div className="text-xs text-faint">Opportunities</div>
              {opportunities.map((o) => (
                <p key={o.domain} className="text-[13px] text-text">
                  Catch up to <span className="text-fg">{o.domain}</span> — only {o.gap} referring domain{o.gap === 1 ? '' : 's'} behind.
                </p>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="mt-2 text-[13px]" style={{ color: STATUS.good.text }}>You lead every tracked competitor here.</p>
      )}

      <div className="mt-3 text-xs text-faint">Updated {timeAgo(ownDomain.updatedAt)}</div>
    </div>
  );
}

import { useCountUp } from '../useCountUp.js';
import { timeAgo } from '../api.js';

// Free, Common Crawl-derived referring-domain count — a separate, clearly
// distinct widget from AuthorityScoreCard.jsx (DataForSEO-backed), never merged
// into that card's props/state/markup. See server/routes/commoncrawl-backlinks.js
// for the API contract this renders.

function emptyMessage(summary) {
  if (summary?.message) return summary.message;
  return "Could not resolve this site's own domain yet — no real page data to derive it from.";
}

export default function ReferringDomainsCard({ summary, loading }) {
  const animatedCount = useCountUp(summary?.referringDomains ?? 0);

  if (loading) {
    return (
      <div className="tray-card p-5 space-y-3">
        <div className="h-3 w-32 bg-muted rounded-control animate-pulse" />
        <div className="h-6 w-16 bg-muted rounded-control animate-pulse" />
      </div>
    );
  }

  if (!summary || summary.status !== 'ok') {
    return (
      <div className="tray-card p-5">
        <div className="text-[13px] text-text">Referring domains</div>
        <div className="mt-1.5 text-[22px] font-medium tracking-[-0.02em] text-fg tnum">—</div>
        <p className="mt-2 text-[13px] text-text">{emptyMessage(summary)}</p>
      </div>
    );
  }

  return (
    <div className="tray-card p-5">
      <div className="text-[13px] text-text">Referring domains</div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-[22px] font-medium tracking-[-0.02em] text-fg tnum">{animatedCount}</span>
        <span className="text-sm text-faint font-normal">domains</span>
      </div>
      <div className="mt-3 text-xs text-faint">Last checked {timeAgo(summary.updatedAt)}</div>
    </div>
  );
}

import { useState } from 'react';
import { useCountUp } from '../useCountUp.js';
import { timeAgo } from '../api.js';
import Sparkline from './Sparkline.jsx';
import Badge from './Badge.jsx';
import Button from './Button.jsx';
import { STATUS } from '../lib/palette.js';

function emptyMessage(meta) {
  if (!meta?.dataForSeoBacklinksConfigured) return "We haven't calculated this yet — check back soon.";
  if (!meta?.hasRun) return 'Not checked yet — this updates monthly.';
  if (meta.status === 'error') return "We couldn't check this — see Data Connection below.";
  if (meta.status === 'insufficient-data') return `Checked ${timeAgo(meta.lastRunAt)}, but there wasn't enough data yet.`;
  return `Checked ${timeAgo(meta.lastRunAt)}, but no score was available.`;
}

const scoreColor = (score) => (score >= 70 ? STATUS.good.color : score >= 40 ? STATUS.warning.color : STATUS.critical.color);

export default function AuthorityScoreCard({ authority, meta, loading }) {
  const [showPages, setShowPages] = useState(false);
  const animatedScore = useCountUp(authority?.score ?? 0, 900);

  if (loading) {
    return (
      <div className="card p-5 space-y-3">
        <div className="h-3 w-28 bg-muted rounded-control animate-pulse" />
        <div className="h-6 w-20 bg-muted rounded-control animate-pulse" />
      </div>
    );
  }

  if (!authority) {
    return (
      <div className="card p-5">
        <div className="flex items-center justify-between gap-2 text-[13px] text-text">
          <span>SEO domain authority</span>
          <Badge tone="outline">Not yet available</Badge>
        </div>
        <div className="mt-1.5 text-[22px] font-medium tracking-[-0.02em] text-fg tnum">—</div>
        <p className="mt-2 text-[13px] text-text">{emptyMessage(meta)}</p>
      </div>
    );
  }

  const trendGood = authority.scoreDelta == null ? null : authority.scoreDelta >= 0;
  const topReasons = [...(authority.breakdown || [])].sort((a, b) => b.normalizedWeightPct - a.normalizedWeightPct).slice(0, 3);
  const history = (authority.history || []).map((h) => h.score);
  const row = 'flex justify-between gap-3 py-2 border-b border-border last:border-0 text-[13px]';

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="text-[13px] text-text">SEO domain authority</div>
          <div className="mt-1.5 flex items-baseline gap-2 flex-wrap">
            <span className="text-[22px] font-medium tracking-[-0.02em] text-fg tnum">{animatedScore}</span>
            <span className="text-sm text-faint font-normal">/100</span>
            {authority.scoreDelta != null && authority.scoreDelta !== 0 && (
              <span className="text-[13px] font-medium"
                style={{ color: trendGood ? STATUS.good.text : STATUS.critical.text }}>
                {trendGood ? '+' : '\u2212'}{Math.abs(authority.scoreDelta)} pt{Math.abs(authority.scoreDelta) === 1 ? '' : 's'}
              </span>
            )}
          </div>
          {authority.dataSource === 'commoncrawl' && (
            <div className="mt-2"><Badge tone="amber">Estimated score</Badge></div>
          )}
        </div>
        {history.length >= 2 && (
          <div className="w-24 h-8 shrink-0 mt-3">
            <Sparkline data={history} color={scoreColor(authority.score)} stretch dot={false} />
          </div>
        )}
      </div>

      {/* Collapsed view reasons summary list */}
      {!showPages && topReasons.length > 0 && (
        <div className="mt-3">
          <div className="text-xs text-faint">Authority breakdown signals</div>
          {topReasons.map((r) => (
            <div key={r.key} className={row}>
              <span className="text-fg truncate">{r.label}</span>
              <span className="tnum text-text shrink-0">{Math.round(r.score)}/100</span>
            </div>
          ))}
        </div>
      )}

      {authority.topLinkedPages?.length > 0 && (
        <div className="mt-3">
          <Button variant="ghost" size="sm" onClick={() => setShowPages((s) => !s)} aria-expanded={showPages} className="-ml-2.5">
            {showPages ? 'Hide detailed authority analysis' : `Show detailed authority analysis (${authority.topLinkedPages.length})`}
          </Button>

          {showPages && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-3 animate-slide-down">
              <div>
                <div className="text-xs text-faint">Authority signal composition</div>
                {authority.breakdown?.map((r) => (
                  <div key={r.key} className={row}>
                    <div className="min-w-0">
                      <div className="text-fg">{r.label}</div>
                      <div className="text-xs text-faint">{r.normalizedWeightPct}% influence weight</div>
                    </div>
                    <span className="tnum text-text shrink-0">{Math.round(r.score)}/100</span>
                  </div>
                ))}
              </div>

              <div>
                <div className="text-xs text-faint">Top linked domain entry pages</div>
                {authority.topLinkedPages.slice(0, 5).map((p, i) => (
                  <div key={i} className={row}>
                    <span className="font-mono text-xs text-fg truncate max-w-[160px] sm:max-w-[200px]" title={p.page}>{p.page}</span>
                    <span className="tnum text-text shrink-0">{p.referringDomain} domains</span>
                  </div>
                ))}
                <div className="text-xs text-faint mt-2">Showing top {Math.min(5, authority.topLinkedPages.length)} referral metrics</div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

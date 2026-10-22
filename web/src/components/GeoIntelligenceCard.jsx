import { useState } from 'react';
import { useCountUp } from '../useCountUp.js';
import { timeAgo } from '../api.js';
import Sparkline from './Sparkline.jsx';
import Badge from './Badge.jsx';
import Button from './Button.jsx';
import { CHART, STATUS } from '../lib/palette.js';

const CELL = 'px-5 py-4 min-w-0 border-border border-t first:border-t-0 sm:border-t-0 sm:border-l sm:first:border-l-0';
const ROW = 'flex justify-between gap-3 py-2 border-b border-border last:border-0 text-[13px]';

function emptyMessage(meta) {
  if (!meta?.hasRun) return 'Geographical intelligence not analyzed yet — runs monthly.';
  if (meta.status === 'error') return 'Last run failed — check Integration Health below.';
  return `Last run (${timeAgo(meta.lastRunAt)}) completed but returned no geographical traffic.`;
}

export default function GeoIntelligenceCard({ geoIntelligence, meta, loading }) {
  const [showDetails, setShowDetails] = useState(false);

  // Compute primary metric: Top country traffic share %
  const topCountries = geoIntelligence?.topCountries || [];
  const totalSessions = topCountries.reduce((acc, c) => acc + (c.sessions || 0), 0);
  const topCountry = topCountries[0] || null;
  const topCountryShare = totalSessions > 0 && topCountry ? Math.round((topCountry.sessions / totalSessions) * 100) : 0;
  
  const animatedShare = useCountUp(topCountryShare, 900);

  if (loading) {
    return (
      <div className="card p-5 space-y-3">
        <div className="h-3 w-28 bg-muted rounded-control animate-pulse" />
        <div className="h-6 w-20 bg-muted rounded-control animate-pulse" />
      </div>
    );
  }

  if (!geoIntelligence) {
    return (
      <div className="card p-5">
        <div className="flex items-center justify-between gap-2 text-[13px] text-text">
          <span>Geographic audience share</span>
          <Badge tone="outline">Not yet available</Badge>
        </div>
        <div className="mt-1.5 text-[22px] font-medium tracking-[-0.02em] text-fg tnum">—</div>
        <p className="mt-2 text-[13px] text-text">{emptyMessage(meta)}</p>
      </div>
    );
  }

  const sparklineData = topCountries.map((c) => c.sessions).slice(0, 5);
  const growing = geoIntelligence.growingMarkets || [];
  const declining = geoIntelligence.decliningMarkets || [];
  const topLanguages = geoIntelligence.topLanguages || [];
  const lowCtr = geoIntelligence.lowCtrCountries || [];
  const topGrowing = growing[0] || null;

  return (
    <div className="card overflow-hidden">
      <div className="grid grid-cols-1 sm:grid-cols-3">
        <div className={CELL}>
          <div className="text-[13px] text-text">Primary market</div>
          <div className="mt-1.5 text-[22px] font-medium tracking-[-0.02em] text-fg truncate">{topCountry ? topCountry.country : '—'}</div>
          <div className="mt-0.5 text-xs text-faint">{topCountry ? `${topCountry.sessions.toLocaleString()} sessions total` : ''}</div>
        </div>
        <div className={CELL}>
          <div className="text-[13px] text-text">Share of sessions</div>
          <div className="mt-1.5 text-[22px] font-medium tracking-[-0.02em] text-fg tnum">{topCountry ? `${animatedShare}%` : '—'}</div>
          <div className="mt-0.5 text-xs text-faint">from the primary market</div>
          {sparklineData.length >= 2 && (
            <div className="mt-3 h-8 w-24">
              <Sparkline data={sparklineData} color={CHART.highlight} stretch dot={false} />
            </div>
          )}
        </div>
        <div className={CELL}>
          <div className="text-[13px] text-text">Growing market</div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-[22px] font-medium tracking-[-0.02em] text-fg truncate">{topGrowing ? topGrowing.country : '—'}</span>
            {topGrowing && (
              <span className="text-[13px] font-medium tnum shrink-0"
                style={{ color: topGrowing.delta >= 0 ? STATUS.good.text : STATUS.critical.text }}>
                {topGrowing.delta >= 0 ? '+' : '\u2212'}{Math.abs(topGrowing.delta).toLocaleString()}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-faint">sessions vs last period</div>
        </div>
      </div>

      {/* Collapsed view growing markets summary */}
      {!showDetails && growing.length > 0 && (
        <div className="px-5 border-t border-border">
          {growing.slice(0, 3).map((g) => (
            <div key={g.country} className={ROW}>
              <span className="text-fg">{g.country}</span>
              <span className="tnum" style={{ color: STATUS.good.text }}>+{g.delta.toLocaleString()} sessions</span>
            </div>
          ))}
        </div>
      )}

      {showDetails && (
        <div className="px-5 py-3 border-t border-border grid grid-cols-1 md:grid-cols-2 gap-x-8 animate-slide-down">
          <div>
            <div className="text-xs text-faint">Session changes by country</div>
            {growing.slice(0, 3).map((g) => (
              <div key={g.country} className={ROW}>
                <div className="min-w-0">
                  <div className="text-fg">{g.country}</div>
                  <div className="text-xs text-faint">Grew from {g.prior} to {g.recent} sessions</div>
                </div>
                <span className="tnum shrink-0" style={{ color: STATUS.good.text }}>+{g.delta.toLocaleString()}</span>
              </div>
            ))}
            {declining.slice(0, 2).map((d) => (
              <div key={d.country} className={ROW}>
                <div className="min-w-0">
                  <div className="text-fg">{d.country}</div>
                  <div className="text-xs text-faint">Dropped from {d.prior} to {d.recent} sessions</div>
                </div>
                <span className="tnum shrink-0" style={{ color: STATUS.critical.text }}>&minus;{Math.abs(d.delta).toLocaleString()}</span>
              </div>
            ))}
          </div>
          <div>
            <div className="text-xs text-faint mt-3 md:mt-0">Top language segments</div>
            {topLanguages.slice(0, 3).map((l, i) => (
              <div key={i} className={ROW}>
                <span className="text-fg">{l.language}</span>
                <span className="tnum text-text">{l.sessions.toLocaleString()} sessions</span>
              </div>
            ))}
            {lowCtr.length > 0 && (
              <div className="mt-3">
                <div className="text-xs text-faint mb-1.5">Search attention needed</div>
                <div className="flex flex-wrap gap-1.5">
                  {lowCtr.map((c) => <Badge key={c.country} tone="red">{c.country}</Badge>)}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="tbl-foot">
        <span>{growing.length} growing market{growing.length === 1 ? '' : 's'}</span>
        <Button variant="ghost" size="sm" onClick={() => setShowDetails((s) => !s)} aria-expanded={showDetails}>
          {showDetails ? 'Hide detailed market analysis' : 'Show detailed market analysis'}
        </Button>
      </div>
    </div>
  );
}

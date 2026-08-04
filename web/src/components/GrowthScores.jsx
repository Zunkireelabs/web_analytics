import { useEffect, useState, useCallback } from 'react';
import { api, timeAgo } from '../api.js';

// Compact top-of-page score tiles for AI Growth: Overall (Website Health),
// SEO (Authority Score), AEO (AI-visibility readiness), GEO (geo-audit).
// Each value is a real, independently-computed 0-100 number — the same
// no-fabrication discipline as the rest of the product. GEO is fetched here
// (it lives in the geo-audit draft's content.score); the rest arrive via
// the Command Center data payload.
function scoreTone(score) {
  if (score >= 70) return { label: 'Strong', color: 'text-emerald-600', ring: 'stroke-emerald-500' };
  if (score >= 40) return { label: 'Needs work', color: 'text-amber-600', ring: 'stroke-amber-500' };
  return { label: 'Critical', color: 'text-rose-600', ring: 'stroke-rose-500' };
}

function ScoreTile({ label, icon, iconBg, score, sublabel, meta, loading, accent }) {
  const num = typeof score === 'number' ? score : null;
  const tone = num != null ? scoreTone(num) : null;
  const radius = 30;
  const strokeWidth = 7;
  const circumference = 2 * Math.PI * radius;
  const dash = num != null ? circumference - (Math.min(100, Math.max(0, num)) / 100) * circumference : circumference;

  const statusLabel = meta?.hasRun === false ? 'Not run yet'
    : meta?.status === 'insufficient-data' ? 'No data yet'
    : meta?.status && meta.status !== 'ok' ? 'Error'
    : sublabel || '—';

  return (
    <div className="relative card border border-slate-200 bg-gradient-to-br from-white to-slate-50/40 p-5 rounded-3xl shadow-sm overflow-hidden flex flex-col justify-between gap-4">
      <div className="absolute top-0 inset-x-0 h-1.5" style={{ background: `linear-gradient(to right, ${accent}, ${accent}55)` }} />
      <div className="flex items-center gap-2.5">
        <span className="w-9 h-9 rounded-xl grid place-items-center shrink-0 border shadow-sm" style={{ backgroundColor: `${iconBg}`, color: accent }}>
          {icon}
        </span>
        <div className="leading-tight">
          <span className="block text-sm font-black uppercase tracking-widest text-slate-800">{label}</span>
          <span className="block text-[9px] font-bold text-slate-400 uppercase tracking-wider mt-0.5">Score</span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          {loading ? (
            <div className="h-9 w-16 bg-slate-100 rounded animate-pulse" />
          ) : (
            <div className="flex items-baseline gap-1">
              <span className={`text-4xl font-black tracking-tight tabular-nums ${tone ? tone.color : 'text-slate-400'}`}>
                {num != null ? num : '—'}
              </span>
              <span className="text-[10px] font-bold text-slate-400">/ 100</span>
            </div>
          )}
          <span className={`text-[9px] font-black uppercase tracking-wider ${tone ? tone.color : 'text-slate-400'}`}>{statusLabel}</span>
        </div>

        <svg className="w-[74px] h-[74px] shrink-0" viewBox="0 0 72 72">
          <circle cx="36" cy="36" r={radius} fill="transparent" stroke="#eef2f7" strokeWidth={strokeWidth} />
          <circle
            cx="36" cy="36" r={radius} fill="transparent"
            stroke={num != null ? accent : '#e2e8f0'}
            strokeWidth={strokeWidth} strokeDasharray={circumference} strokeDashoffset={dash}
            strokeLinecap="round" transform="rotate(-90 36 36)"
            className="transition-all duration-1000 ease-out"
          />
        </svg>
      </div>
    </div>
  );
}

export default function GrowthScores({ data, loading }) {
  const [geoAudits, setGeoAudits] = useState(null);

  const loadGeo = useCallback(
    () => api.actionCenter.drafts({ actionType: 'geo-audit' }).then(setGeoAudits).catch(() => setGeoAudits([])),
    []
  );

  useEffect(() => { loadGeo(); }, [loadGeo]);

  const geoLoading = geoAudits === null;
  const geoLatest = geoAudits?.[0] || null;
  const geoSublabel = geoLatest ? `Updated ${timeAgo(geoLatest.created_at)}` : 'No audit run yet';
  const geoScore = geoLatest?.content?.score?.overall ?? null;

  const healthScore = data?.health?.score ?? null;
  const healthTrend = data?.health?.trendWeek;
  const healthSublabel = healthTrend != null && healthTrend !== 0
    ? `${healthTrend > 0 ? '+' : ''}${healthTrend} pt this week`
    : 'Weighted across all agents';

  const authorityScore = data?.authority?.score ?? null;
  const authorityMeta = data?.authorityMeta;

  const aeoScore = data?.aiVisibility?.score ?? null;
  const aeoMeta = data?.aiVisibilityMeta;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <ScoreTile
        label="Overall"
        icon={<span className="text-sm">🧠</span>}
        iconBg="#eef2ff"
        accent="#6C63FF"
        score={loading ? null : healthScore}
        sublabel={healthSublabel}
        loading={loading}
      />
      <ScoreTile
        label="SEO"
        icon={<span className="text-sm">🔍</span>}
        iconBg="#fff7ed"
        accent="#f97316"
        score={loading ? null : authorityScore}
        sublabel="Backlink authority"
        meta={authorityMeta}
        loading={loading}
      />
      <ScoreTile
        label="AEO"
        icon={<span className="text-sm">🤖</span>}
        iconBg="#ecfdf5"
        accent="#10b981"
        score={loading ? null : aeoScore}
        sublabel="AI visibility readiness"
        meta={aeoMeta}
        loading={loading}
      />
      <ScoreTile
        label="GEO"
        icon={<span className="text-sm">🌐</span>}
        iconBg="#f0f9ff"
        accent="#0ea5e9"
        score={geoLoading || loading ? null : geoScore}
        sublabel={geoSublabel}
        meta={geoLoading ? { hasRun: true } : undefined}
        loading={geoLoading || loading}
      />
    </div>
  );
}

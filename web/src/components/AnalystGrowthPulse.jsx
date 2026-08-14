import { useMemo } from 'react';
import { BrainCircuit, TrendingUp, TrendingDown, Minus, Clock, Wrench, ArrowRight, ShieldCheck } from 'lucide-react';
import { formatByUnit, pct, finding, horizonChange, isDecline, SEVERITY_META } from '../lib/analystFormat.js';

const PRIMARY_METRIC_KEYS = ['gsc_impressions', 'gsc_clicks'];
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

function daysLabel(days) {
  if (days == null) return null;
  if (days > 0) return `${days} day${days === 1 ? '' : 's'} out`;
  if (days === 0) return 'today';
  return 'already underway';
}

// The proactive "smart agent" summary the Analyst page opens with — not a
// new data source, just the two things dashboard already computes (metric
// forecasts, decline insights) promoted to the top instead of buried inside
// Impression Forecast's card. "What's coming, and what to fix before it
// lands" is answered here in one glance; the full list with real
// Fix/Dismiss/Send-to-Action-Center controls still lives at #an-issues-found,
// which this card's CTA jumps straight to.
export default function AnalystGrowthPulse({ dashboard }) {
  const metrics = useMemo(() => Object.values(dashboard?.groups || {}).flat(), [dashboard]);

  const trajectory = useMemo(() => {
    const chosen = PRIMARY_METRIC_KEYS
      .map((key) => metrics.find((m) => m.metric_key === key))
      .filter(Boolean);
    return chosen.map((metric) => ({ metric, change: horizonChange(metric) })).filter((t) => t.change);
  }, [metrics]);

  const topRisk = useMemo(() => {
    const risks = (dashboard?.insights || []).filter(isDecline);
    return [...risks].sort((a, b) => {
      const sevDiff = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
      if (sevDiff !== 0) return sevDiff;
      const aDays = a.evidence?.days_until_drop ?? Infinity;
      const bDays = b.evidence?.days_until_drop ?? Infinity;
      return aDays - bDays;
    })[0] || null;
  }, [dashboard]);

  const metricFor = (key) => metrics.find((m) => m.metric_key === key) || { metric_key: key, display_name: key };

  const jumpToIssues = () =>
    document.getElementById('an-issues-found')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const riskSeverityMeta = topRisk ? (SEVERITY_META[topRisk.severity] || SEVERITY_META.low) : null;
  const riskDays = daysLabel(topRisk?.evidence?.days_until_drop);

  return (
    <div className="an-panel p-6 relative overflow-hidden">
      <div aria-hidden className="absolute -top-16 -right-16 w-64 h-64 rounded-full bg-indigo-500/10 blur-3xl pointer-events-none" />
      <div aria-hidden className="absolute -bottom-20 -left-10 w-56 h-56 rounded-full bg-violet-500/8 blur-3xl pointer-events-none" />

      <div className="relative flex items-center gap-3 mb-5">
        <div className="w-10 h-10 rounded-2xl grid place-items-center bg-gradient-to-br from-indigo-500 to-violet-600 text-white shrink-0 shadow-lg shadow-indigo-500/25">
          <BrainCircuit size={19} />
        </div>
        <div>
          <h2 className="text-sm font-black text-slate-900 tracking-tight">Growth Outlook</h2>
          <p className="text-[11px] font-medium text-slate-500">
            What's ahead over the next two weeks, and what to fix before it happens
          </p>
        </div>
      </div>

      <div className="relative grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ── Trajectory ─────────────────────────────────────────────── */}
        <div className="rounded-2xl bg-white/60 border border-slate-200 p-4">
          <div className="an-label mb-3">Where traffic is heading</div>
          {trajectory.length === 0 ? (
            <p className="text-xs font-medium text-slate-500">
              Not enough history yet to project a trend — this fills in once 30+ days of data have
              been collected.
            </p>
          ) : (
            <div className="space-y-3">
              {trajectory.map(({ metric, change }) => {
                const falling = change.deltaPct != null && change.deltaPct < 0;
                const flat = change.deltaPct != null && Math.abs(change.deltaPct) < 1;
                const Icon = change.deltaPct == null ? Minus : flat ? Minus : falling ? TrendingDown : TrendingUp;
                const tone = change.deltaPct == null || flat ? 'text-slate-500' : falling ? 'text-rose-600' : 'text-emerald-600';
                return (
                  <div key={metric.metric_key} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{metric.display_name}</div>
                      <div className="text-lg font-black text-slate-900 tabular-nums">
                        {formatByUnit(change.endValue, metric.unit)}
                      </div>
                    </div>
                    <div className={`flex items-center gap-1 text-xs font-black shrink-0 ${tone}`}>
                      <Icon size={13} />
                      {change.deltaPct != null ? pct(change.deltaPct) : `in ${change.horizon}d`}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Most urgent risk ──────────────────────────────────────── */}
        <div
          className={`rounded-2xl border p-4 ${
            topRisk ? 'bg-rose-500/[0.05] border-rose-500/20' : 'bg-emerald-500/[0.05] border-emerald-500/20'
          }`}
        >
          <div className="an-label mb-3">Fix before it lands</div>
          {!topRisk ? (
            <div className="flex items-start gap-2.5">
              <ShieldCheck size={16} className="text-emerald-600 shrink-0 mt-0.5" />
              <p className="text-xs font-semibold text-slate-700">
                Nothing at risk right now — keep publishing to keep the trend up.
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded"
                  style={{ color: riskSeverityMeta.color, backgroundColor: riskSeverityMeta.bg }}
                >
                  {riskSeverityMeta.label}
                </span>
                {riskDays && (
                  <span className="an-chip an-chip-rose">
                    <Clock size={9} />
                    {riskDays}
                  </span>
                )}
              </div>
              <p className="text-xs font-bold text-slate-800 leading-snug">
                {finding(topRisk, metricFor(topRisk.metric_key))}
              </p>
              {topRisk.recommendation ? (
                <p className="text-[11px] font-semibold text-slate-700 flex items-start gap-1.5">
                  <Wrench size={11} className="shrink-0 mt-0.5 text-indigo-600" />
                  <span>{topRisk.recommendation}</span>
                </p>
              ) : (
                <p className="text-[10.5px] font-medium text-slate-400">
                  Fix guidance is still being written for this one.
                </p>
              )}
              <button
                type="button"
                onClick={jumpToIssues}
                className="an-grad-btn text-[11px] font-bold px-3.5 py-2 rounded-xl text-white flex items-center gap-1.5 cursor-pointer"
              >
                Fix before it happens
                <ArrowRight size={11} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

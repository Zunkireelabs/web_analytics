import { useEffect, useMemo, useState } from 'react';
import {
  ComposedChart, Area, Line, ReferenceLine, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import {
  AlertTriangle, Clock, CheckCircle2, Ban, Loader2, Wrench, Send, ChevronDown, ChevronRight,
  Activity, ShieldCheck, EyeOff, Search,
} from 'lucide-react';
import { api } from '../api.js';
import {
  formatByUnit, finding, supportingLine, groupDeclinesByMetric, lowConfidenceReason,
  HEALTH_META, SEVERITY_META, TYPE_META,
} from '../lib/analystFormat.js';

function daysLabel(days) {
  if (days == null) return null;
  if (days > 0) return `${days} day${days === 1 ? '' : 's'} out`;
  if (days === 0) return 'today';
  return 'already underway';
}

// Compact past-vs-forecast picture for one metric, fetched only when a card is
// actually expanded — the dashboard payload carries summary numbers, and the
// full series is a separate request per metric, so loading them all up front
// would be N requests for charts nobody has opened.
function MiniTrend({ clientId, metric }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    api.analyst.series(clientId, metric.metric_key)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e.message || 'Could not load the trend'); });
    return () => { live = false; };
  }, [clientId, metric.metric_key]);

  const rows = useMemo(() => {
    if (!data) return [];
    const byDate = new Map();
    for (const r of data.series) byDate.set(r.date, { date: r.date, value: r.value, forecast: null, band: null });
    const points = data.forecast?.status === 'ok' ? data.forecast.points : [];
    for (const p of points) {
      const existing = byDate.get(p.target_date) || { date: p.target_date, value: null, forecast: null, band: null };
      existing.forecast = p.point_estimate;
      existing.band = p.lower_bound != null && p.upper_bound != null ? [p.lower_bound, p.upper_bound] : null;
      byDate.set(p.target_date, existing);
    }
    // Join the dashed forecast onto the last real reading so the two lines
    // meet instead of leaving a visual gap at "today".
    const lastActual = data.series.length ? data.series[data.series.length - 1].date : null;
    if (lastActual && byDate.has(lastActual) && points.length) {
      byDate.get(lastActual).forecast = byDate.get(lastActual).value;
    }
    return { merged: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)), lastActual };
  }, [data]);

  if (error) return <p className="text-[11px] font-semibold text-rose-600 py-6 text-center">{error}</p>;
  if (!data) return <p className="text-[11px] font-medium text-slate-400 py-6 text-center animate-pulse">Loading trend…</p>;
  if (!rows.merged?.length) return <p className="text-[11px] font-medium text-slate-400 py-6 text-center">No series data for this metric.</p>;

  return (
    <div>
      <ResponsiveContainer width="100%" height={150}>
        <ComposedChart data={rows.merged} margin={{ top: 4, right: 6, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={`miniFill-${metric.metric_key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.22} />
              <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis
            dataKey="date" tick={{ fontSize: 9, fill: '#94a3b8', fontWeight: 600 }}
            axisLine={false} tickLine={false} minTickGap={44}
            tickFormatter={(d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}
          />
          <YAxis
            tick={{ fontSize: 9, fill: '#94a3b8', fontWeight: 600 }} axisLine={false} tickLine={false} width={40}
            tickFormatter={(v) => (metric.unit === 'ratio' ? `${Math.round(v * 100)}%` : Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(v))}
          />
          <Tooltip
            contentStyle={{ fontSize: 11, borderRadius: 12, border: '1px solid #e2e8f0' }}
            formatter={(v, name) => [formatByUnit(v, metric.unit), name === 'forecast' ? 'Forecast' : 'Observed']}
            labelFormatter={(d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })}
          />
          {rows.lastActual && (
            <ReferenceLine
              x={rows.lastActual} stroke="#cbd5e1" strokeDasharray="3 3"
              label={{ value: 'Today', position: 'insideTopRight', fontSize: 8, fill: '#94a3b8', fontWeight: 700 }}
            />
          )}
          <Area type="monotone" dataKey="band" stroke="none" fill="#8b5cf6" fillOpacity={0.13} connectNulls={false} />
          <Area type="monotone" dataKey="value" stroke="#8b5cf6" strokeWidth={2} fill={`url(#miniFill-${metric.metric_key})`} dot={false} connectNulls={false} />
          <Line type="monotone" dataKey="forecast" stroke="#38bdf8" strokeWidth={2} strokeDasharray="5 5" dot={false} connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] font-bold text-slate-400 mt-1.5">
        <span className="inline-flex items-center gap-1"><span className="w-2.5 h-[2px] bg-violet-500" /> Observed</span>
        <span className="inline-flex items-center gap-1"><span className="w-2.5 h-[2px] bg-sky-400" /> Forecast</span>
        {data.forecast?.status === 'ok' && data.forecast.model && <span>Model: {data.forecast.model}</span>}
      </div>
    </div>
  );
}

function MetricCard({ clientId, group, onChanged, defaultOpen }) {
  const { metric, happened, expected, health, severity, narrated } = group;
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [draftedId, setDraftedId] = useState(null);

  const healthMeta = HEALTH_META[health.state] || HEALTH_META['no-data'];
  const sevMeta = SEVERITY_META[severity] || SEVERITY_META.low;

  // Actions attach to one insight — the most severe one the backend actually
  // gave a recommendation row to. Without a recommendation_id there is nothing
  // for resolve/dismiss to act on, which is why the fallback is "monitoring
  // only" rather than a button that would silently fail.
  const primary = useMemo(
    () => group.all.find((i) => i.recommendation_id) || null,
    [group.all]
  );

  // Mirrors seoDraftEligibility (server/agents/lib/analyst-seo-mapping.js) so
  // the button only shows when the server would accept it. Site-wide findings
  // have no single page to rewrite.
  const canDraft = primary?.metric_key?.startsWith('gsc_') && primary?.dimension_type === 'page' && primary?.dimension_value;

  const sendToActionCenter = async () => {
    if (!primary) return;
    setBusy(true); setActionError(null);
    try {
      const draft = await api.analyst.generateSeoDraft(clientId, primary);
      setDraftedId(draft.id);
    } catch (e) {
      setActionError(e.message || 'Could not send this to Action Center.');
    } finally { setBusy(false); }
  };

  const act = async (kind) => {
    if (!primary?.recommendation_id) return;
    setBusy(true); setActionError(null);
    try {
      if (kind === 'resolve') await api.analyst.resolveRecommendation(clientId, primary.recommendation_id);
      else await api.analyst.dismissRecommendation(clientId, primary.recommendation_id);
      onChanged?.();
    } catch (e) {
      setActionError(e.message || 'Failed to update this.');
    } finally { setBusy(false); }
  };

  const days = health.daysUntilDrop ?? expected[0]?.evidence?.days_until_drop ?? null;

  return (
    <div
      className="rounded-2xl border overflow-hidden"
      style={{ borderColor: healthMeta.border, backgroundColor: healthMeta.bg }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full text-left p-4 flex items-start gap-3 cursor-pointer"
      >
        {open ? <ChevronDown size={15} className="text-slate-400 shrink-0 mt-0.5" /> : <ChevronRight size={15} className="text-slate-400 shrink-0 mt-0.5" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-black text-slate-900">{metric.display_name}</span>
            <span
              className="text-[8.5px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{ color: healthMeta.color, backgroundColor: '#ffffff99' }}
            >
              {healthMeta.label}
            </span>
            <span
              className="text-[8.5px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{ color: sevMeta.color, backgroundColor: '#ffffff99' }}
            >
              {sevMeta.label}
            </span>
            {days != null && (
              <span className="an-chip an-chip-slate">
                <Clock size={9} />
                {daysLabel(days)}
              </span>
            )}
          </div>

          {/* The two tenses, always in the same order and always labelled, so
              a past decline and a projected one can never be mistaken for two
              separate problems — or for each other. */}
          <div className="mt-2 space-y-1.5">
            {happened.length > 0 && (
              <p className="text-[11.5px] font-semibold text-slate-800 leading-snug">
                <span className="an-label mr-1.5">What happened</span>
                {finding(happened[0], metric)}
                <span className="font-medium text-slate-500"> · {supportingLine(happened[0], metric)}</span>
              </p>
            )}
            {expected.length > 0 ? (
              <p className="text-[11.5px] font-semibold text-slate-800 leading-snug">
                <span className="an-label mr-1.5">What's expected</span>
                {finding(expected[0], metric)}
                <span className="font-medium text-slate-500"> · {supportingLine(expected[0], metric)}</span>
              </p>
            ) : health.state === 'watch' ? (
              <p className="text-[11.5px] font-semibold text-slate-800 leading-snug">
                <span className="an-label mr-1.5">What's expected</span>
                Moving the wrong way but not yet past the warning threshold
                {health.bandCrosses ? ' — the forecast range still reaches it.' : '.'}
              </p>
            ) : null}
          </div>
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4 pl-11 space-y-3">
          <div className="rounded-xl bg-white/70 border border-slate-200 p-3">
            <MiniTrend clientId={clientId} metric={metric} />
          </div>

          {/* Why and Fix come verbatim from the nightly recommendation pass —
              never synthesized here. When they are absent the card says so
              plainly instead of leaving a gap that reads as "nothing to do". */}
          {narrated?.root_cause && (
            <p className="text-[11px] font-medium text-slate-700">
              <span className="an-label mr-1.5">Why</span>
              {narrated.root_cause}
              <span className="text-[9.5px] font-bold text-slate-400 ml-1.5 uppercase tracking-wider">AI inference</span>
            </p>
          )}
          {narrated?.recommendation ? (
            <p className="text-[11px] font-semibold text-slate-800 flex items-start gap-1.5">
              <Wrench size={11} className="shrink-0 mt-0.5 text-indigo-600" />
              <span><span className="an-label mr-1.5">What to fix</span>{narrated.recommendation}</span>
            </p>
          ) : (
            <p className="text-[10.5px] font-medium text-slate-500 flex items-start gap-1.5">
              <Search size={11} className="shrink-0 mt-0.5 text-slate-400" />
              {group.all.some((i) => i.narration_status === 'failed')
                ? 'Fix guidance could not be generated for this one — the finding itself still stands, and the chart above is the evidence.'
                : 'No fix guidance written for this yet. The finding and its evidence are shown above; guidance is added by the nightly pass.'}
            </p>
          )}

          {/* Every signal behind the card, so the merge never hides an
              individual finding the reader might want to see. */}
          {group.all.length > 1 && (
            <div className="space-y-1 pt-1">
              <div className="an-label">All signals ({group.all.length})</div>
              {group.all.map((i) => {
                const TypeIcon = TYPE_META[i.insight_type]?.icon || Activity;
                return (
                  <div key={i.id} className="flex items-start gap-1.5 text-[10.5px] font-medium text-slate-600">
                    <TypeIcon size={10} className="shrink-0 mt-0.5" style={{ color: TYPE_META[i.insight_type]?.color }} />
                    <span>
                      <span className="font-bold">{TYPE_META[i.insight_type]?.label || i.insight_type}</span>
                      {' · '}{supportingLine(i, metric)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {actionError && (
            <p className="text-[11px] font-semibold text-rose-600 flex items-center gap-1.5">
              <AlertTriangle size={11} className="shrink-0" />{actionError}
            </p>
          )}

          {primary ? (
            <div className="flex items-center gap-2 flex-wrap pt-1">
              {draftedId ? (
                <a href={`/action-center?siteId=${clientId}`} className="text-[11px] font-bold text-emerald-700 hover:underline flex items-center gap-1.5">
                  <CheckCircle2 size={11} /> In Action Center
                </a>
              ) : canDraft ? (
                <button
                  type="button" onClick={sendToActionCenter} disabled={busy}
                  className="an-grad-btn text-[11px] font-bold px-3 py-2 rounded-xl text-white flex items-center gap-1.5 cursor-pointer"
                >
                  {busy ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
                  Send to Action Center
                </button>
              ) : (
                <span className="text-[10px] font-medium text-slate-400">
                  Site-wide — no single page to rewrite, so this is handled by hand rather than drafted.
                </span>
              )}
              <button
                type="button" onClick={() => act('resolve')} disabled={busy}
                className="text-[11px] font-bold px-3 py-2 rounded-xl border border-emerald-300 text-emerald-700 hover:bg-emerald-50 transition disabled:opacity-40 flex items-center gap-1.5 cursor-pointer"
              >
                {busy ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />} Fixed
              </button>
              <button
                type="button" onClick={() => act('dismiss')} disabled={busy}
                title="Dismiss" aria-label="Dismiss"
                className="p-2 rounded-xl border border-slate-300 text-slate-400 hover:text-rose-600 hover:border-rose-300 transition disabled:opacity-40 cursor-pointer"
              >
                <Ban size={12} />
              </button>
            </div>
          ) : (
            <span className="text-[10px] font-semibold text-slate-400">
              Monitoring only — no fix queued for this one yet.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// "What needs attention": one card per METRIC rather than one row per insight.
// Everything the agent knows about a metric going the wrong way — the observed
// decline, the projected one, the reason and the fix — is assembled into a
// single story, and the small stuff is pushed below a fold instead of
// competing with it for attention.
export default function AnalystMetricIntelligence({ clientId, dashboard, onChanged }) {
  const metrics = useMemo(() => Object.values(dashboard?.groups || {}).flat(), [dashboard]);
  const groups = useMemo(
    () => groupDeclinesByMetric(dashboard?.insights || [], metrics),
    [dashboard, metrics]
  );

  const primary = groups.filter((g) => !g.lowConfidence);
  const lowConfidence = groups.filter((g) => g.lowConfidence);
  const [showLow, setShowLow] = useState(false);

  return (
    <div className="an-panel p-5 space-y-4" id="an-needs-attention">
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-xl grid place-items-center bg-rose-500/10 border border-rose-500/25 text-rose-600 shrink-0">
          <AlertTriangle size={15} />
        </div>
        <div className="min-w-0">
          <h2 className="text-xs font-black uppercase tracking-widest text-slate-800">What needs attention</h2>
          <p className="text-[11px] font-medium text-slate-500">
            What happened, what's expected next, why, and what to fix
          </p>
        </div>
        {primary.length > 0 && <span className="an-chip an-chip-rose ml-auto">{primary.length}</span>}
      </div>

      {primary.length === 0 ? (
        <div className="flex items-start gap-2.5 bg-emerald-500/[0.05] border border-emerald-500/20 rounded-xl px-4 py-3">
          <ShieldCheck size={15} className="text-emerald-600 shrink-0 mt-0.5" />
          <p className="text-xs font-semibold text-slate-700">
            Nothing material is declining or projected to decline right now.
            {lowConfidence.length > 0 && ' Only very low-volume observations were found — they are below.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {primary.map((group, idx) => (
            <MetricCard
              key={group.metricKey}
              clientId={clientId}
              group={group}
              onChanged={onChanged}
              defaultOpen={idx === 0}
            />
          ))}
        </div>
      )}

      {/* Demoted, never deleted. A 1 → 0 click change is a real observation and
          is still inspectable here; it just does not get to look like a
          site-wide emergency next to a 14,542 → 9,212 move. */}
      {lowConfidence.length > 0 && (
        <div className="pt-1">
          <button
            type="button"
            onClick={() => setShowLow((v) => !v)}
            aria-expanded={showLow}
            className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 hover:text-slate-800 transition cursor-pointer"
          >
            {showLow ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <EyeOff size={11} />
            Low-confidence observations ({lowConfidence.length})
          </button>
          {showLow && (
            <div className="mt-2 space-y-2">
              <p className="text-[10.5px] font-medium text-slate-400">
                Statistically real, but on too little volume for the percentage to mean much. Shown
                for completeness, ranked below everything above.
              </p>
              {lowConfidence.map((group) => (
                <div key={group.metricKey} className="rounded-xl border border-slate-200 bg-slate-100/40 p-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11.5px] font-black text-slate-700">{group.metric.display_name}</span>
                    <span className="an-chip an-chip-slate">low volume</span>
                  </div>
                  {group.all.map((i) => (
                    <p key={i.id} className="text-[10.5px] font-medium text-slate-500 mt-1">
                      {finding(i, group.metric)} · {supportingLine(i, group.metric)}
                      <span className="block text-slate-400">{lowConfidenceReason(i, group.metric)}</span>
                    </p>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

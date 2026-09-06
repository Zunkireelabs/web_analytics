import { useEffect, useMemo, useState } from 'react';
import {
  ComposedChart, Area, Line, ReferenceLine, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import {
  AlertTriangle, CheckCircle2, Loader2, Send, ChevronDown, ChevronRight,
  Activity, ShieldCheck, EyeOff, Search,
} from 'lucide-react';
import { api } from '../api.js';
import {
  formatByUnit, finding, supportingLine, groupDeclinesByMetric, lowConfidenceReason,
  SEVERITY_META, TYPE_META,
} from '../lib/analystFormat.js';

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

// One human-readable sentence from data already on the group — never a new
// classification, just phrasing on top of the same real/projected split
// `happened`/`expected` already encode.
function cardTitle(group) {
  const name = group.metric.display_name;
  if (group.happened.length > 0) return `${name} is declining`;
  if (group.expected.length > 0) return `${name} is projected to decline`;
  return `${name} is trending the wrong way`;
}

// The action row — identical logic/state for every card, only the visual
// weight differs between the featured and compact presentations below.
function CardActions({ clientId, primary, canDraft, draftedId, busy, sendToActionCenter, act, compact }) {
  if (!primary) {
    return <span className="text-[10px] font-semibold text-slate-400">Monitoring only — no fix queued for this one yet.</span>;
  }
  const primaryBtnClass = compact
    ? 'text-[11.5px] font-bold text-indigo-600 hover:text-indigo-500 flex items-center gap-1.5 cursor-pointer'
    : 'an-grad-btn text-[12.5px] font-bold px-4 py-2.5 rounded-xl text-white flex items-center gap-1.5 cursor-pointer';
  return (
    <div className={`flex items-center gap-3 flex-wrap ${compact ? '' : 'gap-4'}`}>
      {draftedId ? (
        <a href={`/action-center?siteId=${clientId}`} className="text-[11.5px] font-bold text-emerald-700 hover:underline flex items-center gap-1.5">
          <CheckCircle2 size={compact ? 11 : 13} /> In Action Center
        </a>
      ) : canDraft ? (
        <button type="button" onClick={sendToActionCenter} disabled={busy} className={primaryBtnClass}>
          {busy ? <Loader2 size={compact ? 11 : 13} className="animate-spin" /> : <Send size={compact ? 11 : 13} />}
          Send to Action Center
        </button>
      ) : (
        <span className="text-[10px] font-medium text-slate-400">
          Site-wide — no single page to rewrite, so this is handled by hand rather than drafted.
        </span>
      )}
      <button
        type="button" onClick={() => act('resolve')} disabled={busy}
        className={compact
          ? 'text-[11.5px] font-semibold text-slate-500 hover:text-emerald-700 cursor-pointer'
          : 'text-[12px] font-bold text-slate-600 hover:text-emerald-700 cursor-pointer'}
      >
        Fixed
      </button>
      <button
        type="button" onClick={() => act('dismiss')} disabled={busy}
        className={compact
          ? 'text-[11.5px] font-semibold text-slate-400 hover:text-rose-600 cursor-pointer'
          : 'text-[12px] font-bold text-slate-400 hover:text-rose-600 cursor-pointer'}
      >
        Dismiss
      </button>
    </div>
  );
}

// Evidence + AI recommendation — shared between the featured card (always
// shown) and a compact card (shown once expanded). Same content either way,
// never synthesized here: root_cause/recommendation come verbatim from the
// nightly narration pass, exactly as before.
function CardDetail({ clientId, group, primary }) {
  const { metric, narrated } = group;
  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-white/70 border border-slate-200 p-3">
        <MiniTrend clientId={clientId} metric={metric} />
      </div>

      {narrated?.root_cause && (
        <p className="text-[12.5px] leading-relaxed text-slate-700 font-medium">
          <span className="an-label mr-1.5">Why</span>
          {narrated.root_cause}
          <span className="text-[9.5px] font-bold text-slate-400 ml-1.5 uppercase tracking-wider">AI inference</span>
        </p>
      )}

      <div>
        <span className="block text-[10.5px] font-black uppercase tracking-wider text-indigo-500 mb-1.5">AI recommendation</span>
        {narrated?.recommendation ? (
          <p className="text-[12.5px] leading-relaxed text-slate-800 font-medium">{narrated.recommendation}</p>
        ) : (
          <p className="text-[11.5px] leading-relaxed text-slate-500 font-medium flex items-start gap-1.5">
            <Search size={11} className="shrink-0 mt-0.5 text-slate-400" />
            {group.all.some((i) => i.narration_status === 'failed')
              ? 'Fix guidance could not be generated for this one — the finding itself still stands, and the chart above is the evidence.'
              : 'No fix guidance written for this yet. The finding and its evidence are shown above; guidance is added by the nightly pass.'}
          </p>
        )}
      </div>

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
    </div>
  );
}

function useCardActions(clientId, group, onChanged) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [draftedId, setDraftedId] = useState(null);

  // Actions attach to one insight — the most severe one the backend actually
  // gave a recommendation row to. Without a recommendation_id there is nothing
  // for resolve/dismiss to act on, which is why the fallback is "monitoring
  // only" rather than a button that would silently fail.
  const primary = useMemo(() => group.all.find((i) => i.recommendation_id) || null, [group.all]);

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

  return { primary, canDraft, busy, actionError, draftedId, sendToActionCenter, act };
}

// The single highest-priority finding — visually dominant, always expanded,
// nothing competing with it for attention.
function FeaturedCard({ clientId, group, onChanged }) {
  const { happened, expected, health } = group;
  const { primary, canDraft, busy, actionError, draftedId, sendToActionCenter, act } = useCardActions(clientId, group, onChanged);

  const explain = happened.length > 0
    ? <>{finding(happened[0], group.metric)} <span className="text-slate-500 font-medium">· {supportingLine(happened[0], group.metric)}</span></>
    : expected.length > 0
      ? <>{finding(expected[0], group.metric)} <span className="text-slate-500 font-medium">· {supportingLine(expected[0], group.metric)}</span></>
      : <>Moving the wrong way but not yet past the warning threshold{health.bandCrosses ? ' — the forecast range still reaches it.' : '.'}</>;

  const sevMeta = SEVERITY_META[group.severity] || SEVERITY_META.low;

  return (
    <article className="relative bg-white rounded-2xl border border-slate-200 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_16px_32px_-24px_rgba(15,23,42,0.18)] pl-8 pr-7 py-7">
      <div className="absolute left-0 top-5 bottom-5 w-[3px] rounded-full" style={{ backgroundColor: sevMeta.color }} />

      <div className="flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wider mb-2.5" style={{ color: sevMeta.color }}>
        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: sevMeta.color }} />
        {sevMeta.label} priority
      </div>

      <h3 className="text-[21px] font-black tracking-tight text-slate-900 leading-tight mb-2">{cardTitle(group)}</h3>
      <p className="text-[13.5px] leading-relaxed text-slate-700 font-semibold mb-5 max-w-[56ch]">{explain}</p>

      <div className="pb-2">
        <CardDetail clientId={clientId} group={group} primary={primary} />
      </div>

      {actionError && (
        <p className="text-[11px] font-semibold text-rose-600 flex items-center gap-1.5 mt-3">
          <AlertTriangle size={11} className="shrink-0" />{actionError}
        </p>
      )}

      <div className="mt-6">
        <CardActions
          clientId={clientId} primary={primary} canDraft={canDraft} draftedId={draftedId}
          busy={busy} sendToActionCenter={sendToActionCenter} act={act}
        />
      </div>
    </article>
  );
}

// A lower-priority finding — quiet by default (one line, no chart, no
// background tint), expandable to the exact same evidence a featured card
// shows up front.
function CompactCard({ clientId, group, onChanged }) {
  const { happened, expected } = group;
  const [open, setOpen] = useState(false);
  const { primary, canDraft, busy, actionError, draftedId, sendToActionCenter, act } = useCardActions(clientId, group, onChanged);

  const summary = happened.length > 0
    ? <>{finding(happened[0], group.metric)}</>
    : expected.length > 0
      ? <>{finding(expected[0], group.metric)}</>
      : <>Trending the wrong way, not yet past the warning threshold</>;

  const sevMeta = SEVERITY_META[group.severity] || SEVERITY_META.low;

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider mb-1.5" style={{ color: sevMeta.color }}>
        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: sevMeta.color }} />
        {sevMeta.label}
      </div>
      <h4 className="text-[13.5px] font-bold text-slate-900 leading-snug mb-1">{cardTitle(group)}</h4>
      <p className="text-[11.5px] text-slate-500 font-medium leading-snug mb-3">{summary}</p>

      {actionError && (
        <p className="text-[10.5px] font-semibold text-rose-600 flex items-center gap-1.5 mb-2">
          <AlertTriangle size={10} className="shrink-0" />{actionError}
        </p>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <CardActions
          clientId={clientId} primary={primary} canDraft={canDraft} draftedId={draftedId}
          busy={busy} sendToActionCenter={sendToActionCenter} act={act} compact
        />
        <button
          type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
          className="text-[10.5px] font-bold text-slate-400 hover:text-slate-600 flex items-center gap-1 cursor-pointer shrink-0"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {open ? 'Hide evidence' : 'View evidence'}
        </button>
      </div>

      {open && (
        <div className="mt-4 pt-4 border-t border-slate-100">
          <CardDetail clientId={clientId} group={group} primary={primary} />
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
        <div className="space-y-3">
          {/* The single highest-priority finding — groups is already sorted by
              severity/health (groupDeclinesByMetric), so index 0 is the real
              one to feature, not an arbitrary pick. */}
          <FeaturedCard clientId={clientId} group={primary[0]} onChanged={onChanged} />

          {primary.length > 1 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {primary.slice(1).map((group) => (
                <CompactCard key={group.metricKey} clientId={clientId} group={group} onChanged={onChanged} />
              ))}
            </div>
          )}
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

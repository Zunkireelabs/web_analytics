import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { formatByUnit, pct, finding, supportingLine } from '../lib/analystFormat.js';
import {
  LineChart, TrendingUp, TrendingDown, AlertTriangle, Clock, CheckCircle2, Ban, Loader2, Wrench, Send,
} from 'lucide-react';

// Everything here comes from the already-fetched dashboard payload — no extra
// request. Forecasts are produced nightly by the Python service's analysis
// pass (app/analysis/run_pass.py) from the site's OWN history via SARIMAX/ETS.
//
// Note these are site-wide per metric, not per-page: forecast/run.py loops
// metric_dimension_support and only dimension_type 'site' is ever populated,
// so "which PAGE will lose impressions" is not answerable yet. Nothing here
// claims otherwise.
const HEADLINE_METRIC_KEYS = ['gsc_impressions', 'gsc_clicks'];

function horizonChange(metric) {
  const f = metric?.forecast;
  const last = f?.status === 'ok' && f.points?.length ? f.points[f.points.length - 1] : null;
  if (!last || !metric?.latest_value) return null;
  return {
    endValue: last.point_estimate,
    deltaPct: ((last.point_estimate - metric.latest_value) / Math.abs(metric.latest_value)) * 100,
    horizon: f.horizon_periods,
  };
}

export default function AnalystImpressionForecast({ clientId, dashboard, onChanged }) {
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState(null);
  // insight.id -> draft id, for findings sent to Action Center this session.
  const [drafted, setDrafted] = useState({});

  const metrics = useMemo(
    () => Object.values(dashboard?.groups || {}).flat(),
    [dashboard]
  );

  // Prefer impressions/clicks; fall back to whatever else has a live forecast
  // so a client whose metric keys differ still sees something real.
  const headline = useMemo(() => {
    const preferred = HEADLINE_METRIC_KEYS
      .map((key) => metrics.find((m) => m.metric_key === key))
      .filter(Boolean);
    const chosen = preferred.length
      ? preferred
      : metrics.filter((m) => m.forecast?.status === 'ok').slice(0, 2);
    return chosen.map((m) => ({ metric: m, change: horizonChange(m) }));
  }, [metrics]);

  // Every issue the agent found that represents something going DOWN — not
  // just forecast risks. Mirrors isDecline() in
  // server/agents/lib/analyst-seo-mapping.js so what's listed here is the
  // same set the backend considers actionable.
  const isDecline = (i) => {
    const e = i.evidence || {};
    switch (i.insight_type) {
      case 'forecast_risk': return true;
      case 'anomaly': return e.direction === 'low';
      case 'trend_shift': return typeof e.pct_change === 'number' && e.pct_change < 0;
      case 'milestone': return e.direction === 'down';
      default: return false;
    }
  };

  const warnings = useMemo(() => {
    const order = { high: 0, medium: 1, low: 2 };
    return (dashboard?.insights || [])
      .filter(isDecline)
      .sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
  }, [dashboard]);

  const metricFor = (key) =>
    metrics.find((m) => m.metric_key === key) || { metric_key: key, display_name: key, unit: null };

  // Mirrors seoDraftEligibility (server/agents/lib/analyst-seo-mapping.js) so
  // the button only appears when the server would actually accept it — the
  // route re-validates regardless, this just avoids offering an action that
  // can only 400. Site-wide findings have no page to fix, so they can't
  // become a draft; that's stated inline rather than left as a dead button.
  const canDraft = (i) =>
    i.metric_key?.startsWith('gsc_') && i.dimension_type === 'page' && i.dimension_value;

  const sendToActionCenter = async (insight) => {
    setBusyId(insight.id);
    setActionError(null);
    try {
      const draft = await api.analyst.generateSeoDraft(clientId, insight);
      setDrafted((prev) => ({ ...prev, [insight.id]: draft.id }));
    } catch (e) {
      setActionError(e.message || 'Could not send this to Action Center.');
    } finally {
      setBusyId(null);
    }
  };

  const act = async (insight, kind) => {
    if (!insight.recommendation_id) return;
    setBusyId(insight.id);
    setActionError(null);
    try {
      if (kind === 'resolve') await api.analyst.resolveRecommendation(clientId, insight.recommendation_id);
      else await api.analyst.dismissRecommendation(clientId, insight.recommendation_id);
      onChanged?.();
    } catch (e) {
      setActionError(e.message || 'Failed to update this warning.');
    } finally {
      setBusyId(null);
    }
  };

  const anyForecast = headline.some((h) => h.change);

  return (
    <div className="an-panel p-5 space-y-6">
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-xl grid place-items-center bg-violet-500/10 border border-violet-500/25 text-violet-600 shrink-0">
          <LineChart size={15} />
        </div>
        <div>
          <h2 className="text-xs font-black uppercase tracking-widest text-slate-800">Impression Forecast</h2>
          <p className="text-[11px] font-medium text-slate-500">
            Where traffic is heading, and what's about to drop
          </p>
        </div>
      </div>

      {/* ── Forecast strip ───────────────────────────────────────────── */}
      <section className="space-y-2.5">
        {!anyForecast ? (
          <p className="text-xs font-medium text-slate-500 bg-slate-100/60 border border-slate-200 rounded-xl px-4 py-3">
            No forecast yet. The models need at least 30 days of history for this client (and about
            90 for the seasonal model), and they refresh nightly — this fills in once enough Search
            Console data has been collected.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {headline.map(({ metric, change }) => {
              const falling = change && change.deltaPct < 0;
              return (
                <div
                  key={metric.metric_key}
                  className={`rounded-xl border p-4 ${
                    !change
                      ? 'bg-slate-100/50 border-slate-200'
                      : falling
                      ? 'bg-rose-500/[0.06] border-rose-500/25'
                      : 'bg-emerald-500/[0.06] border-emerald-500/25'
                  }`}
                >
                  <div className="an-label">{metric.display_name}</div>
                  {!change ? (
                    <p className="text-[11px] font-semibold text-slate-500 mt-2">
                      Not enough history to forecast yet.
                    </p>
                  ) : (
                    <>
                      <div className="flex items-baseline gap-2 mt-1.5">
                        <span className="text-xl font-black text-slate-900 tabular-nums">
                          {formatByUnit(metric.latest_value, metric.unit)}
                        </span>
                        <span className="text-slate-400 text-xs font-bold">→</span>
                        <span className="text-xl font-black text-slate-900 tabular-nums">
                          {formatByUnit(change.endValue, metric.unit)}
                        </span>
                      </div>
                      <div
                        className={`flex items-center gap-1 text-xs font-black mt-1.5 ${
                          falling ? 'text-rose-600' : 'text-emerald-600'
                        }`}
                      >
                        {falling ? <TrendingDown size={12} /> : <TrendingUp size={12} />}
                        {pct(change.deltaPct)}
                        <span className="text-slate-400 font-semibold ml-1">
                          over {change.horizon} days
                        </span>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Early warnings ───────────────────────────────────────────── */}
      <section className="space-y-2.5">
        <div className="flex items-center gap-2">
          <Clock size={12} className="text-violet-600 shrink-0" />
          <h3 className="an-label">Issues found</h3>
          {warnings.length > 0 && <span className="an-chip an-chip-rose">{warnings.length}</span>}
        </div>

        {actionError && (
          <p className="text-[11px] font-semibold text-rose-600 flex items-center gap-1.5">
            <AlertTriangle size={11} className="shrink-0" />
            {actionError}
          </p>
        )}

        {warnings.length === 0 ? (
          <p className="text-xs font-medium text-slate-500 bg-slate-100/60 border border-slate-200 rounded-xl px-4 py-3">
            Nothing is dropping right now. Issues appear here when a metric declines, behaves
            abnormally, or is forecast to fall — with the reason and the fix, and enough lead time to
            act first.
          </p>
        ) : (
          <div className="space-y-2">
            {warnings.map((insight) => {
              const metric = metricFor(insight.metric_key);
              const days = insight.evidence?.days_until_drop;
              const busy = busyId === insight.id;
              return (
                <div
                  key={insight.id}
                  className="rounded-xl border border-slate-200 bg-slate-100/40 p-3.5 flex flex-col sm:flex-row sm:items-start gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-black text-slate-800">{finding(insight, metric)}</span>
                      {days != null && (
                        <span className="an-chip an-chip-rose">
                          <Clock size={9} />
                          {days} days out
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] font-medium text-slate-500 mt-1">
                      {supportingLine(insight, metric)}
                    </p>

                    {/* Why it's happening and what to do about it — both come
                        straight from the dashboard payload (the Python
                        recommendation engine writes one sentence each per
                        insight). Rendered only when the narration actually
                        succeeded; a pending or failed narration says so
                        rather than leaving a blank space that reads as
                        "nothing to do here". */}
                    {insight.root_cause && (
                      <p className="text-[11px] font-medium text-slate-600 mt-2">
                        <span className="an-label mr-1.5">Why</span>
                        {insight.root_cause}
                      </p>
                    )}
                    {insight.recommendation && (
                      <p className="text-[11px] font-semibold text-slate-800 mt-1.5 flex items-start gap-1.5">
                        <Wrench size={11} className="shrink-0 mt-0.5 text-indigo-600" />
                        <span>{insight.recommendation}</span>
                      </p>
                    )}
                    {insight.recommendation && !canDraft(insight) && (
                      <p className="text-[10px] font-medium text-slate-400 mt-1.5">
                        Site-wide finding — there's no single page to rewrite, so this one is done by
                        hand rather than drafted in Action Center.
                      </p>
                    )}
                    {!insight.recommendation && insight.narration_status === 'failed' && (
                      <p className="text-[11px] font-medium text-slate-400 mt-2">
                        Couldn't generate fix guidance for this one — the warning itself still stands.
                      </p>
                    )}
                    {!insight.recommendation && insight.narration_status !== 'failed' && (
                      <p className="text-[11px] font-medium text-slate-400 mt-2">
                        Fix guidance is still being written — it appears after tonight's run.
                      </p>
                    )}
                  </div>

                  {insight.recommendation_id ? (
                    <div className="flex items-center gap-2 shrink-0">
                      {drafted[insight.id] ? (
                        <a
                          href="/action-center"
                          className="text-[11px] font-bold text-emerald-700 hover:underline flex items-center gap-1.5"
                        >
                          <CheckCircle2 size={11} />
                          In Action Center
                        </a>
                      ) : canDraft(insight) ? (
                        <button
                          type="button"
                          onClick={() => sendToActionCenter(insight)}
                          disabled={busy}
                          className="an-grad-btn text-[11px] font-bold px-3 py-2 rounded-xl text-white flex items-center gap-1.5 cursor-pointer"
                        >
                          {busy ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
                          Send to Action Center
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => act(insight, 'resolve')}
                        disabled={busy}
                        className="text-[11px] font-bold px-3 py-2 rounded-xl border border-emerald-300 text-emerald-700 hover:bg-emerald-50 transition disabled:opacity-40 flex items-center gap-1.5 cursor-pointer"
                      >
                        {busy ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
                        Fixed
                      </button>
                      <button
                        type="button"
                        onClick={() => act(insight, 'dismiss')}
                        disabled={busy}
                        title="Dismiss"
                        aria-label="Dismiss"
                        className="p-2 rounded-xl border border-slate-300 text-slate-400 hover:text-rose-600 hover:border-rose-300 transition disabled:opacity-40 cursor-pointer"
                      >
                        <Ban size={12} />
                      </button>
                    </div>
                  ) : (
                    // Inline, not a tooltip — a button that silently does
                    // nothing is worse than saying why there's no button.
                    <span className="text-[10px] font-semibold text-slate-400 shrink-0 sm:max-w-[9rem] sm:text-right">
                      Monitoring only — no fix queued for this one yet.
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

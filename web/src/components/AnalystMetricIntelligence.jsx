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
import { CHART, SERIES, STATUS, AXIS_TICK } from '../lib/palette.js';
import Badge from './Badge.jsx';
import Button from './Button.jsx';
import { Tray, TrayCard } from './layout/Tray.jsx';

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

  if (error) return <p className="text-xs text-[#b42318] py-6 text-center">{error}</p>;
  if (!data) return <p className="text-xs text-faint py-6 text-center animate-pulse">Loading trend…</p>;
  if (!rows.merged?.length) return <p className="text-xs text-faint py-6 text-center">No series data for this metric.</p>;

  return (
    <div>
      <ResponsiveContainer width="100%" height={150}>
        <ComposedChart data={rows.merged} margin={{ top: 4, right: 6, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
          <XAxis
            dataKey="date" tick={{ ...AXIS_TICK, fontSize: 9 }}
            axisLine={false} tickLine={false} minTickGap={44}
            tickFormatter={(d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}
          />
          <YAxis
            tick={{ ...AXIS_TICK, fontSize: 9 }} axisLine={false} tickLine={false} width={40}
            tickFormatter={(v) => (metric.unit === 'ratio' ? `${Math.round(v * 100)}%` : Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(v))}
          />
          <Tooltip
            contentStyle={{ fontSize: 12, borderRadius: 8, border: 'none', background: CHART.ink, color: '#fff', padding: '8px 10px' }}
            labelStyle={{ color: '#a3a3a3', marginBottom: 2 }}
            itemStyle={{ color: '#fff', padding: 0 }}
            formatter={(v, name) => [formatByUnit(v, metric.unit), name === 'forecast' ? 'Forecast' : 'Observed']}
            labelFormatter={(d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })}
          />
          {rows.lastActual && (
            <ReferenceLine
              x={rows.lastActual} stroke={CHART.cursor} strokeDasharray="3 3"
              label={{ value: 'Today', position: 'insideTopRight', fontSize: 8, fill: CHART.axis, fontWeight: 700 }}
            />
          )}
          <Area type="monotone" dataKey="band" stroke="none" fill={CHART.highlight} fillOpacity={0.13} connectNulls={false} />
          <Area type="monotone" dataKey="value" stroke={CHART.highlight} strokeWidth={2} fill={CHART.highlight} fillOpacity={0.08} dot={false} connectNulls={false} />
          <Line type="monotone" dataKey="forecast" stroke={SERIES[1]} strokeWidth={2} strokeDasharray="5 5" dot={false} connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint mt-1.5">
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-[2px]" style={{ background: CHART.highlight }} /> Observed</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-[2px]" style={{ background: SERIES[1] }} /> Forecast</span>
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
    return <span className="text-xs text-faint">Monitoring only — no fix queued for this one yet.</span>;
  }
  const size = compact ? 'sm' : 'md';
  const iconSize = compact ? 12 : 14;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {draftedId ? (
        <a href={`/action-center?siteId=${clientId}`} className="text-[13px] font-medium flex items-center gap-1.5 hover:underline" style={{ color: STATUS.good.text }}>
          <CheckCircle2 size={iconSize} /> In Action Center
        </a>
      ) : canDraft ? (
        <Button variant={compact ? 'light' : 'primary'} size={size} onClick={sendToActionCenter} disabled={busy}>
          {busy ? <Loader2 size={iconSize} className="animate-spin" /> : <Send size={iconSize} />}
          Send to Action Center
        </Button>
      ) : (
        <span className="text-xs text-faint">
          Site-wide — no single page to rewrite, so this is handled by hand rather than drafted.
        </span>
      )}
      <Button variant="light" size={size} onClick={() => act('resolve')} disabled={busy}>Fixed</Button>
      <Button variant="ghost" size={size} onClick={() => act('dismiss')} disabled={busy}>Dismiss</Button>
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
      <div className="rounded-card bg-muted p-3">
        <MiniTrend clientId={clientId} metric={metric} />
      </div>

      {narrated?.root_cause && (
        <p className="text-[13px] leading-5 text-text">
          <span className="font-medium text-fg mr-1.5">Why</span>
          {narrated.root_cause}
          <span className="text-xs text-faint ml-1.5">AI inference</span>
        </p>
      )}

      <div>
        <span className="block text-[13px] font-medium text-primary mb-1">AI recommendation</span>
        {narrated?.recommendation ? (
          <p className="text-[13px] leading-5 text-fg">{narrated.recommendation}</p>
        ) : (
          <p className="text-xs leading-5 text-faint flex items-start gap-1.5">
            <Search size={12} className="shrink-0 mt-0.5" />
            {group.all.some((i) => i.narration_status === 'failed')
              ? 'Fix guidance could not be generated for this one — the finding itself still stands, and the chart above is the evidence.'
              : 'No fix guidance written for this yet. The finding and its evidence are shown above; guidance is added by the nightly pass.'}
          </p>
        )}
      </div>

      {group.all.length > 1 && (
        <div className="space-y-1 pt-1">
          <div className="text-xs font-medium text-fg">All signals ({group.all.length})</div>
          {group.all.map((i) => {
            const TypeIcon = TYPE_META[i.insight_type]?.icon || Activity;
            return (
              <div key={i.id} className="flex items-start gap-1.5 text-xs text-text">
                <TypeIcon size={12} className="shrink-0 mt-0.5" style={{ color: TYPE_META[i.insight_type]?.color }} />
                <span>
                  <span className="font-medium text-fg">{TYPE_META[i.insight_type]?.label || i.insight_type}</span>
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
    ? <>{finding(happened[0], group.metric)} <span className="text-faint">· {supportingLine(happened[0], group.metric)}</span></>
    : expected.length > 0
      ? <>{finding(expected[0], group.metric)} <span className="text-faint">· {supportingLine(expected[0], group.metric)}</span></>
      : <>Moving the wrong way but not yet past the warning threshold{health.bandCrosses ? ' — the forecast range still reaches it.' : '.'}</>;

  const sevMeta = SEVERITY_META[group.severity] || SEVERITY_META.low;

  return (
    <article className="rounded-card bg-white p-5" style={{ boxShadow: 'var(--ring)' }}>
      <Badge tone={sevMeta.tone} dot className="mb-2.5">{sevMeta.label} priority</Badge>

      <h3 className="text-[18px] leading-6 font-semibold tracking-[-0.02em] text-fg mb-1.5">{cardTitle(group)}</h3>
      <p className="text-sm leading-5 text-text mb-4 max-w-[64ch]">{explain}</p>

      <CardDetail clientId={clientId} group={group} primary={primary} />

      {actionError && (
        <p className="text-xs text-[#b42318] flex items-center gap-1.5 mt-3">
          <AlertTriangle size={12} className="shrink-0" />{actionError}
        </p>
      )}

      <div className="mt-5">
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
    <div className="rounded-card bg-white p-4" style={{ boxShadow: 'var(--ring)' }}>
      <Badge tone={sevMeta.tone} dot className="mb-1.5">{sevMeta.label}</Badge>
      <h4 className="text-[14px] font-medium text-fg leading-snug mb-1">{cardTitle(group)}</h4>
      <p className="text-xs text-faint leading-snug mb-3">{summary}</p>

      {actionError && (
        <p className="text-xs text-[#b42318] flex items-center gap-1.5 mb-2">
          <AlertTriangle size={12} className="shrink-0" />{actionError}
        </p>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <CardActions
          clientId={clientId} primary={primary} canDraft={canDraft} draftedId={draftedId}
          busy={busy} sendToActionCenter={sendToActionCenter} act={act} compact
        />
        <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="shrink-0">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {open ? 'Hide evidence' : 'View evidence'}
        </Button>
      </div>

      {open && (
        <div className="mt-4 pt-4 border-t border-border">
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
    <div id="an-needs-attention"><Tray>
      <TrayCard
        title="What needs attention"
        subtitle="What happened, what's expected next, why, and what to fix"
        action={primary.length > 0 ? <Badge tone="red">{primary.length}</Badge> : null}
      >
        <div className="px-4 pb-4 space-y-3">
          {primary.length === 0 ? (
            <div className="flex items-start gap-2.5 rounded-card px-4 py-3" style={{ background: STATUS.good.tint }}>
              <ShieldCheck size={16} className="shrink-0 mt-0.5" style={{ color: STATUS.good.color }} />
              <p className="text-[13px] text-fg">
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
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
            <div>
              <Button variant="ghost" size="sm" onClick={() => setShowLow((v) => !v)} aria-expanded={showLow}>
                {showLow ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <EyeOff size={12} />
                Low-confidence observations ({lowConfidence.length})
              </Button>
              {showLow && (
                <div className="mt-2 space-y-2">
                  <p className="text-xs text-faint">
                    Statistically real, but on too little volume for the percentage to mean much. Shown
                    for completeness, ranked below everything above.
                  </p>
                  {lowConfidence.map((group) => (
                    <div key={group.metricKey} className="rounded-card bg-muted p-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13px] font-medium text-fg">{group.metric.display_name}</span>
                        <Badge tone="grey">low volume</Badge>
                      </div>
                      {group.all.map((i) => (
                        <p key={i.id} className="text-xs text-text mt-1">
                          {finding(i, group.metric)} · {supportingLine(i, group.metric)}
                          <span className="block text-faint">{lowConfidenceReason(i, group.metric)}</span>
                        </p>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </TrayCard>
    </Tray></div>
  );
}

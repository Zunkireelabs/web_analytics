// Turns a period's real numbers into the sections of the branded report Doc (doc-layout.js). Pure: no database, no
// model calls, so every figure printed in a client's report is arithmetic on data we have, and anything we do not
// have is left out rather than made up (no "what we did" results, no baseline column without a baseline).
const n = (v) => (v == null ? 0 : Number(v));
const fmt = (v) => n(v).toLocaleString('en-US');
const fmtK = (v) => (n(v) >= 10000 ? `${(n(v) / 1000).toFixed(1)}k` : fmt(v));
const sum = (rows, k) => rows.reduce((a, r) => a + n(r[k]), 0);

// Impression-weighted average position (lower is better); null when there were no impressions to weight by.
export function avgPosition(rows) {
  let w = 0, t = 0;
  for (const r of rows) if (r.position != null && n(r.impressions) > 0) { w += n(r.impressions); t += Number(r.position) * n(r.impressions); }
  return w ? t / w : null;
}

export function periodStats(rows) {
  return {
    clicks: sum(rows, 'clicks'), impressions: sum(rows, 'impressions'), users: sum(rows, 'users'), sessions: sum(rows, 'sessions'),
    position: avgPosition(rows), days: rows.filter((r) => r.clicks != null || r.impressions != null).length,
  };
}

export const pctChange = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 100) : null);

// "▲ 12% vs prior week" with the tone the tile colours it; null prev => no comparison, said plainly.
export function deltaFor(cur, prev, vs) {
  const p = pctChange(cur, prev);
  if (p == null) return { delta: 'no prior period to compare', tone: 'flat' };
  if (p === 0) return { delta: `no change vs ${vs}`, tone: 'flat' };
  return { delta: `${p > 0 ? '▲' : '▼'} ${Math.abs(p)}% vs ${vs}`, tone: p > 0 ? 'good' : 'bad' };
}

export function positionDelta(cur, prev, vs) {
  if (cur == null || prev == null) return { delta: ' ', tone: 'flat' };
  const d = Math.round((prev - cur) * 10) / 10;
  if (d === 0) return { delta: `no change vs ${vs}`, tone: 'flat' };
  return { delta: `${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)} ${d > 0 ? 'better' : 'worse'}`, tone: d > 0 ? 'good' : 'bad' };
}

export function tilesFor(cur, prev, vs) {
  return [
    { label: 'Impressions', value: fmtK(cur.impressions), ...deltaFor(cur.impressions, prev?.impressions, vs) },
    { label: 'Clicks', value: fmt(cur.clicks), ...deltaFor(cur.clicks, prev?.clicks, vs) },
    { label: 'Avg position', value: cur.position == null ? '—' : cur.position.toFixed(1), ...positionDelta(cur.position, prev?.position, vs) },
    { label: 'Users', value: fmt(cur.users), ...deltaFor(cur.users, prev?.users, vs) },
  ];
}

// A headline that only states what the numbers say.
export function headlineFor(cur, prev, period, vs) {
  const p = pctChange(cur.clicks, prev?.clicks);
  if (p == null) return `${fmt(cur.clicks)} clicks and ${fmtK(cur.impressions)} impressions ${period}`;
  if (p > 0) return `Clicks are up ${p}% on ${vs}`;
  if (p < 0) return `A quieter ${period === 'this month' ? 'month' : 'week'}: clicks are down ${Math.abs(p)}% on ${vs}`;
  return `Clicks held steady on ${vs}`;
}

// "Overall betterment since your baseline". Compared per day, because the baseline was a 30-day window and a report
// covers 7 or ~30 days; a per-day average is the only like-for-like. null when there is nothing honest to show:
// no baseline, a baseline with under a week of data, or a baseline taken after this period ended.
export function bettermentTable({ baseline, baselineAt, periodEnd, cur, prev, currentHealth, labels }) {
  if (!baseline || n(baseline.daysOfHistory) < 7) return null;
  // pg hands back a Date; String(Date) starts with the weekday name and would compare as later than any ISO date.
  const at = baselineAt instanceof Date ? baselineAt.toISOString().slice(0, 10) : String(baselineAt || '').slice(0, 10);
  if (at && periodEnd && at > periodEnd) return null;
  const per = (total, days) => (days > 0 ? total / days : null);
  const rows = [];
  for (const [label, key] of [['Clicks per day', 'clicks'], ['Impressions per day', 'impressions']]) {
    const base = per(n(baseline[key]), n(baseline.daysOfHistory));
    const now = per(cur[key], cur.days);
    const before = prev ? per(prev[key], prev.days) : null;
    const f = (v) => (v == null ? '—' : v >= 100 ? fmt(Math.round(v)) : v.toFixed(1));
    const ch = base ? Math.round(((now - base) / base) * 100) : null;
    rows.push([label, f(base), f(before), f(now), ch == null || now == null ? '—' : { t: `${ch >= 0 ? '▲ +' : '▼ −'}${Math.abs(ch)}%`, tone: ch >= 0 ? 'good' : 'bad' }]);
  }
  if (baseline.healthScore != null && currentHealth != null) {
    const d = Math.round(currentHealth - baseline.healthScore);
    rows.push(['Health score', String(Math.round(baseline.healthScore)), '—', String(Math.round(currentHealth)), { t: `${d >= 0 ? '▲ +' : '▼ −'}${Math.abs(d)}`, tone: d >= 0 ? 'good' : 'bad' }]);
  }
  return {
    title: 'Overall betterment since your baseline',
    sub: 'Averages per day, from the first audit to now. Every report adds to this.',
    table: { head: ['Measure', 'Baseline', labels.prev, labels.cur, 'Since baseline'], rows },
  };
}

export const topSearchesSection = (queries) => (queries?.length ? {
  title: 'Top searches', sub: 'What people typed into Google to find you',
  table: { head: ['Search', 'Clicks'], rows: queries.map((q) => [String(q.dim_value ?? q.query), fmt(q.clicks)]) },
} : null);

// What a PostHog "step" is called to a person. A pageview arrives as "page: /pricing" and reads as "The /pricing page";
// a custom event ("signup_form_viewed") is the client's own name for something, so it is only de-snaked, never
// reinterpreted — guessing what an event means would put words in a client's mouth.
export function humanStep(step) {
  const raw = String(step ?? '').trim();
  if (!raw) return '';
  const page = /^page:\s*(.+)$/.exec(raw);
  if (page) return `The ${page[1]} page`;
  const spaced = raw.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The PostHog part of a report: what visitors DID, and where they stopped. Two sections, because they answer two
 * different questions and a table can only hold one shape.
 *
 * `summary` is store/project-posthog.js getPosthogSummary's shape, or null. Null means this project does not use
 * PostHog — a normal state — so NOTHING is returned: no empty heading, no "not connected" line in a client's report.
 *
 * `key` marks these so the on-screen page can tell the report body already carries them and not draw its own card.
 */
export function visitorBehaviourSections(summary) {
  if (!summary || !summary.days) return [];

  const partial = summary.measured_days > 0 && summary.measured_days < summary.days;
  // People are the PEAK day, never a sum: the same person returning on two days is one person, so adding daily
  // counts would overstate reach. Labelled as such so nobody reads it as a period total.
  const rows = [
    ['Visits (sessions)', fmt(summary.sessions)],
    ['Pages viewed', fmt(summary.pageviews)],
    ['Actions recorded', fmt(summary.events)],
    ['People, on the busiest day', fmt(summary.peak_daily_people)],
  ];

  const out = [{
    key: 'visitor-behaviour',
    title: 'What visitors did',
    sub: partial
      ? `From your PostHog — covers ${summary.measured_days} of ${summary.days} days; PostHog returned nothing for the rest`
      : 'From your PostHog — what people did once they arrived, not only how many came',
    table: { head: ['Measure', 'Total'], rows },
  }];

  const drops = (summary.topDropOffs || []).filter((d) => d?.event).slice(0, 5);
  if (drops.length) {
    const visits = summary.sessions == null ? null : n(summary.sessions);
    const share = (t) => (visits ? `${Math.round((n(t) / visits) * 100)}%` : '—');
    const m = behaviourModel(summary, null, '');
    out.push({
      key: 'visitor-behaviour-stops',
      title: 'Where people stopped',
      sub: m?.takeaway || 'The last step before a visit ended: the place to look first',
      table: { head: ['Step', 'Visits ending here', 'Share of visits'], rows: drops.map((d) => [humanStep(d.event), fmt(d.sessions_ending_here), share(d.sessions_ending_here)]) },
    });
  }
  return out;
}

// "More visits end on The /pricing page than anywhere else": a rule over the ranked list, never a claim about WHY.
// Null when there is nothing to rank or no visit total to take a share of.
function stopTakeaway(top, share) {
  if (!top || share == null) return null;
  return `More visits end on ${top.label} than anywhere else, ${share}% of all visits. We will review what a visitor needs to see there.`;
}

/**
 * The PostHog part of a report in the shape the on-screen report draws it (tiles + a ranked "where visits ended" list
 * + one takeaway). The Google Doc and PDF keep using visitorBehaviourSections' tables; both are built from the same
 * summary so the two can never disagree.
 *
 * `prev` is the same summary for the period before (or null): tile changes are only stated when it exists, and never
 * for the busiest-day people figure, which is a maximum and so is not comparable with a total. Null when this project
 * has no PostHog data in the period, a normal state that must leave no trace in a client's report.
 */
export function behaviourModel(summary, prev, vs) {
  if (!summary || !summary.days) return null;
  const partial = summary.measured_days > 0 && summary.measured_days < summary.days;
  // A change is only a fair comparison between two periods PostHog measured in full. Connected mid-period, the earlier
  // period covers only some of its days, and comparing a whole period with part of one would print a large false gain.
  const full = (x) => Boolean(x) && x.days > 0 && (x.measured_days == null || x.measured_days >= x.days);
  const comparable = full(summary) && full(prev);
  const tile = (label, key) => {
    const cur = summary[key];
    const d = comparable && prev[key] != null && cur != null ? deltaFor(n(cur), n(prev[key]), vs) : null;
    return { label, value: cur == null ? '—' : fmt(cur), delta: d && d.tone !== 'flat' ? d.delta : null, tone: d?.tone || 'flat' };
  };
  const visits = summary.sessions == null ? null : n(summary.sessions);
  const stops = (summary.topDropOffs || []).filter((d) => d?.event).slice(0, 5).map((d) => {
    const times = n(d.sessions_ending_here);
    const isPage = /^page:\s*/.test(String(d.event));
    return {
      label: humanStep(d.event), raw: isPage ? null : String(d.event), n: times,
      share: visits ? Math.round((times / visits) * 100) : null,
    };
  });
  return {
    tiles: [
      tile('Pages viewed', 'pageviews'), tile('Visits', 'sessions'), tile('Actions taken', 'events'),
      { label: 'People, busiest day', value: summary.peak_daily_people == null ? '—' : fmt(summary.peak_daily_people), delta: 'highest single day', tone: 'flat' },
    ],
    visits, stops,
    takeaway: stopTakeaway(stops[0], stops[0]?.share),
    note: partial ? `Covers ${summary.measured_days} of ${summary.days} days; your analytics returned nothing for the rest.` : null,
  };
}

export { fmt, fmtK };

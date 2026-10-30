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

export { fmt, fmtK };

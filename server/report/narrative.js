import { callLLM } from '../llm.js';
import { getDailySeries, getBreakdown } from '../store/read.js';
import { daysAgoInTz } from '../util/dates.js';

const pct = (cur, prev) => {
  if (prev == null || Number(prev) === 0) return null;
  return Math.round(((Number(cur) - Number(prev)) / Number(prev)) * 1000) / 10;
};

// Build a compact data digest (yesterday vs prior day + 7-day average) and ask
// Claude to write a short plain-English narrative for a non-technical reader.
export async function generateNarrative(site, reportDate) {
  // Pull the last 8 days so we can compute prior-day and 7-day-average deltas.
  const start = daysAgoForDate(reportDate, 7);
  const series = await getDailySeries(site.id, start, reportDate);
  const today = series.find((r) => iso(r.date) === reportDate) || {};
  const prior = series.find((r) => iso(r.date) === daysAgoForDate(reportDate, 1)) || {};

  const window = series.filter((r) => iso(r.date) !== reportDate);
  const avg = (k) => {
    const vals = window.map((r) => Number(r[k])).filter((v) => !Number.isNaN(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  const topQueries = await getBreakdown(site.id, reportDate, 'query', 5);

  const digest = {
    date: reportDate,
    site: site.name,
    metrics: {
      clicks:      { value: today.clicks,      vsPrior: pct(today.clicks, prior.clicks),           vs7dAvg: pct(today.clicks, avg('clicks')) },
      impressions: { value: today.impressions, vsPrior: pct(today.impressions, prior.impressions), vs7dAvg: pct(today.impressions, avg('impressions')) },
      avgPosition: { value: today.position,    vsPrior: pct(today.position, prior.position) },
      users:       { value: today.users,       vsPrior: pct(today.users, prior.users),             vs7dAvg: pct(today.users, avg('users')) },
      sessions:    { value: today.sessions,    vsPrior: pct(today.sessions, prior.sessions),       vs7dAvg: pct(today.sessions, avg('sessions')) },
      conversions: { value: today.conversions, vsPrior: pct(today.conversions, prior.conversions) },
    },
    topQueries: topQueries.map((q) => ({ query: q.dim_value, clicks: q.clicks, impressions: q.impressions })),
  };

  const system =
    'You are an analytics assistant writing a short daily website performance note for a ' +
    'non-technical business owner. Be concrete and plain. 3-5 short sentences. Lead with the ' +
    'actual Search numbers (clicks, impressions, average position) for the day, then call out the ' +
    'single most notable change (good or bad) and one likely driver if the data hints at one ' +
    '(e.g. a top query). Always state the real numbers you are given, even if small — do NOT say ' +
    'metrics are unavailable when clicks or impressions are present. A lower average Search position ' +
    'number is BETTER. This is a low-traffic site, so zero GA4 visitors on a given day is normal — ' +
    'just note it plainly. Only say data "may still be finalizing" if clicks AND impressions are both ' +
    'zero. No preamble, no bullet symbols, no markdown headers.';
  const user =
    `Here is today's data digest (percentages are change vs prior day / vs 7-day average):\n\n${JSON.stringify(digest, null, 2)}`;

  return callLLM(system, user);
}

// --- small date helpers operating on an explicit YYYY-MM-DD anchor ---
function iso(d) {
  return typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10);
}
function daysAgoForDate(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

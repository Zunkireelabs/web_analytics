// Pure logic behind the Overview page: which date range a preset means, what to compare it with,
// short number formats, and the rule-based "Quick insights". No React in here, so it is easy to test.

const DAY = 86400000;

// YYYY-MM-DD, `days` earlier. UTC, so the day never shifts with the viewer's time zone.
export function shiftYmd(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(startYmd, endYmd) {
  return Math.round((new Date(`${endYmd}T00:00:00Z`) - new Date(`${startYmd}T00:00:00Z`)) / DAY);
}

// The quick ranges. `days` counts back from the newest day we have data for.
export const PRESETS = [
  { key: '3', label: '3 days', days: 3 },
  { key: '7', label: '7 days', days: 7 },
  { key: '14', label: '14 days', days: 14 },
  { key: '28', label: '28 days', days: 28 },
  { key: '90', label: '3 months', days: 90 },
  { key: '180', label: '6 months', days: 180 },
  { key: '365', label: '12 months', days: 365 },
  { key: 'all', label: 'All time', days: null },
];
// The ones shown in the bar. The rest live under "More".
export const BAR_KEYS = ['7', '28', '90'];

export function presetRange(anchor, key, earliest) {
  const p = PRESETS.find((x) => x.key === key);
  if (!p) return null;
  if (p.days == null) return earliest ? { start: earliest, end: anchor } : null;
  return { start: shiftYmd(anchor, p.days), end: anchor };
}

// Which preset a start/end pair is, or 'custom'.
export function rangeKeyFor(start, end, anchor, earliest) {
  if (end !== anchor) return 'custom';
  for (const p of PRESETS) {
    const r = presetRange(anchor, p.key, earliest);
    if (r && r.start === start) return p.key;
  }
  return 'custom';
}

export function labelForKey(key) {
  return PRESETS.find((p) => p.key === key)?.label || 'Custom';
}

export const COMPARE_MODES = [
  { key: 'none', label: 'No comparison' },
  { key: 'prev', label: 'Previous period' },
  { key: 'year', label: 'Same period last year' },
  { key: 'custom', label: 'Custom' },
];

function yearBack(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

// The range to compare with. null when comparing is off or a custom range is incomplete.
export function compareRange(mode, start, end, custom) {
  if (mode === 'prev') {
    const len = daysBetween(start, end);
    const priorEnd = shiftYmd(start, 1);
    return { start: shiftYmd(priorEnd, len), end: priorEnd };
  }
  if (mode === 'year') return { start: yearBack(start), end: yearBack(end) };
  if (mode === 'custom' && custom?.start && custom?.end && custom.start <= custom.end) return { start: custom.start, end: custom.end };
  return null;
}

export function isYmd(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// 54200 -> "54.2K", 1470 -> "1,470", 2_300_000 -> "2.3M"
export function compact(n) {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return Math.round(v).toLocaleString('en-US');
}

// Relative change in %, rounded to 1 decimal. null when there is nothing to compare with.
export function pctDelta(cur, prev) {
  if (!prev) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

// Period totals from the daily rows. Position is the one metric that must be weighted by impressions and must
// skip days with no finalized Search Console data (a missing position is not rank 0).
export function seriesTotals(series = []) {
  const sum = (k) => series.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const impressions = sum('impressions');
  const clicks = sum('clicks');
  const rows = series.filter((r) => r.position != null && r.impressions != null);
  const w = rows.reduce((a, r) => a + Number(r.impressions), 0);
  const position = w > 0 ? rows.reduce((a, r) => a + Number(r.position) * Number(r.impressions), 0) / w : null;
  return { impressions, clicks, ctr: impressions > 0 ? clicks / impressions : 0, position, users: sum('users'), sessions: sum('sessions'), conversions: sum('conversions') };
}

export function paginate(rows, page, size) {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, page), pages);
  const from = total === 0 ? 0 : (p - 1) * size;
  return { rows: rows.slice(from, from + size), page: p, pages, from: total === 0 ? 0 : from + 1, to: Math.min(total, from + size), total };
}

// ───────── Quick insights (rules over real numbers, no model) ─────────

const num = (v) => Number(v || 0);
const pathname = (v) => { try { return new URL(v).pathname || '/'; } catch { return v || '/'; } };
const IMPACT_ORDER = { high: 0, medium: 1, low: 2 };

// Returns up to `max` insights, most important first. Each one:
//   { key, tag: 'opportunity'|'attention'|'growth', impact: 'high'|'medium'|'low', icon, title, parts, action?, to? }
// `parts` is the sentence in pieces ({ t, b? }) so the numbers can be bold without putting markup in the data.
export function buildInsights({ channels = [], queries = [], pages = [], totalImpressions = 0 }, max = 3) {
  const out = [];

  const sessions = channels.reduce((s, c) => s + num(c.sessions), 0);
  const topChannel = [...channels].sort((a, b) => num(b.sessions) - num(a.sessions))[0];
  if (topChannel && sessions > 0) {
    const share = Math.round((num(topChannel.sessions) / sessions) * 100);
    if (share >= 70) {
      out.push({
        key: 'channel', tag: 'opportunity', impact: 'medium', icon: 'trend',
        title: `Most visits come from ${topChannel.channel}`,
        parts: [{ t: `${share}%`, b: true }, { t: ` of sessions in this period came from ${topChannel.channel}. Other channels are small.` }],
        action: 'Diversify channels', to: '/insights',
      });
    }
  }

  const byImpr = [...queries].sort((a, b) => num(b.impressions) - num(a.impressions));
  const top5 = byImpr.slice(0, 5);
  const top5Clicks = top5.reduce((s, q) => s + num(q.clicks), 0);
  const top5Impr = top5.reduce((s, q) => s + num(q.impressions), 0);
  if (top5.length && top5Clicks === 0 && top5Impr > 0) {
    out.push({
      key: 'zero-clicks', tag: 'attention', impact: 'high', icon: 'search',
      title: 'Your top searches get no clicks',
      parts: [{ t: 'Your top queries have ' }, { t: `${compact(top5Impr)} impressions`, b: true }, { t: ' and no clicks yet. Better titles and descriptions usually fix this.' }],
      action: 'Improve titles and descriptions',
    });
  } else {
    const allImpr = queries.reduce((s, q) => s + num(q.impressions), 0);
    const allClicks = queries.reduce((s, q) => s + num(q.clicks), 0);
    const avgCtr = allImpr > 0 ? allClicks / allImpr : 0;
    const weak = byImpr.find((q) => num(q.impressions) >= 100 && avgCtr > 0 && num(q.clicks) / num(q.impressions) < avgCtr * 0.6);
    if (weak) {
      const ctr = (num(weak.clicks) / num(weak.impressions)) * 100;
      out.push({
        key: 'low-ctr', tag: 'attention', impact: 'medium', icon: 'search',
        title: 'People see you but do not click',
        parts: [{ t: `"${weak.dim_value}"` }, { t: ' is seen ' }, { t: `${compact(weak.impressions)} times`, b: true }, { t: ' but only ' }, { t: `${ctr.toFixed(1)}%`, b: true }, { t: ` click, below your ${(avgCtr * 100).toFixed(1)}% average. Better titles usually fix this.` }],
        action: 'Improve title and description',
      });
    }
  }

  const topPage = [...pages].sort((a, b) => num(b.impressions) - num(a.impressions))[0];
  if (topPage) {
    const base = totalImpressions > 0 ? totalImpressions : pages.reduce((s, p) => s + num(p.impressions), 0);
    const share = base > 0 ? num(topPage.impressions) / base : 0;
    if (share >= 0.15) {
      out.push({
        key: 'top-page', tag: 'opportunity', impact: share >= 0.3 ? 'high' : 'medium', icon: 'page',
        title: 'One page drives most of your reach',
        parts: [{ t: `"${pathname(topPage.dim_value)}"` }, { t: ' brings ' }, { t: `${compact(topPage.impressions)} impressions`, b: true }, { t: `, ${Math.round(share * 100)}% of what people see. Pages that link to it can send it even more traffic.` }],
        action: 'Improve internal links',
      });
    }
  }

  const nearMiss = byImpr.filter((q) => q.avg_position != null && num(q.avg_position) >= 6 && num(q.avg_position) <= 15 && num(q.impressions) >= 50);
  if (nearMiss.length >= 2) {
    out.push({
      key: 'page-one', tag: 'growth', impact: 'medium', icon: 'idea',
      title: 'Close to page one',
      parts: [{ t: 'You rank 6 to 15 for ' }, { t: `${nearMiss.length} searches`, b: true }, { t: `, like "${nearMiss[0].dim_value}". A focused page could move them onto page one.` }],
      action: 'Create focused content',
    });
  } else if (byImpr.length >= 2) {
    out.push({
      key: 'expand', tag: 'growth', impact: 'low', icon: 'idea',
      title: 'A topic worth its own page',
      parts: [{ t: 'Create focused content around ' }, { t: `"${byImpr[0].dim_value}"`, b: true }, { t: ' to capture search demand.' }],
      action: 'Create focused content',
    });
  }

  out.sort((a, b) => IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact]);
  return out.slice(0, max);
}

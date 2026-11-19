import { botById } from './bots.js';
import { OTHER_PATH } from './aggregate.js';

// Daily counts -> what the dashboard shows. Pure: it gets one project's rows (already filtered to that project by the store) and
// knows nothing about who is asking.
//
// What counts: VERIFIED visits by AI crawlers (ai !== false). Googlebot (ai: false) is reported separately for reference so
// its volume never drowns the AI numbers. Unverified visits (right name, wrong address) are never counted as a crawler; they are
// reported as their own number. "Unchecked" visits (Meta publishes no address list) are counted apart: real as far as we can tell,
// but not provable, so they are shown but kept out of the verified total.

const isAi = (id) => botById(id)?.ai !== false;
const dayMs = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** '/a/b/' and 'https://x.com/a/b' and '/a/b' all become '/a/b'. */
export function normalizePath(p) {
  let s = String(p || '');
  if (/^https?:\/\//i.test(s)) { try { s = new URL(s).pathname; } catch { /* keep */ } }
  s = s.split('?')[0].split('#')[0];
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}

export function periodBounds(days, today = new Date()) {
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const start = end - (days - 1) * dayMs;
  return { from: iso(start), to: iso(end), prevFrom: iso(start - days * dayMs), prevTo: iso(start - dayMs) };
}

const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null);

/**
 * @param rows        rows for [prevFrom, to] from getCrawlerRows(siteId, ...)
 * @param inventory   the project's page paths (page_inventory), used for "pages reached" and "pages not read"
 */
export function summarize(rows, { days = 28, today = new Date(), inventory = [] } = {}) {
  const b = periodBounds(days, today);
  const cur = rows.filter((r) => r.day >= b.from && r.day <= b.to);
  const prev = rows.filter((r) => r.day >= b.prevFrom && r.day <= b.prevTo);
  const verifiedAi = (list) => list.filter((r) => r.verification === 'verified' && isAi(r.botId));
  const sum = (list) => list.reduce((n, r) => n + r.hits, 0);

  const curV = verifiedAi(cur);
  const visits = sum(curV);
  const prevVisits = sum(verifiedAi(prev));

  const inv = [...new Set(inventory.map(normalizePath))];
  const reached = new Set(curV.filter((r) => r.status < 400 && r.path !== OTHER_PATH).map((r) => normalizePath(r.path)));
  const reachedInInventory = inv.filter((p) => reached.has(p));
  const notRead = inv.filter((p) => !reached.has(p));

  // Per crawler (every recognised bot that appeared in the period, including Googlebot, flagged by `ai`).
  const per = new Map();
  for (const r of cur) {
    const bot = botById(r.botId);
    if (!bot) continue;
    let o = per.get(r.botId);
    if (!o) per.set(r.botId, (o = { id: bot.id, label: bot.label, vendor: bot.vendor, kind: bot.kind, ai: bot.ai !== false, verifiable: bot.list != null, visits: 0, unverified: 0, unchecked: 0, errors: 0, lastDay: null, pages: new Map(), perDay: new Map() }));
    if (r.verification === 'verified') {
      o.visits += r.hits;
      if (r.status >= 400) o.errors += r.hits;
      if (!o.lastDay || r.day > o.lastDay) o.lastDay = r.day;
      const key = r.path === OTHER_PATH ? OTHER_PATH : normalizePath(r.path);
      const pg = o.pages.get(key) || { path: key, visits: 0, lastDay: r.day, statuses: new Set() };
      pg.visits += r.hits; pg.statuses.add(r.status); if (r.day > pg.lastDay) pg.lastDay = r.day;
      o.pages.set(key, pg);
      o.perDay.set(r.day, (o.perDay.get(r.day) || 0) + r.hits);
    } else if (r.verification === 'unverified') o.unverified += r.hits;
    else o.unchecked += r.hits;
  }
  const crawlers = [...per.values()].map((o) => ({
    id: o.id, label: o.label, vendor: o.vendor, kind: o.kind, ai: o.ai, verifiable: o.verifiable,
    visits: o.visits, unverified: o.unverified, unchecked: o.unchecked, errors: o.errors, lastDay: o.lastDay,
    pagesRead: [...o.pages.keys()].filter((k) => k !== OTHER_PATH).length,
    pages: [...o.pages.values()].sort((a, c) => c.visits - a.visits).slice(0, 25).map((p) => ({ path: p.path, visits: p.visits, lastDay: p.lastDay, status: Math.max(...p.statuses) })),
    daily: Object.fromEntries(o.perDay),
  })).sort((a, c) => (Number(c.ai) - Number(a.ai)) || c.visits - a.visits || c.unchecked - a.unchecked);

  // Daily series for the chart: verified AI visits per day, split by company, zero-filled so a quiet day shows as quiet.
  const daily = [];
  for (let t = Date.parse(b.from); t <= Date.parse(b.to); t += dayMs) daily.push({ day: iso(t), total: 0, byVendor: {} });
  const at = new Map(daily.map((d) => [d.day, d]));
  for (const r of curV) {
    const d = at.get(r.day); const v = botById(r.botId).vendor;
    d.total += r.hits; d.byVendor[v] = (d.byVendor[v] || 0) + r.hits;
  }

  const unverifiedAi = cur.filter((r) => r.verification === 'unverified' && isAi(r.botId));
  const uncheckedAi = cur.filter((r) => r.verification === 'unchecked' && isAi(r.botId));
  const googlebot = cur.filter((r) => r.botId === 'googlebot' && r.verification === 'verified');

  return {
    period: { days, from: b.from, to: b.to, prevFrom: b.prevFrom, prevTo: b.prevTo },
    totals: {
      visits, prevVisits, change: pct(visits, prevVisits),
      crawlersSeen: crawlers.filter((c) => c.ai && c.visits > 0).length,
      crawlersWatched: 0, // filled in by the route (it knows the catalogue)
      pagesReached: reachedInInventory.length, pagesTotal: inv.length,
      errors: sum(curV.filter((r) => r.status >= 400)),
      unverified: sum(unverifiedAi), unchecked: sum(uncheckedAi),
      googlebotVisits: sum(googlebot),
    },
    crawlers, daily,
    pagesNotRead: { total: notRead.length, items: notRead.slice(0, 20) },
  };
}

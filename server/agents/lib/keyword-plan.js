// The Keywords page's logic, kept free of the database so it can be tested on its own: what the site
// already ranks for, what people search that it has no page for, what to recommend for each, and which
// pages rank for what. Real numbers only: impressions, clicks and positions come from Search Console
// rows (gsc_query_page), search volume from the keyword research already stored on keyword_gaps.
// Nothing here invents a figure; the one estimate, "could bring you", is labelled as one and uses a
// single stated share of a keyword's monthly searches.

export const PLANS = ['blog', 'landing', 'track'];

// Share of a keyword's monthly searches that become impressions once a page reaches page 1. A rough
// average across positions 1 to 10, shown to the person as an estimate and never stored.
export const PAGE_ONE_SHARE = 0.25;

const TOP_N_SUGGESTIONS = 5;
const WHY_MAX = 140;

export const normalizeKeyword = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

export function estimatePotentialImpressions(volume) {
  const v = Number(volume);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.max(10, Math.round((v * PAGE_ONE_SHARE) / 10) * 10);
}

// What to recommend for a keyword. The blog/landing choice mirrors gapDraftEligibility's generator rule
// (analyst-seo-mapping.js: commercial intent on something the site sells gets a landing page, anything
// else a blog), and "track" covers the cases where that rule would draft nothing, so the page never
// recommends something the server would then refuse to create.
export function recommendPlanForGap(gap) {
  if (gap?.existing_page_match || gap?.coverage_status === 'covered' || gap?.coverage_status === 'duplicate') {
    return { plan: 'track', reason: 'A page on your site already targets this, so tracking is enough.' };
  }
  if (gap?.product_relevance === 'unrelated' && gap?.search_intent === 'informational') {
    return { plan: 'track', reason: 'This is not what you sell, so it is better watched than written for.' };
  }
  const commercial = gap?.search_intent === 'commercial' || gap?.search_intent === 'transactional';
  if (commercial && gap?.product_relevance === 'direct') {
    return { plan: 'landing', reason: 'People searching this are ready to buy, and it matches what you sell. A landing page fits.' };
  }
  if (gap?.search_intent === 'informational') {
    return { plan: 'blog', reason: 'People searching this want to learn. A guide earns that traffic, then points them to what you sell.' };
  }
  return { plan: 'blog', reason: 'A blog post is the safest way to start on this keyword.' };
}

// ───────── keywords the site already has ─────────

// Search Console rows are (keyword, page) pairs. A keyword that earns on several pages is one keyword
// here: its numbers are totals, and the page shown is the one that earns the most impressions for it.
export function buildHaveKeywords(metrics) {
  const byKeyword = new Map();
  for (const m of metrics || []) {
    const key = normalizeKeyword(m.query);
    if (!key) continue;
    const row = byKeyword.get(key) || { keyword: key, impressions: 0, clicks: 0, posWeight: 0, pages: new Map() };
    row.impressions += m.impressions;
    row.clicks += m.clicks;
    if (m.avgPosition != null) row.posWeight += m.avgPosition * m.impressions;
    row.pages.set(m.page, (row.pages.get(m.page) || 0) + m.impressions);
    byKeyword.set(key, row);
  }
  return [...byKeyword.values()]
    .map((r) => {
      const [page] = [...r.pages.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        keyword: r.keyword, page, pageCount: r.pages.size,
        impressions: r.impressions, clicks: r.clicks,
        position: r.impressions ? Math.round((r.posWeight / r.impressions) * 10) / 10 : null,
      };
    })
    .sort((a, b) => b.impressions - a.impressions);
}

// ───────── keywords people search that the site does not have ─────────

function trendOf(gap) {
  const snaps = Array.isArray(gap.evidence_snapshots) ? gap.evidence_snapshots : [];
  const points = snaps.map((s) => Number(s?.impressions)).filter((n) => Number.isFinite(n)).slice(-6);
  if (points.length < 2) return null;
  const first = points[0], last = points[points.length - 1];
  return { points, pct: first > 0 ? Math.round(((last - first) / first) * 100) : null };
}

function whyOf(gap) {
  const raw = String(gap.reason || '').replace(/\s+/g, ' ').trim();
  if (raw) {
    const sentence = raw.match(/^[^.!?]+[.!?]?/)?.[0] || raw;
    return sentence.length > WHY_MAX ? `${sentence.slice(0, WHY_MAX - 1).trimEnd()}…` : sentence;
  }
  if (gap.product_relevance === 'direct') return 'Matches what you sell.';
  if (gap.product_relevance === 'supporting') return 'Supports what you sell.';
  return 'People search this and none of your pages target it.';
}

const stem = (w) => w.toLowerCase().replace(/(ies)$/, 'y').replace(/(es|s)$/, '');
// The industry (who the product is sold to) a keyword is about, matched on its words. Only used for a
// product project, whose capabilities list names the industries it serves.
export function industryOf(topic, industries) {
  const text = ` ${String(topic || '').toLowerCase()} `;
  for (const industry of industries || []) {
    const s = stem(industry);
    if (s.length >= 3 && text.includes(s)) return industry;
  }
  return null;
}

export function buildKeywordsOverview({ metrics = [], gaps = [], capabilities = [], isProduct = false } = {}) {
  const have = buildHaveKeywords(metrics);
  const haveSet = new Set(have.map((h) => h.keyword));
  const industries = isProduct
    ? [...new Set(capabilities.flatMap((c) => (Array.isArray(c.industries) ? c.industries : [])).map((i) => String(i).trim()).filter(Boolean))]
    : [];

  const open = gaps.filter((g) => g.status !== 'rejected'
    && g.coverage_status !== 'covered' && g.coverage_status !== 'duplicate' && !g.existing_page_match
    && !haveSet.has(normalizeKeyword(g.topic)));

  const notYet = open.map((g) => {
    const rec = recommendPlanForGap(g);
    return {
      id: g.id, keyword: g.topic, volume: g.search_volume ?? null,
      potential: estimatePotentialImpressions(g.search_volume),
      trend: trendOf(g), why: whyOf(g),
      plan: g.content_plan || null,
      recommended: { ...rec, intent: g.search_intent || null, relevance: g.product_relevance || null },
      industry: industryOf(g.topic, industries),
      source: g.source || null,
    };
  // Biggest potential first. A keyword the person has decided about keeps its place and shows its choice,
  // instead of jumping to the bottom of the list the moment they click it.
  }).sort((a, b) => (b.potential ?? -1) - (a.potential ?? -1));

  const SHOWN = 6;
  const suggestions = notYet.filter((r) => !r.plan).slice(SHOWN, SHOWN + TOP_N_SUGGESTIONS).map((r) => r.keyword);

  const pages = new Set(metrics.map((m) => m.page));
  return {
    summary: {
      keywords: have.length,
      pages: pages.size,
      impressions: metrics.reduce((n, m) => n + m.impressions, 0),
      top3: have.filter((h) => h.position != null && h.position <= 3).length,
      toGoAfter: notYet.filter((r) => !r.plan).length,
    },
    have, notYet, suggestions, industries,
  };
}

// ───────── pages ─────────

export function normalizePageUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.protocol}//${u.host.toLowerCase()}${path}`;
  } catch { return String(url || '').trim().replace(/\/+$/, '') || '/'; }
}
const pathOf = (url) => { try { return new URL(url).pathname.replace(/\/+$/, '') || '/'; } catch { return String(url || '/'); } };

// Pages that are not meant to earn a search term: legal text, account and checkout screens, feeds and
// archive listings. They are counted as skipped, never listed as "no keywords".
const SKIP_PATH = /(^|\/)(privacy|terms|cookie|cookies|legal|imprint|disclaimer|thank-you|thanks|login|log-in|signin|sign-in|signup|sign-up|register|cart|checkout|account|404|search|tag|tags|category|categories|author|authors|feed|wp-admin|wp-json|cdn-cgi|sitemap|robots)(\/|\.|-|$)/i;
export const isSkippablePage = (url) => SKIP_PATH.test(pathOf(url));

const GENERIC_PATH_WORDS = new Set(['blog', 'www', 'com', 'html', 'htm', 'php', 'index', 'page', 'pages', 'post', 'posts', 'the', 'and', 'for']);
const pathWords = (url) => pathOf(url).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !GENERIC_PATH_WORDS.has(w));

export function buildPagesOverview({ metrics = [], inventory = [], gaps = [], now = new Date() } = {}) {
  const byPage = new Map();
  for (const m of metrics) {
    const key = normalizePageUrl(m.page);
    const row = byPage.get(key) || { page: m.page, path: pathOf(m.page), kws: new Map() };
    const kw = normalizeKeyword(m.query);
    const cur = row.kws.get(kw) || { keyword: kw, impressions: 0, clicks: 0, posWeight: 0 };
    cur.impressions += m.impressions; cur.clicks += m.clicks;
    if (m.avgPosition != null) cur.posWeight += m.avgPosition * m.impressions;
    row.kws.set(kw, cur);
    byPage.set(key, row);
  }
  const pages = [...byPage.values()].map((r) => {
    const keywords = [...r.kws.values()].map((k) => ({
      keyword: k.keyword, impressions: k.impressions, clicks: k.clicks,
      position: k.impressions ? Math.round((k.posWeight / k.impressions) * 10) / 10 : null,
    })).sort((a, b) => b.impressions - a.impressions);
    const ranked = keywords.filter((k) => k.position != null);
    return {
      page: r.page, path: r.path, keywords, n: keywords.length,
      impressions: keywords.reduce((n, k) => n + k.impressions, 0),
      clicks: keywords.reduce((n, k) => n + k.clicks, 0),
      bestPosition: ranked.length ? Math.min(...ranked.map((k) => k.position)) : null,
      topKeyword: keywords[0]?.keyword || null,
    };
  }).sort((a, b) => b.impressions - a.impressions);

  const withKeywords = new Set(byPage.keys());
  const candidates = [];
  let skipped = 0;
  const seen = new Set();
  for (const inv of inventory) {
    const key = normalizePageUrl(inv.page);
    if (withKeywords.has(key) || seen.has(key)) continue;
    seen.add(key);
    if (isSkippablePage(inv.page)) { skipped += 1; continue; }
    candidates.push(inv);
  }

  const usable = gaps.filter((g) => g.status !== 'rejected' && g.coverage_status !== 'covered' && g.coverage_status !== 'duplicate' && !g.existing_page_match);
  const none = candidates.map((inv) => {
    const words = pathWords(inv.page);
    const scored = usable.map((g) => {
      const tw = new Set(String(g.topic || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
      return { topic: g.topic, hits: words.filter((w) => tw.has(w)).length, potential: estimatePotentialImpressions(g.search_volume) ?? 0 };
    }).filter((x) => x.hits >= Math.min(2, words.length) && x.hits > 0).sort((a, b) => (b.hits - a.hits) || (b.potential - a.potential));
    const ageDays = inv.first_seen_at ? (now.getTime() - new Date(inv.first_seen_at).getTime()) / 86_400_000 : null;
    return {
      page: inv.page, path: pathOf(inv.page),
      why: ageDays != null && ageDays < 14 ? 'A new page. Search has not found it yet.' : 'It was not shown in search at all in the last 28 days.',
      suggestions: scored.slice(0, 3).map((x) => x.topic),
    };
  });

  return {
    summary: {
      pagesWithKeywords: pages.length,
      pagesWithNone: none.length + skipped,
      worthFixing: none.length,
      skipped,
      totalPages: pages.length + none.length + skipped,
      impressions: pages.reduce((n, p) => n + p.impressions, 0),
      top3: pages.reduce((n, p) => n + p.keywords.filter((k) => k.position != null && k.position <= 3).length, 0),
    },
    pages, none,
  };
}

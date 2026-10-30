import { CATALOGUE } from './work-catalogue.js';

// Pure helpers behind the standard monthly client progress report (no database
// access, so they are unit-tested anywhere). progress-data.js loads the real rows
// and feeds them through these; anything that cannot be measured comes back null
// and the report says "not measured yet" instead of inventing a figure.

// ---- pure helpers (unit-tested) -------------------------------------------

const MS_DAY = 86400000;
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const monthDay = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
export const longDate = (d) => new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: '2-digit', timeZone: 'UTC' });

// Monday of the week a date falls in, as a UTC date.
function weekStart(d) {
  const t = new Date(`${isoDay(d)}T00:00:00Z`);
  const dow = (t.getUTCDay() + 6) % 7;
  return new Date(t.getTime() - dow * MS_DAY);
}

// Daily gsc rows -> weekly buckets (first and last may be partial weeks, so the
// bars add up exactly to the headline totals).
export function weeklyBuckets(rows) {
  const weeks = new Map();
  for (const r of rows) {
    const key = isoDay(weekStart(r.date));
    const w = weeks.get(key) || { key, impressions: 0, clicks: 0 };
    w.impressions += Number(r.impressions || 0);
    w.clicks += Number(r.clicks || 0);
    weeks.set(key, w);
  }
  return [...weeks.values()].sort((a, b) => a.key.localeCompare(b.key))
    .map((w) => ({ label: monthDay(w.key), impressions: w.impressions, clicks: w.clicks }));
}

// Google results page a ranking position falls on (positions 1-10 = page 1).
export const googlePage = (position) => Math.max(1, Math.ceil(Number(position) / 10));

// Searches that plainly have nothing to do with a normal business: gambling,
// adult, pharma/loan spam, or written in a non-Latin script. Used both to keep
// them out of "searches that match your business" and to size how much of a
// client's Google visibility comes from leftover pages of a previous website.
const UNRELATED_QUERY = /casino|casimpo|gambl|betting|\bbet\b|poker|roulette|slots?\b|lottery|real money|jackpot|viagra|cialis|porn|\bxxx\b|payday loan|crypto|forex/i;
const NON_LATIN = /[^\u0000-ɏ -⁯]/;
export const isUnrelatedQuery = (q) => UNRELATED_QUERY.test(q) || NON_LATIN.test(q);

// Page URLs that are leftovers of a previous site rather than real pages: spam
// topics, .aspx shop-search URLs, and numeric hash parameters (?h=123...).
const UNRELATED_PAGE = /casino|gambl|betting|roulette|craps|free-spins|slots|lottery|\.aspx|[?&]h=\d+/i;
export const isUnrelatedPage = (u) => UNRELATED_PAGE.test(u);

// queryRows: [{ query, impressions, clicks, position }] (position = weighted avg)
export function matchingSearches(queryRows, { max = 5 } = {}) {
  return queryRows
    .filter((r) => r.query && !isUnrelatedQuery(r.query) && Number(r.impressions) > 0)
    .sort((a, b) => Number(b.impressions) - Number(a.impressions))
    .slice(0, max)
    .map((r) => ({ query: r.query, impressions: Number(r.impressions), page: googlePage(r.position) }));
}

// How much of a client's Google visibility comes from a previous website's
// leftovers. Returned only when it is large enough to matter (>= 20% of page
// appearances OR >= 25% of the searches Google reveals), so a clean site never
// shows the box. The figure is an estimate and is worded as "about N in 10".
export function previousSiteShare({ pageRows = [], queryRows = [] }) {
  const pageTotal = pageRows.reduce((a, r) => a + Number(r.impressions || 0), 0);
  const pageBad = pageRows.filter((r) => isUnrelatedPage(r.page)).reduce((a, r) => a + Number(r.impressions || 0), 0);
  const queryTotal = queryRows.reduce((a, r) => a + Number(r.impressions || 0), 0);
  const queryBad = queryRows.filter((r) => isUnrelatedQuery(r.query)).reduce((a, r) => a + Number(r.impressions || 0), 0);
  const pageShare = pageTotal ? pageBad / pageTotal : 0;
  const queryShare = queryTotal ? queryBad / queryTotal : 0;
  if (pageShare < 0.2 && queryShare < 0.25) return null;
  return {
    pagesInTen: pageShare >= 0.2 ? Math.max(1, Math.round(pageShare * 10)) : null,
    unrelatedSearches: queryShare >= 0.25 ? queryBad : null,
    totalSearches: queryShare >= 0.25 ? queryTotal : null,
  };
}

// The seven AI-readiness checks, in everyday names.
export const CHECKS = {
  schema: { name: 'Page labels', sub: 'Hidden labels that say what each page is', draftTypes: ['schema', 'schema-repair'], catalogue: 'schema' },
  llmsReadiness: { name: 'AI guide', sub: 'A guide that tells AI tools about your site', draftTypes: ['llms-txt'], catalogue: 'llms-txt' },
  geoSignals: { name: 'Local details', sub: 'Where you work' },
  faq: { name: 'Questions and answers', sub: 'Answers to common customer questions', draftTypes: ['faq'], catalogue: 'faq' },
  entities: { name: 'Business facts', sub: 'Your name, services and areas, stated clearly' },
  citationReadiness: { name: 'Quotable content', sub: 'Facts AI tools can safely quote' },
  structuredContent: { name: 'Page structure', sub: 'How clearly each page is organised' },
};
const CHECK_ORDER = ['schema', 'llmsReadiness', 'geoSignals', 'faq', 'entities', 'citationReadiness', 'structuredContent'];

// Baseline stores display names; the live ai-visibility run stores keys.
const BASELINE_NAME_TO_KEY = {
  'Schema markup': 'schema', 'Entity markup': 'entities', 'Local/GEO signals': 'geoSignals',
  'AI crawler access (llms.txt)': 'llmsReadiness', 'FAQ coverage': 'faq',
  'Citation readiness': 'citationReadiness', 'Structured content': 'structuredContent',
};

export function checkTag(base, now) {
  if (now < 40) return 'NEEDS MORE WORK';
  return now - base >= 5 ? 'IMPROVED' : 'STEADY';
}

// baselineCategories: [{category,score}] (display names); nowCategories: {key:score}
// doneByType: { 'faq': 3, ... } count of implemented drafts, used ONLY to say
// what we did when real work of that type exists.
export function compareChecks(baselineCategories, nowCategories, doneByType = {}) {
  const baseByKey = {};
  for (const c of baselineCategories || []) {
    const key = BASELINE_NAME_TO_KEY[c.category];
    if (key) baseByKey[key] = Number(c.score);
  }
  const rows = [];
  for (const key of CHECK_ORDER) {
    if (nowCategories?.[key] == null || baseByKey[key] == null) continue;
    const meta = CHECKS[key];
    const base = baseByKey[key]; const now = Number(nowCategories[key]);
    const count = (meta.draftTypes || []).reduce((a, t) => a + (doneByType[t] || 0), 0);
    const did = count && meta.catalogue ? CATALOGUE[meta.catalogue].did(count) : null;
    rows.push({ key, name: meta.name, sub: meta.sub, base, now, tag: checkTag(base, now), did });
  }
  return rows;
}

// ---- the client's own website: listings and business details --------------

export function extractJsonLd(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { out.push(JSON.parse(m[1])); } catch { /* ignore malformed block */ }
  }
  return out;
}

function* walk(node) {
  if (Array.isArray(node)) { for (const n of node) yield* walk(n); return; }
  if (node && typeof node === 'object') { yield node; for (const v of Object.values(node)) yield* walk(v); }
}

export function businessDetails(jsonLd) {
  for (const node of walk(jsonLd)) {
    const types = [].concat(node['@type'] || []);
    if (!types.some((t) => /LocalBusiness|Organization|MovingCompany|Store|ProfessionalService|Service/i.test(t)) || !node.name) continue;
    const a = node.address || {};
    const address = typeof a === 'string' ? a : [a.streetAddress, a.addressLocality, a.postalCode].filter(Boolean).join(', ');
    return { name: node.name, phone: node.telephone || null, address: address || null, sameAs: [].concat(node.sameAs || []) };
  }
  return null;
}

const LISTING_HOSTS = [
  [/share\.google|google\.[a-z.]+\/(maps|search)|g\.page|business\.google/i, 'Google Business Profile', 'Your business panel on Google Search and Maps'],
  [/yell\.com/i, 'Yell', 'UK business directory'],
  [/trustpilot\.com/i, 'Trustpilot', 'Customer reviews'],
  [/brownbook\.net/i, 'Brownbook', 'Online business directory'],
  [/hotfrog\./i, 'Hotfrog', 'Business directory'],
  [/checkatrade\.com/i, 'Checkatrade', 'Trade and services directory'],
  [/facebook\.com/i, 'Facebook', 'Social profile that Google and AI also read'],
  [/linkedin\.com/i, 'LinkedIn', 'Business profile'],
  [/instagram\.com/i, 'Instagram', 'Social profile'],
  [/(twitter|x)\.com/i, 'X', 'Social profile'],
  [/youtube\.com/i, 'YouTube', 'Video channel'],
  [/bing\.com/i, 'Bing Places', 'Bing and Copilot local listing'],
  [/yelp\./i, 'Yelp', 'Customer reviews'],
];

export function describeListing(url) {
  for (const [re, name, kind] of LISTING_HOSTS) if (re.test(url)) return { name, kind, url };
  try { return { name: new URL(url).hostname.replace(/^www\./, ''), kind: 'Online listing', url }; }
  catch { return { name: url, kind: 'Online listing', url }; }
}

// LIVE only when we actually opened the page and it shows the business name.
// Anything else (blocked, error, name not found) is LISTED, never guessed.
export async function checkListing(listing, businessName, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(listing.url, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; ZunkireeReportBot/1.0)' } });
    if (!res.ok) return { ...listing, status: 'listed' };
    const body = await res.text();
    const shows = businessName && body.toLowerCase().includes(String(businessName).toLowerCase().split(/\s+/).slice(0, 2).join(' '));
    return { ...listing, status: shows ? 'live' : 'listed' };
  } catch { return { ...listing, status: 'listed' }; }
}

export async function countSitemapUrls(url, fetchImpl = fetch, depth = 0) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`sitemap ${res.status}`);
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  if (!/<sitemapindex/i.test(xml) || depth > 1) return locs.length;
  let total = 0;
  for (const l of locs) total += await countSitemapUrls(l, fetchImpl, depth + 1);
  return total;
}

// One standard headline for the cover, built from the real numbers.
export function buildHeadline({ ai, pages }) {
  const parts = [];
  if (ai && ai.now > ai.base) parts.push('your website became much easier for AI tools to read');
  else if (ai) parts.push('your website is being measured for AI readiness every month');
  const lead = parts.length ? `<b>${parts[0][0].toUpperCase()}${parts[0].slice(1)}</b>` : '<b>Here is where your website stands</b>';
  const grew = pages && pages.now > pages.base ? ` and has grown to ${pages.now} pages` : '';
  return { lead, grew };
}


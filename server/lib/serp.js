import { dataforseoCall } from '../providers/dataforseo/client.js';
import { readSerpCache, writeSerpCache } from '../store/serp-cache.js';
import { resolveSiteLocations } from '../agents/lib/site-locations.js';

// What Google shows for a keyword: the top-10 organic results, the "People Also Ask" questions, related searches and which result-page
// features appear (featured snippet, map pack, shopping, video). One paid lookup per keyword, through the budgeted DataForSEO client
// (a project's monthly cap is respected and every call is written to the spend ledger), cached for two weeks (migration 265).
//
// Two providers. DataForSEO (above) is tried first when its credentials are set; SerpApi (SERPAPI_KEY, the same account the competitor
// check can use) is the fallback, and the only one used when SERP_PROVIDER=serpapi. A failed DataForSEO call (no credit, an outage) falls
// back; a monthly-budget refusal does NOT, because that is this project's own spending cap and switching provider would walk around it.
// SerpApi has no per-project ledger here: its quota is its own plan's (a free plan is 250 searches a month), and the 14-day cache is what
// keeps that from being spent twice on one keyword.
// Callers: the SERP-overlap check on a keyword plan, the SERP brief for blog outlines, and the search-experience (SXO) check. Never
// throws for an ordinary failure: a keyword that could not be looked up is a result with a reason, because every caller can carry on
// without it (a missing brief is better than a failed draft).

export const SERP_ENDPOINT = '/v3/serp/google/organic/live/advanced';
export const SERP_DEPTH = 10;
export const DEFAULT_MAX_AGE_DAYS = 14;
// A keyword with a search operator is billed five times as much by the provider and is never a real buyer query: refused, not paid for.
const OPERATOR_RE = /\b(site|inurl|intitle|intext|inanchor|filetype|cache|link|related|allintitle|allinurl|allintext):/i;

export const serpKey = (keyword) => String(keyword || '').toLowerCase().replace(/\s+/g, ' ').trim();
export const dataforseoConfigured = (env = process.env) => Boolean(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD);
export const serpApiConfigured = (env = process.env) => Boolean(env.SERPAPI_KEY);
/** True when at least one provider can be used. */
export const serpConfigured = (env = process.env) => dataforseoConfigured(env) || serpApiConfigured(env);
const SERPAPI_ENDPOINT = 'https://serpapi.com/search.json';
// DataForSEO's numeric markets to the country codes SerpApi takes. A market not listed uses SERPAPI_COUNTRY, else "us".
const COUNTRY_BY_LOCATION = { 2840: 'us', 2826: 'gb', 2124: 'ca', 2036: 'au', 2356: 'in', 2524: 'np', 2276: 'de', 2528: 'nl', 2756: 'ch', 2250: 'fr', 2724: 'es', 2380: 'it', 2372: 'ie', 2554: 'nz', 2702: 'sg' };
export const countryFor = (locationCode, env = process.env) => COUNTRY_BY_LOCATION[Number(locationCode)] || String(env.SERPAPI_COUNTRY || 'us').toLowerCase();

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; } };

/** DataForSEO's organic live/advanced response -> the parts this system uses. */
export function parseSerp(body) {
  const items = body?.tasks?.[0]?.result?.[0]?.items || [];
  const results = items
    .filter((i) => i?.type === 'organic' && i.url && i.rank_absolute != null)
    .map((i) => ({ position: i.rank_absolute, url: i.url, domain: String(i.domain || host(i.url)).toLowerCase().replace(/^www\./, ''), title: i.title || '', description: i.description || '' }))
    .sort((a, b) => a.position - b.position)
    .slice(0, SERP_DEPTH);
  const paa = items.filter((i) => i?.type === 'people_also_ask')
    .flatMap((i) => (i.items || []).map((q) => q?.title).filter(Boolean));
  const related = items.filter((i) => i?.type === 'related_searches')
    .flatMap((i) => (Array.isArray(i.items) ? i.items : []).map((q) => (typeof q === 'string' ? q : q?.title)).filter(Boolean));
  const featureTypes = new Set(items.map((i) => i?.type).filter((t) => t && !['organic', 'paid', 'people_also_ask', 'related_searches'].includes(t)));
  return { results, peopleAlsoAsk: [...new Set(paa)], relatedSearches: [...new Set(related)], features: [...featureTypes].sort() };
}

// Google often gives SerpApi only a REDIRECT for an organic result (verified on a live response: 7 of 8 links were google.com/goto?url=...
// with a different token each time, and the page's real address is nowhere in the response). What is reliable is the host, in
// `displayed_link`, and the title. `displayed_link`'s path is a BREADCRUMB of the site's own hierarchy ("uschamber.com > Start >
// Strategy"), not the page's address, and is sometimes cut off with "...".
const REDIRECT = /^https?:\/\/(www\.)?google\.[a-z.]+\/(goto|url)\b/i;
const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
function fromBreadcrumb(displayed) {
  const parts = String(displayed || '').split('›').map((x) => x.trim()).filter(Boolean);
  const m = (parts[0] || '').match(/^https?:\/\/([^\s/]+)/i);
  if (!m) return null;
  const domain = m[1].replace(/^www\./i, '').toLowerCase();
  const segments = parts.slice(1).map((x) => x.replace(/(\.\.\.|…)$/, '').trim()).filter((x) => x && !/^(\.\.\.|…)$/.test(x)).map((x) => x.replace(/\s+/g, '-'));
  return { domain, hint: `https://${domain}${segments.length ? `/${segments.join('/')}` : ''}` };
}

/**
 * SerpApi's google search response -> the same parts parseSerp gives. A result whose link is a Google redirect keeps its real domain,
 * gets `urlApproximate: true`, a `url` rebuilt from the breadcrumb (good for hints such as /blog/ or /services/, NOT an address), and a
 * `matchKey` (domain + title) that is the same for the same page in every search: that, not `url`, is what identifies the page.
 */
export function parseSerpApi(body) {
  const results = (body?.organic_results || [])
    .filter((i) => i?.link && i.position != null)
    .map((i) => {
      const base = { position: i.position, title: i.title || '', description: i.snippet || '' };
      if (!REDIRECT.test(i.link)) return { ...base, url: i.link, domain: host(i.link) };
      const real = fromBreadcrumb(i.displayed_link);
      if (!real) return null; // a redirect with no readable host: the page cannot be identified at all
      return { ...base, url: real.hint, domain: real.domain, urlApproximate: true, matchKey: `https://${real.domain}/${slug(i.title) || 'untitled'}` };
    })
    .filter(Boolean)
    .sort((a, b) => a.position - b.position)
    .slice(0, SERP_DEPTH);
  const features = [
    body?.answer_box && 'featured_snippet', body?.ai_overview && 'ai_overview',
    (body?.shopping_results?.length || body?.inline_shopping_results?.length) && 'shopping',
    (body?.local_results || body?.local_map) && 'local_pack',
    (body?.inline_videos?.length || body?.video_results?.length) && 'video',
    (body?.inline_images?.length || body?.images_results?.length) && 'images',
  ].filter(Boolean).sort();
  return {
    results,
    peopleAlsoAsk: [...new Set((body?.related_questions || []).map((q) => q?.question).filter(Boolean))],
    relatedSearches: [...new Set((body?.related_searches || []).map((q) => q?.query).filter(Boolean))],
    features,
  };
}

/** One SerpApi search. Same outcome shape as fetchSerp's: { ok, ...parts } or { ok: false, reason, detail }. */
async function viaSerpApi(key, market, { fetchImpl, env }) {
  const params = new URLSearchParams({ engine: 'google', q: key, num: String(SERP_DEPTH), api_key: env.SERPAPI_KEY, gl: countryFor(market.locationCode, env), hl: market.languageCode || 'en' });
  let res;
  try { res = await fetchImpl(`${SERPAPI_ENDPOINT}?${params.toString()}`, { signal: AbortSignal.timeout(30000) }); }
  catch (err) { return { ok: false, reason: 'failed', detail: err?.name === 'TimeoutError' ? 'SerpApi did not answer in time' : 'could not reach SerpApi' }; }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) return { ok: false, reason: 'failed', detail: `SerpApi HTTP ${res.status}` };
  if (body.error) {
    // "Google hasn't returned any results for this query." is an empty results page, not a failure of the service.
    if (/hasn't returned any results/i.test(body.error)) return { ok: false, reason: 'no_serp_results' };
    return { ok: false, reason: 'failed', detail: String(body.error).slice(0, 160) };
  }
  const parsed = parseSerpApi(body);
  return parsed.results.length ? { ok: true, ...parsed, costUsd: null } : { ok: false, reason: 'no_serp_results' };
}

/**
 * @returns { ok: true, source: 'cache'|'live', provider?: 'dataforseo'|'serpapi', results, peopleAlsoAsk, relatedSearches, features, costUsd? }
 *        | { ok: false, reason: 'not_configured'|'search_operator_keyword'|'no_keyword'|'budget_refused'|'failed'|'no_serp_results', detail? }
 */
export async function fetchSerp(siteId, keyword, { site, locationCode, languageCode, maxAgeDays = DEFAULT_MAX_AGE_DAYS, job = 'serp-research', deps = {} } = {}) {
  const d = {
    readCache: readSerpCache, writeCache: writeSerpCache, call: dataforseoCall,
    configured: dataforseoConfigured, serpApiConfigured, fetchImpl: globalThis.fetch, env: process.env, ...deps,
  };
  const key = serpKey(keyword);
  if (!key) return { ok: false, reason: 'no_keyword' };
  if (OPERATOR_RE.test(key)) return { ok: false, reason: 'search_operator_keyword' };
  const market = locationCode != null ? { locationCode, languageCode: languageCode || 'en' } : resolveSiteLocations(site)[0];

  // A cached result needs no credentials and costs nothing, so it is checked first.
  try {
    const cached = await d.readCache(key, market.locationCode, market.languageCode, maxAgeDays);
    if (cached?.results?.length) return { ok: true, source: 'cache', ...cached };
  } catch (err) { console.warn('[serp] cache read failed:', err.message); }

  const wanted = String(d.env.SERP_PROVIDER || 'auto').toLowerCase();
  const order = [
    (wanted === 'auto' || wanted === 'dataforseo') && d.configured() && 'dataforseo',
    (wanted === 'auto' || wanted === 'serpapi') && d.serpApiConfigured() && 'serpapi',
  ].filter(Boolean);
  if (!order.length) return { ok: false, reason: 'not_configured' };

  let last = null;
  for (const provider of order) {
    let out;
    if (provider === 'dataforseo') {
      const r = await d.call({
        siteId, job, endpoint: SERP_ENDPOINT, timeoutMs: 30000,
        body: [{ keyword: key, location_code: market.locationCode, language_code: market.languageCode, depth: SERP_DEPTH }],
      });
      if (!r.ok) {
        // The project's own monthly cap is a decision, not a fault: it is respected, never routed around by switching provider.
        if (r.reason === 'budget_refused') return { ok: false, reason: 'budget_refused' };
        last = { ok: false, reason: r.reason, detail: r.error }; continue;
      }
      const parsed = parseSerp(r.body);
      out = parsed.results.length ? { ok: true, ...parsed, costUsd: r.costUsd } : { ok: false, reason: 'no_serp_results' };
    } else {
      out = await viaSerpApi(key, market, { fetchImpl: d.fetchImpl, env: d.env });
    }
    if (!out.ok) { last = out; continue; }
    try { await d.writeCache(key, market.locationCode, market.languageCode, out); } catch (err) { console.warn('[serp] cache write failed:', err.message); }
    return { source: 'live', provider, ...out };
  }
  return last || { ok: false, reason: 'not_configured' };
}

/**
 * Several keywords, a few at a time. Once the project's budget is refused, no more paid lookups are made (cached ones still are).
 * @returns { byKeyword: Map(keyword -> result), liveCalls, stoppedEarly }
 */
export async function fetchSerps(siteId, keywords, { concurrency = 4, ...opts } = {}) {
  const byKeyword = new Map();
  let liveCalls = 0; let stoppedEarly = null;
  const queue = [...new Set(keywords)];
  const worker = async () => {
    while (queue.length) {
      const kw = queue.shift();
      const r = await fetchSerp(siteId, kw, { ...opts, deps: { ...(opts.deps || {}), ...(stoppedEarly ? { call: async () => ({ ok: false, reason: 'budget_refused' }) } : {}) } });
      if (r.ok && r.source === 'live') liveCalls += 1;
      if (!r.ok && r.reason === 'budget_refused') stoppedEarly = 'budget_refused';
      byKeyword.set(kw, r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { byKeyword, liveCalls, stoppedEarly };
}

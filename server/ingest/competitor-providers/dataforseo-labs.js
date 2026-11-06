// DataForSEO Labs "SERP competitors" adapter — market-wide competitor discovery.
//
// Why this exists next to ./dataforseo.js: that adapter answers "who else ranks for the queries this site ALREADY
// ranks for", read from Search Console. It can only ever find rivals inside the site's existing footprint. This one
// asks the opposite question — given the keywords this site's business SHOULD be found for (its own services and
// locations), which domains rank across them — so a rival who beats us on everything we have no presence for at all
// can be found at all. That is the gap the old pipeline could not see.
//
// Every call goes through the budgeted client (server/providers/dataforseo/client.js, migration 231), so it is
// recorded per site_id and refused when the project is over its monthly cap. Nothing here estimates a cost.
//
// Docs: /v3/dataforseo_labs/google/serp_competitors/live
//   Request:  keywords[], location_code, language_code, limit
//   Response: one result row per competing domain, with avg position and how many of the asked keywords it ranks for.

const ENDPOINT = '/v3/dataforseo_labs/google/serp_competitors/live';
const FETCH_TIMEOUT_MS = 30000; // Labs over many keywords is slower than a single SERP fetch
const FOOTPRINT_TIMEOUT_MS = 45000; // a full ranked-keywords page is the heaviest Labs call this file makes
const MAX_KEYWORDS = 200;       // DataForSEO's documented cap for this endpoint
const DEFAULT_LIMIT = 50;       // domains returned; filtering happens in the classifier, not here

export const id = 'dataforseo-labs';

export function configured() {
  return !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
}

/**
 * Domains competing across a set of keywords, strongest presence first.
 *
 * Returns { ok: true, competitors: [...] } or { ok: false, reason } — a budget refusal and a provider failure are both
 * reported, never thrown, because discovery for one site must not abort a whole cron run. `competitors` carries only
 * what the provider actually returned: a field the response omitted is null, never a filled-in guess.
 */
export async function fetchSerpCompetitors(keywords, { locationCode, languageCode, limit = DEFAULT_LIMIT, siteId, deps = {} } = {}) {
  if (!siteId) throw new Error('fetchSerpCompetitors requires a siteId: every paid call belongs to a project.');
  const asked = [...new Set((keywords || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean))].slice(0, MAX_KEYWORDS);
  if (!asked.length) return { ok: false, reason: 'no_keywords', competitors: [] };

  const call = deps.dataforseoCall || (await import('../../providers/dataforseo/client.js')).dataforseoCall;
  const out = await call({
    siteId,
    job: 'competitor-discovery',
    endpoint: ENDPOINT,
    body: [{ keywords: asked, location_code: locationCode, language_code: languageCode, limit }],
    timeoutMs: FETCH_TIMEOUT_MS,
  });

  if (!out.ok) {
    return { ok: false, reason: out.reason, error: out.error, spentUsd: out.spentUsd, budgetUsd: out.budgetUsd, competitors: [] };
  }

  const items = out.body?.tasks?.[0]?.result?.[0]?.items || [];
  const competitors = items
    .map((item) => mapCompetitor(item, asked.length))
    .filter((c) => c.domain)
    .sort((a, b) => b.keywordsRanked - a.keywordsRanked);

  return { ok: true, competitors, keywordsAsked: asked.length, costUsd: out.costUsd };
}

// DataForSEO reports the shape of a competing domain in `metrics.organic` (count/position) alongside `domain`. Field
// names differ slightly between Labs products, so each is read defensively and left null when absent rather than
// defaulted to 0 — a missing metric must stay distinguishable from a measured zero.
function mapCompetitor(item, keywordsAsked) {
  const organic = item?.metrics?.organic || {};
  const count = numberOrNull(organic.count ?? item?.keywords_count ?? item?.intersections);
  return {
    domain: normalizeDomain(item?.domain),
    keywordsRanked: count ?? 0,
    keywordsAsked,
    // Share of the asked keywords this domain ranks for: the presence signal the classifier uses.
    presenceShare: count != null && keywordsAsked > 0 ? Number(Math.min(count / keywordsAsked, 1).toFixed(3)) : null,
    avgPosition: numberOrNull(organic.pos_1 != null ? null : organic.average_position ?? item?.avg_position),
    estimatedTrafficVolume: numberOrNull(organic.etv),
    visibility: numberOrNull(organic.impressions_etv ?? organic.visibility),
  };
}

/**
 * Everything one competitor domain ranks for in one market — the footprint (Phase 3).
 *
 * This is the question our own Search Console can never answer: it shows what WE rank for, so a keyword a rival owns
 * and we have no presence for is invisible to it. `filterTerms` keeps the result inside the client's own market
 * vocabulary, because an unfiltered footprint of a large competitor is mostly noise that would flood the gap queue.
 *
 * Docs: /v3/dataforseo_labs/google/ranked_keywords/live
 */
export async function fetchRankedKeywords(domain, {
  locationCode, languageCode, siteId, limit = 300, minVolume = 10, maxPosition = 30, filterTerms = [], deps = {},
} = {}) {
  if (!siteId) throw new Error('fetchRankedKeywords requires a siteId: every paid call belongs to a project.');
  const target = normalizeDomain(domain);
  if (!target) return { ok: false, reason: 'invalid_domain', keywords: [] };

  const call = deps.dataforseoCall || (await import('../../providers/dataforseo/client.js')).dataforseoCall;
  const out = await call({
    siteId,
    job: 'competitor-footprint',
    endpoint: '/v3/dataforseo_labs/google/ranked_keywords/live',
    body: [{
      target,
      location_code: locationCode,
      language_code: languageCode,
      limit,
      // Ask the provider to do the narrowing it can do, so we pay for fewer useless rows: ranked inside the first
      // three pages, and with real measured demand. The business-relevance filter stays on our side.
      filters: [['ranked_serp_element.serp_item.rank_group', '<=', maxPosition]],
      order_by: ['keyword_data.keyword_info.search_volume,desc'],
    }],
    timeoutMs: FOOTPRINT_TIMEOUT_MS,
  });

  if (!out.ok) {
    return { ok: false, reason: out.reason, error: out.error, spentUsd: out.spentUsd, budgetUsd: out.budgetUsd, keywords: [] };
  }

  const items = out.body?.tasks?.[0]?.result?.[0]?.items || [];
  const terms = normalizeFilterTerms(filterTerms);
  const keywords = items
    .map((item) => mapRankedKeyword(item, locationCode, languageCode))
    .filter((k) => k.keyword)
    .filter((k) => k.searchVolume == null || k.searchVolume >= minVolume)
    .filter((k) => matchesMarketVocabulary(k.keyword, terms))
    .sort((a, b) => (b.searchVolume ?? 0) - (a.searchVolume ?? 0));

  return { ok: true, domain: target, keywords, costUsd: out.costUsd, returned: items.length, kept: keywords.length };
}

/**
 * Which of a competitor's pages carry its organic traffic — where its footprint actually lives, so a recommendation
 * can point at the page type that works rather than a bare keyword.
 *
 * Docs: /v3/dataforseo_labs/google/relevant_pages/live
 */
export async function fetchRelevantPages(domain, { locationCode, languageCode, siteId, limit = 50, deps = {} } = {}) {
  if (!siteId) throw new Error('fetchRelevantPages requires a siteId: every paid call belongs to a project.');
  const target = normalizeDomain(domain);
  if (!target) return { ok: false, reason: 'invalid_domain', pages: [] };

  const call = deps.dataforseoCall || (await import('../../providers/dataforseo/client.js')).dataforseoCall;
  const out = await call({
    siteId,
    job: 'competitor-footprint',
    endpoint: '/v3/dataforseo_labs/google/relevant_pages/live',
    body: [{ target, location_code: locationCode, language_code: languageCode, limit }],
    timeoutMs: FOOTPRINT_TIMEOUT_MS,
  });

  if (!out.ok) return { ok: false, reason: out.reason, error: out.error, pages: [] };

  const items = out.body?.tasks?.[0]?.result?.[0]?.items || [];
  const pages = items
    .map((item) => ({
      url: typeof item?.page_address === 'string' ? item.page_address : null,
      estimatedTraffic: numberOrNull(item?.metrics?.organic?.etv),
      keywordCount: numberOrNull(item?.metrics?.organic?.count),
    }))
    .filter((p) => p.url)
    .sort((a, b) => (b.estimatedTraffic ?? 0) - (a.estimatedTraffic ?? 0));

  return { ok: true, domain: target, pages, costUsd: out.costUsd };
}

// DataForSEO nests a ranked keyword as { keyword_data: {...}, ranked_serp_element: { serp_item: {...} } }. Each field is
// read defensively and left null when absent: a metric the provider did not return must never look like a measurement.
function mapRankedKeyword(item, locationCode, languageCode) {
  const kd = item?.keyword_data || {};
  const info = kd.keyword_info || {};
  const props = kd.keyword_properties || {};
  const serp = item?.ranked_serp_element?.serp_item || {};
  const intent = kd.search_intent_info?.main_intent || null;
  return {
    keyword: typeof kd.keyword === 'string' ? kd.keyword.trim().toLowerCase() : null,
    position: numberOrNull(serp.rank_absolute ?? serp.rank_group),
    rankingUrl: typeof serp.url === 'string' ? serp.url : null,
    searchVolume: numberOrNull(info.search_volume),
    keywordDifficulty: numberOrNull(props.keyword_difficulty),
    cpc: numberOrNull(info.cpc),
    searchIntent: ['informational', 'commercial', 'transactional', 'navigational'].includes(intent) ? intent : null,
    estimatedTraffic: numberOrNull(serp.etv),
    locationCode: locationCode ?? null,
    languageCode: languageCode ?? null,
  };
}

// Business relevance, done deterministically: a competitor keyword is kept only when it shares a real word with
// something this client actually sells. No filter terms means no filtering — the caller then gets the raw footprint
// and is responsible for narrowing it, which is why the collector always passes terms.
function normalizeFilterTerms(filterTerms) {
  const words = new Set();
  for (const term of filterTerms || []) {
    for (const w of String(term).toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length >= 4) words.add(w);
    }
  }
  return words;
}

function matchesMarketVocabulary(keyword, terms) {
  if (!terms.size) return true;
  const words = String(keyword).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((w) => terms.has(w));
}

function numberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function normalizeDomain(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const d = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

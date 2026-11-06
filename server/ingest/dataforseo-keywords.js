// DataForSEO Keyword Data ("Labs") adapter — real search-volume-backed
// keyword ideas from a short list of seed terms describing what a site
// actually offers (see server/agents/lib/keyword-demand.js, the only
// caller). Distinct from ./competitor-providers/dataforseo.js (SERP-organic
// rankings) and ./dataforseo-backlinks.js (backlinks) — this is the first
// code in this codebase to touch DataForSEO Labs' keyword_ideas product.
// Same account, same Basic-Auth pattern as those two — no new credential
// pair needed.
//
// Called once a month per site (see job.js's runKeywordDemandIfDue) — real
// search volume doesn't shift meaningfully week to week, and this is the
// endpoint this app actually pays per-call for.

const ENDPOINT = 'https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live';
const FETCH_TIMEOUT_MS = 20000; // a Labs lookup is slower than a plain SERP fetch, same budget as the backlinks adapter
const MAX_SEED_TERMS = 20; // DataForSEO accepts up to 200; this app only ever sends a handful of extracted offerings

export function configured() {
  return !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
}

function authHeader() {
  const { DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD } = process.env;
  if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) {
    throw new Error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set — keyword demand data cannot be fetched.');
  }
  return 'Basic ' + Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString('base64');
}

// Real related-keyword ideas + monthly search volume for a short list of
// seed terms describing what this site's business actually offers.
// `location_code`/`language_code` are DataForSEO's own market system, same
// convention as the SERP adapter — the caller supplies these rather than
// this adapter guessing a default. Returns keywords with real search
// volume only (a null/zero-volume idea isn't real demand evidence), sorted
// highest-volume first.
export async function fetchKeywordIdeas(seedTerms, { locationCode, languageCode, limit = 100, siteId = null } = {}) {
  const keywords = seedTerms.slice(0, MAX_SEED_TERMS);
  // With a siteId the call goes through the budgeted client, which records what DataForSEO charged
  // (server/providers/dataforseo/client.js, migration 231). Without one, behaviour is exactly as before.
  if (siteId) return ideasFromLedgeredCall(keywords, { locationCode, languageCode, limit, siteId });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        keywords,
        location_code: locationCode,
        language_code: languageCode,
        limit,
        closely_variants: false,
      }]),
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`DataForSEO keyword_ideas request failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  const task = body?.tasks?.[0];
  if (task?.status_code && task.status_code !== 20000) {
    throw new Error(`DataForSEO keyword_ideas task error: ${task.status_message || task.status_code}`);
  }

  return mapIdeaItems(task?.result?.[0]?.items || []);
}

function mapIdeaItems(items) {
  return items
    .filter((item) => item.keyword && item.keyword_info?.search_volume)
    .map((item) => ({
      keyword: item.keyword,
      searchVolume: item.keyword_info.search_volume,
      competition: item.keyword_info.competition_level || null,
      difficulty: item.keyword_properties?.keyword_difficulty ?? null,
    }))
    .sort((a, b) => b.searchVolume - a.searchVolume);
}

// Same request and same mapping as fetchKeywordIdeas, made through the budgeted client. A budget refusal throws like
// any other failure, so the caller's existing per-location fallback and warning path handles it unchanged.
async function ideasFromLedgeredCall(keywords, { locationCode, languageCode, limit, siteId }) {
  const { dataforseoCall } = await import('../providers/dataforseo/client.js');
  const out = await dataforseoCall({
    siteId,
    job: 'keyword-demand',
    endpoint: '/v3/dataforseo_labs/google/keyword_ideas/live',
    body: [{ keywords, location_code: locationCode, language_code: languageCode, limit, closely_variants: false }],
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!out.ok) {
    throw new Error(out.reason === 'budget_refused'
      ? `DataForSEO keyword_ideas skipped: site ${siteId} has used its monthly provider budget (${out.spentUsd?.toFixed(4)} of ${out.budgetUsd} USD).`
      : `DataForSEO keyword_ideas request failed: ${out.error}`);
  }
  return mapIdeaItems(out.body?.tasks?.[0]?.result?.[0]?.items || []);
}

const SEARCH_VOLUME_ENDPOINT = 'https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live';

// Fallback for a location the Labs keyword_ideas product above doesn't
// cover (confirmed live: Nepal returns "Invalid Field: 'location_code'"
// from keyword_ideas specifically) — this is a DIFFERENT DataForSEO
// product (Google Ads' own Search Volume data, not Labs' keyword-expansion
// layer built on top of it), and product coverage differs by location
// between the two, so a location missing from one may still exist in the
// other. Real, but strictly narrower than fetchKeywordIdeas: this only
// returns volume for the EXACT keywords given (the site's own seed terms),
// never expands them into new related suggestions the way keyword_ideas
// does — so a location that falls back to this path yields real but
// thinner keyword coverage than one Labs can serve directly. No
// keyword_difficulty here either (a Labs-only metric); the caller's
// difficultyBucket(null) already handles that honestly as 'medium', never
// a fabricated score.
export async function fetchSearchVolume(seedTerms, { locationCode, languageCode } = {}) {
  const keywords = seedTerms.slice(0, MAX_SEED_TERMS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(SEARCH_VOLUME_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify([{ keywords, location_code: locationCode, language_code: languageCode }]),
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`DataForSEO search_volume request failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  const task = body?.tasks?.[0];
  if (task?.status_code && task.status_code !== 20000) {
    throw new Error(`DataForSEO search_volume task error: ${task.status_message || task.status_code}`);
  }

  const items = task?.result || [];
  return items
    .filter((item) => item.keyword && item.search_volume)
    .map((item) => ({
      keyword: item.keyword,
      searchVolume: item.search_volume,
      competition: item.competition_level || null,
      difficulty: null,
      // Google Ads returns the last 12 months of volume alongside the
      // average. Carried through (newest first) because it is the only real
      // trend evidence in this response — a direction derived from it is
      // measured rather than guessed, which is what lets the search-demand
      // provider report a trend at all instead of always 'stable'. Existing
      // callers ignore the extra field.
      monthlySearches: Array.isArray(item.monthly_searches)
        ? item.monthly_searches
          .filter((m) => m && Number.isFinite(Number(m.search_volume)))
          .map((m) => ({ year: Number(m.year), month: Number(m.month), searchVolume: Number(m.search_volume) }))
          .sort((a, b) => (b.year - a.year) || (b.month - a.month))
        : [],
    }))
    .sort((a, b) => b.searchVolume - a.searchVolume);
}

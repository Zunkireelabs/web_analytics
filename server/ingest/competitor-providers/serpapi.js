// SerpApi adapter (see ./types.js CompetitorProvider) — a real Google SERP
// scraper offered as a sanctioned API (unlike scraping google.com/search
// directly, which violates Google's ToS and gets IP-blocked). Chosen over
// google-cse.js for two reasons: (1) Google Custom Search JSON API requires
// a Google Cloud Billing account linked to the project even to use its free
// tier — SerpApi's free tier needs no card at all; (2) SerpApi returns the
// real Google organic results page (actual ranking positions), where
// google-cse.js's Programmable Search Engine is scoped/configured search,
// not literal SERP data. Free tier: 250 searches/month, no billing — see
// https://serpapi.com/pricing.
//
// Auth: SERPAPI_KEY only — no second ID/CX to provision (unlike google-cse's
// GOOGLE_CSE_CX), since SerpApi queries google.com directly rather than a
// pre-configured Programmable Search Engine.

import { describeHttpFailure, logInternal } from '../../lib/errors.js';

export const id = 'serpapi';

const ENDPOINT = 'https://serpapi.com/search.json';
const RESULTS_PER_QUERY = 10; // one page — keeps quota cost to exactly 1 search/query

export function configured() {
  return !!process.env.SERPAPI_KEY;
}

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

// `opts.locationCode`/`opts.languageCode` are DataForSEO's own numeric/string
// location system (see ingest/competitors.js) — meaningless to this API, so
// this adapter ignores them and uses its own dedicated env vars for
// country/language instead, same convention as google-cse.js.
// Shared low-level request — both fetchRankings (competitor SERP position)
// and searchSources (real citation URLs for expand-content.js's
// external-citations focus, see agents/../generators/expand-content.js) need
// the same raw SerpApi call, just mapped to different shapes.
async function rawSearch(query, num) {
  const { SERPAPI_KEY, SERPAPI_COUNTRY, SERPAPI_LANGUAGE } = process.env;
  if (!SERPAPI_KEY) throw new Error('SERPAPI_KEY is not set.');

  const params = new URLSearchParams({
    engine: 'google', q: query, num: String(num), api_key: SERPAPI_KEY,
    ...(SERPAPI_COUNTRY ? { gl: SERPAPI_COUNTRY } : {}),
    ...(SERPAPI_LANGUAGE ? { hl: SERPAPI_LANGUAGE } : {}),
  });

  const res = await fetch(`${ENDPOINT}?${params.toString()}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    logInternal('serpapi.rawSearch', new Error(`HTTP ${res.status}${body?.error ? ` — ${body.error}` : ''}`));
    throw new Error(`SerpApi is temporarily unavailable (${describeHttpFailure(res.status)}).`);
  }
  const body = await res.json();
  // A non-2xx-but-200 SerpApi error (e.g. bad api_key) reports via
  // body.error rather than an HTTP status — must be checked explicitly or a
  // bad key would silently look like "zero results" instead of failing loud.
  if (body.error) {
    logInternal('serpapi.rawSearch', new Error(body.error));
    throw new Error('SerpApi is temporarily unavailable (request failed).');
  }
  return body.organic_results || [];
}

export async function fetchRankings(query) {
  let items;
  try {
    items = await rawSearch(query, RESULTS_PER_QUERY);
  } catch (e) {
    logInternal('serpapi.fetchRankings', e);
    throw new Error('Competitor intelligence cannot fetch real rankings right now.');
  }
  return items
    .map((item) => ({ domain: hostnameOf(item.link), url: item.link, position: item.position }))
    .filter((r) => r.domain && r.position);
}

// Real, live search results for grounding an LLM's citations in URLs that
// actually exist — title + url only (no ranking/domain shape needed here).
// Callers must treat `configured()` as the gate for whether to call this at
// all; errors here propagate as-is so a caller can fall back gracefully
// rather than surface a raw fetch failure to the end user.
export async function searchSources(query, num = 3) {
  const items = await rawSearch(query, num);
  return items
    .map((item) => ({ title: item.title, url: item.link }))
    .filter((r) => r.title && r.url);
}

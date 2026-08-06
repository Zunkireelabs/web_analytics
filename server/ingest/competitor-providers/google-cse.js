// Google Custom Search JSON API adapter (see ./types.js CompetitorProvider) —
// the free alternative to DataForSEO's paid SERP product. A Programmable
// Search Engine (configured by the account owner to search the entire web,
// not just their own site) queried through Google's own sanctioned API —
// unlike scraping google.com/search directly, which violates Google's ToS
// and gets IP-blocked. Free tier: 100 queries/day, then paid — see
// https://developers.google.com/custom-search/v1/overview.
//
// Auth: GOOGLE_CSE_API_KEY (a Cloud API key with the Custom Search API
// enabled) + GOOGLE_CSE_CX (the Search Engine ID from
// https://programmablesearchengine.google.com/) — both free to create, but
// must be created by the account owner; this file can't provision them.

export const id = 'google-cse';

const ENDPOINT = 'https://www.googleapis.com/customsearch/v1';
const RESULTS_PER_QUERY = 10; // one page — keeps quota cost to exactly 1 request/query

export function configured() {
  return !!(process.env.GOOGLE_CSE_API_KEY && process.env.GOOGLE_CSE_CX);
}

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

// `opts.locationCode`/`opts.languageCode` are DataForSEO's own numeric/string
// location system (see ingest/competitors.js) — meaningless to this API, so
// this adapter ignores them and uses its own dedicated env vars for
// country/language instead.
// Shared low-level request — both fetchRankings (competitor SERP position)
// and searchSources (real citation URLs for expand-content.js's
// external-citations focus, see agents/../generators/expand-content.js) need
// the same raw Google CSE call, just mapped to different shapes.
async function rawSearch(query, num) {
  const { GOOGLE_CSE_API_KEY, GOOGLE_CSE_CX, GOOGLE_CSE_COUNTRY, GOOGLE_CSE_LANGUAGE } = process.env;
  if (!GOOGLE_CSE_API_KEY || !GOOGLE_CSE_CX) {
    throw new Error('GOOGLE_CSE_API_KEY / GOOGLE_CSE_CX are not set.');
  }
  const params = new URLSearchParams({
    key: GOOGLE_CSE_API_KEY, cx: GOOGLE_CSE_CX, q: query, num: String(num),
    ...(GOOGLE_CSE_COUNTRY ? { gl: GOOGLE_CSE_COUNTRY } : {}),
    ...(GOOGLE_CSE_LANGUAGE ? { hl: GOOGLE_CSE_LANGUAGE } : {}),
  });

  const res = await fetch(`${ENDPOINT}?${params.toString()}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Google Custom Search request failed: HTTP ${res.status}${body?.error?.message ? ` — ${body.error.message}` : ''}`);
  }
  const body = await res.json();
  return body.items || [];
}

export async function fetchRankings(query) {
  let items;
  try {
    items = await rawSearch(query, RESULTS_PER_QUERY);
  } catch (e) {
    throw new Error(`${e.message} — competitor intelligence cannot fetch real rankings.`);
  }
  return items
    .map((item, i) => ({ domain: hostnameOf(item.link), url: item.link, position: i + 1 }))
    .filter((r) => r.domain);
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

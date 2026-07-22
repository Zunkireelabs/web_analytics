// DataForSEO SERP API adapter (see ./types.js CompetitorProvider). Uses the
// "live/advanced" Google organic endpoint — synchronous, pay-per-call, the
// right shape for a weekly batch over a site's own ~40-100 tracked queries
// (see ingest/competitors.js) rather than DataForSEO's async task-queue
// endpoints, which are built for much larger batch volumes.
//
// Auth: HTTP Basic, DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD (an account
// login+password pair from the DataForSEO dashboard, not a single API key).

export const id = 'dataforseo';

const ENDPOINT = 'https://api.dataforseo.com/v3/serp/google/organic/live/advanced';

export function configured() {
  return !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
}

function authHeader() {
  const { DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD } = process.env;
  if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) {
    throw new Error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set — competitor intelligence cannot fetch real rankings.');
  }
  return 'Basic ' + Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString('base64');
}

// `location_code`/`language_code` are DataForSEO's own numeric/string
// location system (e.g. 2840 = United States, "en" = English) — the caller
// supplies these per-site rather than this adapter guessing a default,
// since ranking results are meaningfully different per market.
export async function fetchRankings(query, { locationCode, languageCode }) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify([{
      keyword: query,
      location_code: locationCode,
      language_code: languageCode,
      device: 'desktop',
      depth: 20, // top 20 organic results is enough to identify real competitors
    }]),
  });

  if (!res.ok) {
    throw new Error(`DataForSEO request failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  const task = body?.tasks?.[0];
  if (task?.status_code && task.status_code !== 20000) {
    throw new Error(`DataForSEO task error: ${task.status_message || task.status_code}`);
  }

  const items = task?.result?.[0]?.items || [];
  return items
    .filter((item) => item.type === 'organic' && item.domain && item.rank_absolute)
    .map((item) => ({ domain: item.domain, url: item.url, position: item.rank_absolute }));
}

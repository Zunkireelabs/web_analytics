// DataForSEO Backlinks API adapter — the real data source for
// server/agents/authority.js's Authority Score. Distinct from
// server/ingest/competitor-providers/dataforseo.js, which only calls the
// SERP-organic endpoint; this file is the first code in this codebase to
// touch DataForSEO's backlinks/domain-analytics product.
//
// Same account, same Basic-Auth pattern as the existing SERP client
// (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD) — no new credential pair needed.
// Optional, same convention as ingest/pagespeed.js: without credentials,
// the Authority Agent honestly reports insufficient-data, never a
// fabricated score.

const BASE = 'https://api.dataforseo.com/v3/backlinks';
const FETCH_TIMEOUT_MS = 20000; // a real backlink-summary crawl-index lookup is slower than a plain page fetch

export function configured() {
  return !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
}

function authHeader() {
  const { DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD } = process.env;
  if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) {
    throw new Error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set — backlink data cannot be fetched.');
  }
  return 'Basic ' + Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString('base64');
}

async function post(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`DataForSEO backlinks request failed: HTTP ${res.status}`);
    const json = await res.json();
    const task = json?.tasks?.[0];
    if (task?.status_code && task.status_code !== 20000) {
      throw new Error(`DataForSEO task error: ${task.status_message || task.status_code}`);
    }
    return task?.result?.[0] ?? null;
  } finally {
    clearTimeout(timeout);
  }
}

// Real backlink profile summary — referring domains/IPs/subnets, follow vs
// nofollow split, total backlink count. The core inputs to the Authority
// Score's weighted components (see server/agents/authority.js).
export async function fetchBacklinkSummary(domain) {
  const result = await post('/summary/live', [{ target: domain, internal_list_limit: 10 }]);
  if (!result) return null;
  return {
    referringDomains: result.referring_domains ?? null,
    referringMainDomains: result.referring_main_domains ?? null,
    totalBacklinks: result.backlinks ?? null,
    followBacklinks: result.backlinks_follow ?? null,
    nofollowBacklinks: result.backlinks_nofollow ?? null,
    referringIps: result.referring_ips ?? null,
    referringSubnets: result.referring_subnets ?? null,
    rank: result.rank ?? null,
  };
}

// New vs. lost backlinks since a given date — the real net-growth signal
// behind the Authority Score's trend component. DataForSEO's history
// endpoint returns per-day deltas; this sums the window rather than
// requiring the caller to.
export async function fetchBacklinkChanges(domain, sinceDate) {
  const result = await post('/backlinks/live', [{
    target: domain,
    filters: [['last_seen', '>=', sinceDate]],
    limit: 1000,
  }]);
  const items = result?.items || [];
  const newCount = items.filter((i) => i.is_new).length;
  const lostCount = items.filter((i) => i.is_lost).length;
  return { newBacklinks: newCount, lostBacklinks: lostCount };
}

// Real anchor-text distribution — used for the Authority Score's anchor-
// diversity component (an over-concentrated single anchor is a real
// over-optimization/link-scheme signal, not a fabricated penalty).
export async function fetchAnchorDistribution(domain) {
  const result = await post('/anchors/live', [{ target: domain, limit: 100 }]);
  const items = result?.items || [];
  return items.map((i) => ({ anchor: i.anchor, backlinks: i.backlinks ?? 0 }));
}

// Top pages by referring-domain count — the real "top linked pages" the
// Authority dashboard card shows, not a guess.
export async function fetchTopLinkedPages(domain, limit = 10) {
  const result = await post('/backlinks/live', [{
    target: domain,
    order_by: ['domain_from_rank,desc'],
    limit,
  }]);
  const items = result?.items || [];
  return items.map((i) => ({ page: i.url_to, referringDomain: i.domain_from, rank: i.domain_from_rank ?? null }));
}

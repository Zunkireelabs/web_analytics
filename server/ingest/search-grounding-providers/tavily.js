// Tavily Search API adapter (see ./index.js) — the sole search-grounding
// provider for generators/expand-content.js's external-citations focus.
// Deliberately NOT shared with server/ingest/competitor-providers/ (DataForSEO/
// SerpApi/Google CSE): those exist for real Google SERP ranking data —
// see-and-verify SEO/keyword-demand intelligence — while Tavily is a
// search-and-summarize API built for grounding LLM output in real URLs,
// which is exactly this file's one job. The two capabilities are kept on
// separate provider registries on purpose; do not merge them.
//
// Auth: TAVILY_API_KEY from your Tavily dashboard (tavily.com). Docs:
// https://docs.tavily.com/documentation/api-reference/endpoint/search

import { describeHttpFailure, logInternal } from '../../lib/errors.js';

export const id = 'tavily';

const ENDPOINT = 'https://api.tavily.com/search';
const FETCH_TIMEOUT_MS = 15000;

export function configured() {
  return !!process.env.TAVILY_API_KEY;
}

// Strict usage cap, independent of Tavily's own account plan/billing limits
// — a deliberate second ceiling so a bug (e.g. a retry loop, or a page with
// an unexpectedly high citation-focus request rate) can't run up real spend
// unnoticed before anyone sees a Tavily billing alert. In-process, UTC-day
// keyed: this process restarts on every deploy/cron cycle, so it's a
// best-effort brake, not a durable ledger — the honest trade-off for a
// single small env-configured constant instead of a new DB table for a
// feature that only ever asks for 3 results per call in the first place.
const MAX_QUERIES_PER_DAY = Number(process.env.TAVILY_MAX_QUERIES_PER_DAY || 100);

let quotaDay = null;
let quotaCount = 0;

function checkAndConsumeDailyQuota() {
  const today = new Date().toISOString().slice(0, 10);
  if (quotaDay !== today) { quotaDay = today; quotaCount = 0; }
  if (quotaCount >= MAX_QUERIES_PER_DAY) {
    throw new Error(`Tavily daily query cap reached (${MAX_QUERIES_PER_DAY}/day) — refusing further citation search until it resets.`);
  }
  quotaCount += 1;
}

// Real, live search results for grounding an LLM's citations in URLs that
// actually exist — title + url only (no ranking/domain shape needed here).
// Callers must treat `configured()` as the gate for whether to call this at
// all; errors here propagate as-is so a caller can fall back gracefully
// (safeMessage in expand-content.js) rather than surface a raw fetch
// failure to the end user.
export async function searchSources(query, num = 3) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('TAVILY_API_KEY is not set.');

  checkAndConsumeDailyQuota();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: Math.min(Math.max(num, 1), 10), search_depth: 'basic' }),
    });
  } catch (err) {
    logInternal('tavily.searchSources', err);
    throw new Error(err.name === 'AbortError' ? 'Tavily search timed out.' : 'Tavily search is temporarily unavailable (network error).');
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    // 429 (rate limit), 432 (plan limit), 433 (PayGo limit) are Tavily's own
    // account-level quota signals — reported distinctly from a generic
    // failure so a caller/operator can tell "we're out of Tavily budget"
    // apart from "Tavily had an outage", same distinction this repo's other
    // daily-cap machinery (auto-remediation.js's circuit-breaker vs
    // budget-exhausted reasons) already keeps for its own caps.
    const body = await res.json().catch(() => ({}));
    const detail = body?.detail?.error;
    logInternal('tavily.searchSources', new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ''}`));
    if (res.status === 429 || res.status === 432 || res.status === 433) {
      throw new Error('Tavily account quota is exhausted for now.');
    }
    throw new Error(`Tavily search is temporarily unavailable (${describeHttpFailure(res.status)}).`);
  }

  const body = await res.json();
  const results = Array.isArray(body?.results) ? body.results : [];
  // `content` is Tavily's own extracted snippet for the result (not the raw
  // page, not requested via include_raw_content) — kept short and optional
  // so a caller grounding claims in these sources has more than a bare
  // title to work with, without this adapter's shape stopping being a
  // superset of the old {title, url}-only contract google-cse/serpapi used.
  return results
    .map((r) => ({ title: r.title, url: r.url, content: typeof r.content === 'string' ? r.content.slice(0, 500) : undefined }))
    .filter((r) => r.title && r.url)
    .slice(0, num);
}

// Test-only reset so quota state doesn't leak between test files/cases.
export function _resetQuotaForTests() {
  quotaDay = null;
  quotaCount = 0;
}

import { dataforseoCall } from '../../providers/dataforseo/client.js';
import { saveCompetitorRankings } from '../../store/upsert.js';
import { listKeywordsToCheck, markKeywordsChecked } from '../../store/rank-tracking.js';
import { ownDomains } from './site-domain.js';
import { normalizeCompetitorDomain } from './competitor-analysis.js';

// Checks where this site actually ranks for the keywords it deliberately chose to watch, and stores each check as a
// dated snapshot so position history exists at all.
//
// Why this is not the existing weekly competitor check: that one reads the site's own top Search Console queries, so
// it can only see keywords the site ALREADY ranks for. A keyword we are trying to win — the whole point of an
// opportunity — has no Search Console history, so it was invisible. This checks a chosen list instead.
//
// SPENDING IS BOUNDED FIVE WAYS before a single call is made (see migration 237's own note): the per-site opt-in, the
// per-site keyword ceiling, each keyword's active flag, the weekly cadence, and the spend ledger's monthly budget.
// On top of those, one SERP page per keyword is requested (depth 10) — enough to know whether we are on page one and
// who is above us, and the cheapest useful depth.
//
// Snapshots go to `competitor_rankings`, the table that already holds exactly this shape, so position history, the
// competitor-intelligence agent and anything else reading it all see one consistent answer.

const ENDPOINT = '/v3/serp/google/organic/live/advanced';
const FETCH_TIMEOUT_MS = 30000;
const SERP_DEPTH = 10;
// A keyword containing a search operator is billed at five times the normal rate by Google's SERP API. A tracked
// keyword should never be an operator query, so rather than quietly paying 5x this refuses it.
const OPERATOR_RE = /\b(site|inurl|intitle|intext|inanchor|filetype|cache|link|related|allintitle|allinurl|allintext):/i;

/**
 * Run one site's rank check.
 *
 * Returns { ok, checked[], skipped[], costUsd, stoppedEarly } — `stoppedEarly` names why a run ended before the list
 * was finished (today only 'budget_refused'), so a short run is never mistaken for a complete one.
 */
export async function runRankCheck(site, { limit = 25, deps = {} } = {}) {
  const listKeywords = deps.listKeywordsToCheck || listKeywordsToCheck;
  const call = deps.dataforseoCall || dataforseoCall;
  const saveRankings = deps.saveCompetitorRankings || saveCompetitorRankings;
  const markChecked = deps.markKeywordsChecked || markKeywordsChecked;

  const own = new Set(
    [...(ownDomains(site) || []), String(site?.gsc_property || '').replace(/^sc-domain:/, '')]
      .map(normalizeCompetitorDomain).filter(Boolean)
  );

  const keywords = await listKeywords(site.id, { limit });
  if (!keywords.length) {
    return { ok: true, checked: [], skipped: [{ reason: 'no_tracked_keywords' }], costUsd: 0, stoppedEarly: null };
  }

  const date = new Date().toISOString().slice(0, 10);
  const checked = [];
  const skipped = [];
  const checkedIds = [];
  let costUsd = 0;
  let stoppedEarly = null;

  for (const row of keywords) {
    if (stoppedEarly) {
      skipped.push({ keyword: row.keyword, reason: stoppedEarly });
      continue;
    }
    if (OPERATOR_RE.test(row.keyword)) {
      // Billed 5x by the provider and never a real buyer query. Refused rather than paid for.
      skipped.push({ keyword: row.keyword, reason: 'search_operator_keyword' });
      continue;
    }

    const out = await call({
      siteId: site.id,
      job: 'rank-tracking',
      endpoint: ENDPOINT,
      body: [{ keyword: row.keyword, location_code: row.location_code, language_code: row.language_code, depth: SERP_DEPTH }],
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (typeof out.costUsd === 'number') costUsd += out.costUsd;

    if (!out.ok) {
      skipped.push({ keyword: row.keyword, reason: out.reason, detail: out.error });
      if (out.reason === 'budget_refused') stoppedEarly = 'budget_refused';
      continue;
    }

    const results = resultsFrom(out.body);
    if (!results.length) {
      // A SERP with no organic results at all is a provider or market oddity, not a position of zero.
      skipped.push({ keyword: row.keyword, reason: 'no_serp_results' });
      checkedIds.push(row.id); // still checked: do not re-bill it on the next run before the others
      continue;
    }

    const rows = results.map((r) => ({
      date, query: row.keyword, domain: r.domain, url: r.url, position: r.position,
      isOwnDomain: own.has(r.domain) || [...own].some((d) => r.domain.endsWith(`.${d}`)),
    }));
    await saveRankings(site.id, rows);
    checkedIds.push(row.id);

    const mine = rows.find((r) => r.isOwnDomain) || null;
    checked.push({
      keyword: row.keyword,
      // null, not a sentinel: not being in the top 10 is a real, meaningful answer and must stay distinguishable
      // from "we are position 0" or "we did not look".
      position: mine ? mine.position : null,
      url: mine ? mine.url : null,
      topCompetitor: rows.find((r) => !r.isOwnDomain)?.domain || null,
      resultsStored: rows.length,
    });
  }

  if (checkedIds.length) await markChecked(site.id, checkedIds);
  return { ok: true, checked, skipped, costUsd, stoppedEarly };
}

function resultsFrom(body) {
  const items = body?.tasks?.[0]?.result?.[0]?.items || [];
  return items
    .filter((i) => i?.type === 'organic' && i.domain && i.rank_absolute != null)
    .map((i) => ({
      domain: String(i.domain).toLowerCase().replace(/^www\./, ''),
      url: i.url || null,
      position: i.rank_absolute,
    }));
}

/**
 * Keywords worth watching that came from work we actually shipped. Called after an opportunity reaches 'merged', so
 * the thing we tried to win is measured — and only then, because tracking a keyword we never acted on spends money
 * to watch nothing change.
 */
export function keywordsWorthTracking(opportunities) {
  return (opportunities || [])
    .filter((o) => o && o.topic && o.location_code)
    .filter((o) => ['merged', 'deployed', 'verified'].includes(o.lifecycle_state))
    .map((o) => ({ keyword: o.topic, locationCode: o.location_code, languageCode: o.language_code || 'en', gapId: o.id }));
}

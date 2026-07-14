import { getDueVerifications, recordVerificationOutcome } from '../../store/fix-verifications.js';
import { getWatchlistItemById, setWatchlistStatus } from '../../store/watchlist.js';
import { analyzePageUrl, recommendationsFor, TAG_TO_GENERATOR, contentGapsFor, GAP_TYPE_TO_GENERATOR } from './page-content.js';

// Reverse of TAG_TO_GENERATOR / GAP_TYPE_TO_GENERATOR — which real tag(s) a
// given generatorId's draft was meant to resolve, per source agent (the same
// generatorId can mean different things from different agents — e.g. 'faq'
// is produced by both opportunity and content-gap, with different checks).
// Derived, not hand-duplicated, so it can never drift from the real mapping
// each agent sets recommendedAction.generatorId from.
const GENERATOR_TO_TAGS = {};
for (const [tag, generatorId] of Object.entries(TAG_TO_GENERATOR)) {
  if (!generatorId) continue;
  (GENERATOR_TO_TAGS[generatorId] ||= []).push(tag);
}
const GENERATOR_TO_GAP_TYPES = {};
for (const [gapType, generatorId] of Object.entries(GAP_TYPE_TO_GENERATOR)) {
  if (!generatorId) continue;
  (GENERATOR_TO_GAP_TYPES[generatorId] ||= []).push(gapType);
}

const CLOSED_STATUSES = new Set(['completed', 'no_longer_applicable']);

async function reopenIfClosed(siteId, watchlistItemId) {
  const item = await getWatchlistItemById(siteId, watchlistItemId);
  if (!item || !CLOSED_STATUSES.has(item.status)) return;
  await setWatchlistStatus(siteId, watchlistItemId, 'new',
    'Reopened — a fix verification re-checked the live page and found the issue still present.');
}

// Which real deterministic tags are still flagged for this row's exact
// generator, using whichever check function its source agent actually uses
// — opportunity's recommendationsFor (plain tag strings) or content-gap's
// contentGapsFor ({type, detail} objects). Rows with no recorded source
// (created before migration 037) fall back to the original opportunity-only
// behavior.
function currentTagsFor(row, analysis) {
  if (row.source === 'content-gap') {
    return {
      tags: GENERATOR_TO_GAP_TYPES[row.generator_id] || [],
      tagsNow: contentGapsFor(analysis, row.query || '').map((g) => g.type),
    };
  }
  return {
    tags: GENERATOR_TO_TAGS[row.generator_id] || [],
    tagsNow: recommendationsFor(analysis, row.query || ''),
  };
}

async function verifyOne(row) {
  const fetched = await analyzePageUrl(row.page_url);
  if (!fetched.ok) {
    await recordVerificationOutcome(row.id, 'unreachable', { error: fetched.error });
    return { id: row.id, outcome: 'unreachable' };
  }

  const { tags, tagsNow } = currentTagsFor(row, fetched.analysis);
  const stillFlagged = tags.some((t) => tagsNow.includes(t));
  const outcome = stillFlagged ? 'still-present' : 'verified-fixed';
  await recordVerificationOutcome(row.id, outcome, { tagsChecked: tags, tagsNow });

  if (outcome === 'still-present' && row.watchlist_item_id) {
    await reopenIfClosed(row.site_id, row.watchlist_item_id);
  }
  return { id: row.id, outcome };
}

// Re-fetches the EXACT flagged page and re-runs the EXACT deterministic
// check that originally flagged it (recommendationsFor for opportunity,
// contentGapsFor for content-gap — see currentTagsFor) — real evidence, not
// a hope the page resurfaces in some agent's next rotation batch. Runs
// across all sites in one pass; due-ness is per-row (verify_after), so
// there's no per-site "is it due" wrapper here (see server/job.js).
export async function runDueVerifications() {
  const due = await getDueVerifications();
  const results = [];
  for (const row of due) {
    try {
      results.push(await verifyOne(row));
    } catch (err) {
      console.warn(`[fix-verification] row ${row.id} failed:`, err.message);
    }
  }
  return results;
}

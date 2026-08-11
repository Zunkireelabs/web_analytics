import { getDueVerifications, recordVerificationOutcome } from '../../store/fix-verifications.js';
import { getWatchlistItemById, setWatchlistStatus } from '../../store/watchlist.js';
import { analyzePageUrl, recommendationsFor, TAG_TO_GENERATOR, contentGapsFor, GAP_TYPE_TO_GENERATOR } from './page-content.js';
import { recordFixOutcome } from '../../agent-memory.js';
import { topLevelCategoryForGenerator } from '../../generators/lib/pattern-categories.js';

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

// The primary automatic-LEARN trigger for the shared agent_fix_memory loop —
// no PR merge, no human, no Claude Code script required: a real re-fetch of
// the exact flagged page confirming the issue is actually gone (or isn't) is
// the strongest "did this fix really work" signal this app has, so it's what
// writes/updates memory. If this verification was checking the reuse of an
// EXISTING memory (row.memory_ref_id, set at draft-generation time — see
// routes/action-center.js's generateDraft), the outcome updates that
// specific row's reuse_history/confidence/status. Otherwise a
// 'verified-fixed' outcome is a genuinely NEW validated pattern, recorded as
// a fresh candidate memory for the next agent (any generator, any site) to
// find. A 'still-present' outcome with no prior memoryRefId has nothing
// established to downgrade — recordFixOutcome no-ops for that case (see its
// own comment) — there is no reusable "known bad fix" to warn future agents
// away from without a memoryRefId already anchoring one.
async function learnFromOutcome(row, outcome, tags) {
  try {
    if (row.memory_ref_id) {
      await recordFixOutcome({
        memoryRefId: row.memory_ref_id,
        outcome: outcome === 'verified-fixed' ? 'success' : 'failure',
        agentId: 'fix-verification', generatorId: row.generator_id, siteId: row.site_id,
        notes: `fix_verifications row ${row.id}, source=${row.source}`,
      });
      return;
    }
    if (outcome !== 'verified-fixed') return;
    await recordFixOutcome({
      category: topLevelCategoryForGenerator(row.generator_id), scope: 'client', siteId: row.site_id,
      generatorId: row.generator_id, outcome: 'success', sourceType: 'runtime-auto',
      problemSignature: `${row.generator_id}:${(tags || []).join(',') || row.source}`,
      symptoms: `A ${row.generator_id} fix (source: ${row.source}) for tag(s) [${(tags || []).join(', ')}] was confirmed resolved on a real re-check of the live page.`,
      affectedPattern: `${row.generator_id} draft addressing tag(s): ${(tags || []).join(', ')}.`,
      fixStrategy: `See the implemented draft (id ${row.draft_id}) for the fix content that resolved this — re-run the same generator with the same approach for this tag pattern.`,
    });
  } catch (err) {
    console.warn(`[fix-verification] agent_fix_memory write failed for row ${row.id}:`, err.message);
  }
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
  await learnFromOutcome(row, outcome, tags);

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

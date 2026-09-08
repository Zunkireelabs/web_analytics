import { getDueVerifications, recordVerificationOutcome } from '../../store/fix-verifications.js';
import { getWatchlistItemById, setWatchlistStatus } from '../../store/watchlist.js';
import { analyzePageUrl, recommendationsFor, contentGapsFor, fetchHtml } from './page-content.js';
import { recordFixOutcome } from '../../agent-memory.js';
import { topLevelCategoryForGenerator } from '../../generators/lib/pattern-categories.js';
import { getSiteById } from '../../store/read.js';
import { resolveFile } from '../../implementers/lib/url-file-map.js';
import { computeSiteFingerprint } from './site-fingerprint.js';
import { getOrClassifyPageContentType } from './page-content-classifier.js';
import { problemSignatureFor, buildRepairRecipe, tagsForGenerator } from './learned-repair.js';
import { findOpenRecommendation, closeRecommendation } from '../../store/recommendations.js';

// Which real tag(s) a given generatorId's draft was meant to resolve, per
// source agent (the same generatorId can mean different things from different
// agents — e.g. 'faq' is produced by both opportunity and content-gap, with
// different checks). Derived from TAG_TO_GENERATOR/GAP_TYPE_TO_GENERATOR
// rather than hand-duplicated, so it can never drift from the real mapping
// each agent sets recommendedAction.generatorId from.
//
// The derivation moved to learned-repair.js because the cross-client reader
// needs the identical slugs to build the identical problem_signature — see
// tagsForGenerator's own comment. Importing it here rather than keeping a
// second copy is what makes "writer and reader agree" structural.

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
  const tags = tagsForGenerator(row.generator_id, row.source);
  if (row.source === 'content-gap') {
    return { tags, tagsNow: contentGapsFor(analysis, row.query || '').map((g) => g.type) };
  }
  return { tags, tagsNow: recommendationsFor(analysis, row.query || '') };
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

    // A live re-check confirming the issue is genuinely gone is the only
    // signal strong enough to justify letting this repair run on a DIFFERENT
    // client later, so this is the one write path that attaches a fingerprint
    // and a recipe. Both are best-effort: if the site row or its file mapping
    // can't be resolved, the memory is still written — it just stays
    // advisory-only (findPortableRepairs requires both to be non-null), which
    // is exactly today's behavior rather than a regression.
    const { fingerprint, recipe } = await portabilityFor(row).catch(() => ({ fingerprint: null, recipe: null }));

    await recordFixOutcome({
      category: topLevelCategoryForGenerator(row.generator_id), scope: 'client', siteId: row.site_id,
      generatorId: row.generator_id, outcome: 'success', sourceType: 'runtime-auto',
      problemSignature: problemSignatureFor(row.generator_id, tags, row.source),
      symptoms: `A ${row.generator_id} fix (source: ${row.source}) for tag(s) [${(tags || []).join(', ')}] was confirmed resolved on a real re-check of the live page.`,
      affectedPattern: `${row.generator_id} draft addressing tag(s): ${(tags || []).join(', ')}.`,
      fixStrategy: `See the implemented draft (id ${row.draft_id}) for the fix content that resolved this — re-run the same generator with the same approach for this tag pattern.`,
      siteFingerprint: fingerprint,
      repairRecipe: recipe,
    });
  } catch (err) {
    console.warn(`[fix-verification] agent_fix_memory write failed for row ${row.id}:`, err.message);
  }
}

// The technology context this fix was proven in, plus how to re-perform it.
// Returns nulls (not a throw) for a generator that may never run
// cross-client, or a site whose config can't answer the question — the
// resulting memory is then simply advisory, same as every row written today.
async function portabilityFor(row) {
  const recipe = buildRepairRecipe(row.generator_id);
  if (!recipe) return { fingerprint: null, recipe: null };

  const site = await getSiteById(row.site_id);
  if (!site) return { fingerprint: null, recipe: null };

  // Best-effort: getOrClassifyPageContentType never throws (fails open to
  // null internally), but this call site catches too so a classifier bug
  // can never turn a successful fix-verification into a failed one — the
  // worst case is just an unclassified fingerprint, which fingerprintCompatible
  // already refuses on rather than silently trusting.
  const contentType = await getOrClassifyPageContentType(row.site_id, row.page_url).catch(() => null);
  const fingerprint = computeSiteFingerprint(site, {
    targetFilePath: resolveFile(site, row.page_url),
    pageUrl: row.page_url,
    actionType: row.generator_id,
    contentType: contentType?.contentType || null,
  });
  // fingerprintCompatible refuses when a required token is absent, so a
  // fingerprint missing render:/target-ext:/page-adapter: could never match
  // anything anyway. Storing null instead makes that explicit in the data
  // rather than leaving a row that looks portable and silently never is.
  const hasRequired = ['render:', 'target-ext:', 'page-adapter:', 'content-type:'].every((prefix) =>
    fingerprint.some((t) => t.startsWith(prefix))
  );
  return hasRequired ? { fingerprint, recipe } : { fingerprint: null, recipe: null };
}

// analytics-install's own re-check: not a tag re-derivation (recommendation-
// sFor/contentGapsFor have no concept of "GA4/Pixel installed"), but a
// direct, literal check that the EXACT tracking ID this draft shipped —
// stashed in row.query at schedule time (see fix-verifications.js's
// isVerifiableDraft + drafts.js's markDraftImplemented) — now appears in the
// live page's real HTML. Closing the recommendation is gated on this outcome
// alone: a merged PR or an 'implemented' draft says only that the change was
// applied, never that it is actually live and working — this is the "did it
// really work" evidence the user-facing recommendation card is closed on.
async function verifyAnalyticsInstall(row) {
  const trackingId = row.query;
  const fetched = await fetchHtml(row.page_url);
  if (!fetched.ok) {
    await recordVerificationOutcome(row.id, 'unreachable', { error: fetched.error });
    return { id: row.id, outcome: 'unreachable' };
  }

  const installed = !!trackingId && fetched.html.includes(trackingId);
  const outcome = installed ? 'verified-fixed' : 'still-present';
  await recordVerificationOutcome(row.id, outcome, { trackingId, page: row.page_url });
  await learnFromOutcome(row, outcome, []);

  if (outcome === 'verified-fixed') {
    // The recommendation that originated this draft — same (site, page,
    // recommendationType) key trust-compliance.js's own finding uses, so
    // this is closing the actual row a human sees in the Action Center, not
    // a different one. findOpenRecommendation returns null if it was
    // already closed some other way (e.g. the slower closeStaleRecommend-
    // ations sweep beat this to it) — nothing to do in that case.
    const rec = await findOpenRecommendation(row.site_id, row.page_url, row.generator_id);
    if (rec) await closeRecommendation(rec.id);
  } else if (row.watchlist_item_id) {
    await reopenIfClosed(row.site_id, row.watchlist_item_id);
  }
  return { id: row.id, outcome };
}

async function verifyOne(row) {
  if (row.generator_id === 'analytics-install') return verifyAnalyticsInstall(row);

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

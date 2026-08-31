import { findOpenRecommendation, insertRecommendation, mergeIntoRecommendation, refreshRecommendationBlockState, listOpenRecommendations, listOpenBlockedRecommendations, closeStaleRecommendations, markRecommendationsUnfixable, getRecommendationById, closeRecommendation } from '../../store/recommendations.js';
import { getDraftedFindingIds } from '../../store/drafts.js';
import { categoryByAgentId } from './command-center.js';
import { riskTierForGenerator } from './risk-tiers.js';
import { createRecommendationGates } from './recommendation-gates.js';
import { classify } from './recommendation-taxonomy.js';
import { recheckLink } from './technical-seo-analysis.js';
import { getSiteById } from '../../store/read.js';
import { daysAgoInTz } from '../../util/dates.js';
import { runAgent } from '../runner.js';
import { safeMessage } from '../../lib/errors.js';

// The Recommendation Coordinator (Phase 4 M1). This is the ONLY component
// allowed to create or update rows in the `recommendations` table, which is
// in turn the only source the Action Center's recommendation list reads
// from (routes/action-center.js). It does NOT compute findings itself —
// Search Analytics agents keep producing Finding[] exactly as before
// (agents/*.js -> facts.findings), and buildRecommendations() (this same
// directory's recommendations.js) is untouched and keeps grounding those
// findings into generator-ready params for its own existing callers
// (Command Center, Copilot, the daily notification job). The coordinator
// takes THAT already-grounded output as input and is what collapses
// multiple agents' findings about the same page + recommendation_type into
// one persisted row instead of one-per-agent.

// Site-level generators: exactly one real instance exists for the whole
// site, never one per page, unlike meta-title/schema/expand-content/etc.
// trust-compliance.js's cookie/privacy/terms checks in particular give
// their `missing` variant no real page at all (params.page stays null) but
// their `broken` variant a real one (the dead link's own target) — the SAME
// underlying issue naming a different `page` value depending on which
// status this run happened to observe. Left keyed on the real page value,
// that produces two permanently-separate recommendation rows for one
// document (confirmed as a real report: "Draft Terms of Service" and
// "Draft Terms of Service — /terms/" both showing at once) since a status
// flip between two runs never revisits the earlier row. Normalizing the key
// to '' collapses both into one row regardless of which status produced it.
const SITE_LEVEL_GENERATOR_IDS = new Set([
  'cookie-policy', 'privacy-policy', 'terms-of-service',
  'llms-txt', 'security-headers', 'html-lang', 'sitemap', 'robots-fix',
]);

// The real key for a recommendation row — (siteId, page, generatorId) isn't
// always enough on its own: analytics-install's GA4 and Facebook Pixel
// findings share the same generatorId AND the same page (the homepage), so
// without a discriminator here they'd collide into one row and one of the
// two providers would silently disappear from Recommendations forever
// (mergeIntoRecommendation only merges finding_ids in, it never surfaces
// both as separate cards). Encoding `provider` into the key is enough to
// keep them distinct; it's never rendered (getRecommendations doesn't
// return the `page` column to callers), so it's safe to repurpose here.
//
// expand-content has the identical shape: geo-signals.js raises up to 4
// independent findings for the same page (author-byline, freshness-date,
// comparison-content, external-citations — see GEO_SIGNAL_RULES), each with
// its own non-interchangeable `params.focus`. Without a discriminator they
// collided into one row: `issue` froze on whichever focus was inserted
// first, `params` kept getting overwritten by whichever focus synced last
// (mergeIntoRecommendation's `params = COALESCE($5, params)`), so the card
// could show the author-byline label while actually holding
// external-citations params — generating it then ran the wrong focus and
// surfaced a citation-search error under an author-byline heading. Same
// fix as analytics-install: encode the discriminator into the key.
//
// broken-link-fix (also used for the "invalid citation" variant — see
// technical-seo.js) has it too: `params.page` is only the FIRST page a dead
// href happened to be crawled from (c.sourcePages[0]), so two unrelated dead
// links that both first turned up on the same page (e.g. a shared
// footer/nav template, or a repeated citation across many blog posts)
// collided into one row. Confirmed as a real report: a site with 4 distinct
// verified broken links showed only 1 in the Action Center, and its `href`
// kept flipping to whichever finding synced last — the other 3 findings
// were tracked in finding_ids (so they never re-opened) but had no row of
// their own to generate a fix from. `href` is the actual identity of a
// broken-link-fix recommendation, not the page it was first seen on.
// blog-outline has the same shape of bug as the three cases above it: it has
// no `params.page` at all (it drafts net-new content, not tied to an
// existing page — see generators/blog-outline.js), only `params.topic`. Both
// content-gap.js and ai-recommendation.js already raise blog-outline
// findings today, and without a discriminator here every one of them
// collapses to the same page='' key, so a second distinct topic never gets
// its own row — it silently disappears into finding_ids on whichever topic
// synced first. `topic` is the real identity of a blog-outline
// recommendation, the same way `href` is for broken-link-fix.
export function recommendationPageKey(item) {
  if (item.generatorId === 'analytics-install') return `analytics:${item.params?.provider || 'unknown'}`;
  if (item.generatorId === 'expand-content') return `${item.params?.page || ''}::${item.params?.focus || ''}`;
  if (item.generatorId === 'broken-link-fix') return `${item.params?.page || ''}::${item.params?.href || ''}`;
  if (item.generatorId === 'blog-outline') return `topic::${item.params?.topic || ''}`;
  // Same failure mode as blog-outline above: landing-page has no `page`
  // param either (country-intelligence.js calls it with {market}/{city},
  // analyst-seo-mapping.js's keyword-gap routing calls it with {topic}) — a
  // second distinct market/topic would otherwise collapse onto the same
  // page='' key and silently disappear into an unrelated recommendation.
  if (item.generatorId === 'landing-page') {
    return `landing::${item.params?.topic || item.params?.city || item.params?.market || ''}`;
  }
  // Not a real generator — a pseudo type analyst-seo-mapping.js's
  // gapDraftEligibility uses to record a comparison-page opportunity that
  // has no real generator to draft it yet (requiresFutureInfrastructure).
  // Same failure mode as blog-outline/landing-page above if left uncased.
  if (item.generatorId === 'comparison-page') return `comparison::${item.params?.topic || ''}`;
  // Same failure-mode class as the four above: content-integrity-repair
  // takes {page, fixType}, and a page can legitimately have more than one
  // independent defect (visual-quality.js can flag e.g. a malformed-table
  // AND a duplicate-faq on the same page in one run) — without fixType in
  // the key they'd collide onto one recommendation row and one defect would
  // silently disappear into finding_ids. Also fixes a latent version of the
  // same bug for font-consistency.js's font-size-override fixType, which
  // only ever proposed page alone before this.
  if (item.generatorId === 'content-integrity-repair') {
    return `${item.params?.page || ''}::${item.params?.fixType || ''}`;
  }
  if (SITE_LEVEL_GENERATOR_IDS.has(item.generatorId)) return '';
  return item.params?.page || '';
}

// grounded = buildRecommendations()'s { items, lastAnalyzedAt, detectedKeys }
// output. Upserts one recommendations row per (siteId, page, generatorId): a
// new key inserts, an existing open key merges in the new finding/agent.
// Then closes (status = 'superseded') every currently-open row whose key is
// missing from grounded.detectedKeys — the agent that originally flagged it
// re-ran and no longer finds the issue, so it's resolved. detectedKeys is
// built BEFORE buildRecommendations' draftedFindingIds filter specifically
// so a finding with an unshipped draft still counts as "detected" here and
// its recommendation row is never closed out from under a pending draft.
// A blocked recommendation is forced to 'manual' regardless of what
// risk-tiers.js says about its generator.
//
// This used to claim that demoting the tier was *sufficient* to keep blocked
// items out of the unattended chain, so no second filter was needed anywhere.
// That was wrong, and the live table proved it: site 1 accumulated 45 rows
// that were risk_tier='safe' AND blocked. Demotion is only sufficient if this
// function is the last word on risk_tier, and it was not — migration 078's
// re-running backfill overwrote the tier behind it (now guarded, and forbidden
// outright by migration 108's CHECK constraint).
//
// So the invariant is now asserted in four places on purpose, and each one
// should stay: here (the writer), migration 108 (the database), and both
// unattended selectors — auto-remediation.js's eligibility filter and
// listOpenSafeRecommendations. A safety property that only one layer enforces
// is a safety property one bug away from being gone.
//
// Blocker-agnostic on purpose. It started as design-verification only, and now
// also carries "no url_file_map entry for this page" (see
// buildRecommendations). Any future blocker gets the same treatment for free by
// setting item.blockedReason, rather than each one inventing its own way to
// stay out of the autonomous path — which is exactly how one of them would
// eventually forget to.
function blockedRiskTier(item) {
  return item.blockedReason ? 'manual' : riskTierForGenerator(item.generatorId);
}

export async function syncFromGrounded(siteId, grounded) {
  for (const item of grounded.items) {
    if (!item.generatorId) continue; // buildRecommendations already filters these, but stay defensive
    const page = recommendationPageKey(item);
    const existing = await findOpenRecommendation(siteId, page, item.generatorId);
    if (existing) {
      if (existing.finding_ids.includes(item.id)) {
        // Nothing new about the *finding* — finding ids are deterministic
        // (e.g. `geo-signals:${page}:${label}`), so re-detecting the same
        // issue yields the same id every run and re-merging it is churn.
        //
        // Block state is a different thing entirely: it is recomputed from
        // live site and repo state on every sync, not carried by the finding.
        // Returning early here meant that for any recommendation the agents
        // keep re-detecting — which is most of them — the block never
        // refreshed in either direction. A template that got verified stayed
        // blocked; a row corrupted to 'safe' by migration 078 stayed
        // corrupted. Refresh just that, then skip the merge as before.
        await refreshRecommendationBlockState(existing.id, {
          blockedReason: item.blockedReason ?? null,
          riskTier: blockedRiskTier(item),
        });
        continue;
      }
      await mergeIntoRecommendation(existing.id, {
        findingId: item.id, agentId: item.source, reason: item.reason,
        params: item.params, priority: item.priority, expectedImpact: item.expectedImpact,
        // Refreshed on every sync, both directions: a template that has since
        // been verified clears the block automatically (back to its real risk
        // tier), and one that regresses re-blocks — no manual unblock step,
        // and no stale "blocked" banner outliving the thing that caused it.
        blockedReason: item.blockedReason ?? null,
        riskTier: blockedRiskTier(item),
      });
    } else {
      await insertRecommendation(siteId, {
        page, recommendationType: item.generatorId, issue: item.tag, reason: item.reason,
        params: item.params, findingId: item.id, detectingAgent: item.source,
        priority: item.priority, expectedImpact: item.expectedImpact, riskTier: blockedRiskTier(item),
        blockedReason: item.blockedReason ?? null,
      });
    }
  }
  if (grounded.detectedKeys) {
    await closeStaleRecommendations(siteId, grounded.detectedKeys, {
      agentCheckedKeys: grounded.agentCheckedKeys,
      linkCrawlCheckedKeys: grounded.linkCrawlCheckedKeys,
      batchRotatedAgentIds: grounded.batchRotatedAgentIds,
    });
  }
  // Direct evidence, not absence-of-evidence: unlike closeStaleRecommendations
  // above (which infers "fixed" from a page's continued silence, gated on
  // rotation batching so silence isn't mistaken for resolution),
  // droppedRecommendations are pages buildRecommendations actually looked at
  // THIS run and proved unfixable. Marked immediately rather than left to a
  // rotation sweep that would never re-select a page that no longer exists.
  if (grounded.droppedRecommendations?.length) {
    await markRecommendationsUnfixable(siteId, grounded.droppedRecommendations);
  }
}

// Re-validates every open, currently-BLOCKED recommendation against live
// gate state — the same checks recommendation-gates.js runs when a finding
// is first detected — and writes back whatever changed. This is the periodic
// counterpart to syncFromGrounded's own inline refresh (lines above): that
// one only re-syncs a row's block state when its detecting agent re-emits
// the same finding on today's run, which most recommendation types do every
// day but content-gap-derived ones (blog-outline, landing-page,
// comparison-page, gap-based faq — anything created by
// createActionCenterRecommendationForGap in analyst-seo-mapping.js) never
// do: that agent isn't part of the daily grounded detection pass at all, so
// nothing ever revisited their block state after creation, even after the
// underlying config (a url_file_map entry, a verified template) got fixed.
//
// Read-modify-write on rows that already exist — never inserts, never closes,
// never touches anything with status != 'open' (excluded by
// listOpenBlockedRecommendations at the query level). A row this pass
// couldn't verify this run (a transient API error — gates.evaluate throws,
// caught below) is left exactly as it was rather than guessed at; it gets
// another chance on the next run.
//
// `onlyDetectingAgent`/`excludeDetectingAgent` split this into the two
// callers job.js wires up: the daily pass excludes 'analyst-keyword-gaps'
// rows (content gaps get their own slower weekly cadence — see
// refreshContentGapRecommendationsForAllSites), the weekly pass includes only
// them.
export async function refreshBlockedRecommendations(siteId, { onlyDetectingAgent, excludeDetectingAgent } = {}) {
  const site = await getSiteById(siteId);
  if (!site?.repo_owner || !site?.repo_name) return { checked: 0, updated: 0 };

  const rows = await listOpenBlockedRecommendations(siteId, { onlyDetectingAgent, excludeDetectingAgent });
  if (!rows.length) return { checked: 0, updated: 0 };

  // One gates instance for the whole pass — same reasoning as
  // syncAnalystInsightsToActionCenter's own comment: one repo-tree read and
  // one soft-404 fingerprint for every row checked, not one per row.
  const gates = createRecommendationGates(siteId, site);
  let updated = 0;
  for (const rec of rows) {
    const gate = await gates.evaluate(rec.recommendation_type, rec.params || {}).catch(() => null);
    if (!gate) continue; // could not verify this run — leave the row untouched
    // gate.drop (page proven gone) is deliberately not acted on here: closing
    // a recommendation is a lifecycle decision this refresh isn't scoped to
    // make — markRecommendationsUnfixable/closeStaleRecommendations already
    // own that for the recommendation types capable of producing a drop.
    const result = await refreshRecommendationBlockState(rec.id, {
      blockedReason: gate.blockedReason,
      riskTier: gate.blockedReason ? 'manual' : riskTierForGenerator(rec.recommendation_type),
    });
    if (result) updated++;
  }
  return { checked: rows.length, updated };
}

// Manual "re-check now" action on a single open recommendation — the
// instant counterpart to closeStaleRecommendations' bulk, rotation-gated
// sweep above. A user who just fixed something on their site shouldn't have
// to wait for that page's turn in a batch-rotated agent's rotation; this
// re-examines exactly the one page/link right away and closes the
// recommendation immediately if it's genuinely clean now.
//
// broken-link-fix gets its own path (recheckLink checks one href directly,
// cheaper and more precise than re-running the whole page's link crawl).
// Every other page-scoped recommendation type re-runs its detecting agent
// via the same params.pages single-page bypass selectCandidatePages-based
// agents already support for exactly this purpose (see e.g. ai-visibility.js
// facts.checkedPages) — persist:false so this on-demand check never
// overwrites the agent's real latest scheduled run. Site-level
// recommendations (page === '') aren't re-checked here — they cover many
// pages worth of evidence collapsed into one row, so they close naturally on
// the next full sync instead.
export async function recheckRecommendation(siteId, recommendationId) {
  const rec = await getRecommendationById(siteId, recommendationId);
  if (!rec) { const err = new Error('Recommendation not found'); err.status = 404; throw err; }
  if (rec.status !== 'open') return { status: rec.status, changed: false };

  if (rec.recommendation_type === 'broken-link-fix') {
    const href = rec.params?.href;
    if (!href) return { status: 'open', changed: false, reason: 'no link on record to re-check' };
    const result = await recheckLink(href);
    if (!result.broken) {
      await closeRecommendation(rec.id);
      return { status: 'superseded', changed: true, detail: result };
    }
    return { status: 'open', changed: false, detail: result };
  }

  if (!rec.page) return { status: 'open', changed: false, reason: 'site-level recommendation — re-checked automatically on the next full sync' };

  const agentId = rec.detecting_agents?.[0];
  if (!agentId) return { status: 'open', changed: false, reason: 'no detecting agent on record' };

  const site = await getSiteById(siteId);
  const end = daysAgoInTz(site?.timezone || 'UTC', 0);
  const start = daysAgoInTz(site?.timezone || 'UTC', 28);

  let output;
  try {
    output = await runAgent(agentId, { siteId, start, end, params: { pages: [rec.page] } }, { persist: false });
  } catch (err) {
    const { message } = safeMessage('recommendation-coordinator.recheckRecommendation', err, 'This recommendation could not be re-checked right now — it stays open until the next run.');
    return { status: 'open', changed: false, reason: message };
  }
  const stillDetected = (output.facts?.findings || []).some((f) => (
    f.recommendedAction?.generatorId === rec.recommendation_type
    && recommendationPageKey({ generatorId: f.recommendedAction.generatorId, params: f.recommendedAction.params }) === rec.page
  ));
  if (stillDetected) return { status: 'open', changed: false };
  await closeRecommendation(rec.id);
  return { status: 'superseded', changed: true };
}

// Drop-in replacement for buildRecommendations() at the two call sites that
// render the Action Center's actual recommendation list (see
// routes/action-center.js) — same { items, lastAnalyzedAt } shape, sourced
// from the persisted, deduplicated table instead of a live recompute.
export async function getRecommendations(siteId) {
  const [rows, draftedFindingIds, catByAgent] = await Promise.all([
    listOpenRecommendations(siteId),
    getDraftedFindingIds(siteId),
    categoryByAgentId(),
  ]);
  // A single draft's generator params already cover the whole merged
  // recommendation (mergeIntoRecommendation refreshes `params` to the
  // latest evidence across all finding_ids), so shipping it resolves the
  // recommendation entirely — hide as soon as ANY finding_id is drafted,
  // not only once every one of them individually has a draft row. Without
  // this, shipRecommendation only ever drafts finding_ids[0]
  // (routes/action-center.js), so a recommendation merged from multiple
  // findings would never disappear from Recs after being shipped.
  const items = rows
    .filter((r) => r.finding_ids.every((fid) => !draftedFindingIds.has(fid)))
    .map((r) => {
      const { bucket, category } = classify({ source: r.detecting_agents[0], generatorId: r.recommendation_type });
      return {
        id: String(r.id), findingIds: r.finding_ids,
        source: r.detecting_agents[0], agentName: catByAgent.get(r.detecting_agents[0])?.name || r.detecting_agents[0],
        detectingAgents: r.detecting_agents, supportingAgents: r.supporting_agents,
        tag: r.issue, generatorId: r.recommendation_type, bucket, category,
        reason: r.reason, params: r.params, priority: r.priority, expectedImpact: r.expected_impact,
        riskTier: r.risk_tier,
        // Only forecast_risk-driven recommendations carry a real value here
        // (see analyst-seo-mapping.js's seoDraftEligibility) — everything
        // else is null, not a fabricated number.
        confidence: r.confidence != null ? Number(r.confidence) : null,
        // Non-null means Action Center should show this as "blocked pending
        // design verification" with this exact reason, and must not offer a
        // Generate Draft affordance — generateDraft would 422 anyway (that's
        // the real gate), but a button that always fails is worse than no
        // button. See engineering lesson button-state-visibility: state the
        // reason inline rather than only on hover.
        blockedReason: r.blocked_reason || null,
        // WHY it's blocked, for the UI to pick different copy/tone by —
        // 'our-config' (actionable: give the exact command), 'awaiting-
        // derivation' (nothing to do, will clear on its own), 'site-fact' (a
        // real architectural constraint, e.g. a shared programmatic
        // template). See store/recommendations.js's classifyBlockedKind.
        blockedKind: r.blocked_kind || null,
      };
    });
  const lastAnalyzedAt = {};
  for (const r of rows) lastAnalyzedAt[r.detecting_agents[0]] = r.last_seen_at;
  return { items, lastAnalyzedAt };
}

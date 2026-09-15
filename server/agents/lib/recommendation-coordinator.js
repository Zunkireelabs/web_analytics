import { findOpenRecommendation, insertRecommendation, mergeIntoRecommendation, refreshRecommendationBlockState, listOpenRecommendations, listOpenBlockedRecommendations, closeStaleRecommendations, markRecommendationsUnfixable, getRecommendationById, closeRecommendation } from '../../store/recommendations.js';
import { getLiveDraftsByFindingId } from '../../store/drafts.js';
import { attemptSummaryByFinding } from '../../store/recommendation-attempts.js';
import { categoryByAgentId } from './command-center.js';
import { riskTierForGenerator } from './risk-tiers.js';
import { createRecommendationGates } from './recommendation-gates.js';
import { classify } from './recommendation-taxonomy.js';
import { recheckLink } from './technical-seo-analysis.js';
import { getSiteById } from '../../store/read.js';
import { daysAgoInTz } from '../../util/dates.js';
import { runAgent } from '../runner.js';
import { safeMessage } from '../../lib/errors.js';
import { RECOMMENDATION_AGENT_IDS } from './insights.js';

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
  // Exactly one real nginx config per site, same as security-headers above.
  'soft-404-nginx',
]);

// Every `reportOnly.kind` any agent raises (agents/types.js's ReportOnly) —
// a confirmed, real defect with no safe automatic fix, by the detecting
// agent's own deliberate choice not to set recommendedAction. None of these
// has (or should ever get) a matching file under generators/, so a row of
// this type can never be drafted; its blocked_reason is not a gate verdict,
// it's the whole reason the row exists. refreshBlockedRecommendations below
// is the one place that distinction wasn't honored — see its comment.
// Kept as a static list rather than checking generators/registry.js's
// getGenerator() (which would return the correct null just as well): that
// function `import()`s every file under generators/ on first call, several
// of which transitively pull in the OpenAI SDK, and refreshBlockedRecommendations
// runs inside a request/cron path this file's own tests deliberately keep
// free of that chain.
const REPORT_ONLY_KINDS = new Set([
  'query-cannibalization', 'authority-backlinks-lost', 'duplicate-content',
  'device-ctr-deficit', 'competitor-outranking', 'competitor-backlink-gap',
  'font-size-inconsistency', 'keyword-cluster-gap', 'templated-duplicate-family',
  'url-variant-duplicate', 'sitemap-index-conflict', 'redirect-chain', 'query-param-duplicate',
  'soft-404',
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
// A page reachable at both its `www.` and bare-domain variant (or with vs.
// without a trailing slash) is the same resource, but the crawler's `page`
// param is whichever exact URL variant that particular crawl happened to
// request — so two crawls of the identical page can otherwise mint two
// different dedup keys and split into two Action Center cards for the same
// underlying issue. Confirmed as a real report: the same crm.zunkiree.com
// dead link showed as one recommendation keyed to
// https://www.zunkireelabs.com/products/ai-crm/ and a second keyed to
// https://zunkireelabs.com/products/ai-crm/ (no `www.`).
//
// Deliberately scoped to ONLY broken-link-fix/missing-page-create, not
// applied generally (e.g. to the plain `return item.params?.page || ''`
// fallback below, or expand-content/content-integrity-repair's page
// component). Those other keys are compared verbatim against the ALREADY
// STORED `rec.page` column inside recheckRecommendation's generic re-detect
// match (`recommendationPageKey(...) === rec.page`, below) — normalizing
// their formula would silently stop matching every existing row whose
// stored `page` isn't already in the new normalized form (any trailing
// slash, any `www.`), misreading "still detected" as "resolved" and closing
// it. broken-link-fix/missing-page-create never reach that comparison (this
// function returns earlier, via recheckLink against `params.href` alone),
// so they're the only two safe to normalize without a backfill.
function normalizePageForKey(page) {
  if (!page) return page;
  try {
    const u = new URL(page);
    u.hostname = u.hostname.replace(/^www\./i, '');
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return page;
  }
}

export function recommendationPageKey(item) {
  if (item.generatorId === 'analytics-install') return `analytics:${item.params?.provider || 'unknown'}`;
  if (item.generatorId === 'expand-content') return `${item.params?.page || ''}::${item.params?.focus || ''}`;
  if (item.generatorId === 'broken-link-fix' || item.generatorId === 'missing-page-create') return `${normalizePageForKey(item.params?.page) || ''}::${item.params?.href || ''}`;
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
  //
  // 'table-style-drift'/'typography-drift' (routed from
  // agents/lib/design-consistency.js) sharpen this further: a single page
  // can have SEVERAL independently-drifted sections of the identical
  // fixType — e.g. two different tables, or a heading AND a body both
  // failing typography-drift in different sections — which page::fixType
  // alone would still collapse onto one row. sectionOrder+textRole (present
  // only on these two fixTypes' params; undefined for the other five, so
  // their key is unchanged) is the same per-section discriminator
  // consistency-check.js's own Finding shape already carries.
  if (item.generatorId === 'content-integrity-repair') {
    const { page, fixType, sectionOrder, textRole } = item.params || {};
    return `${page || ''}::${fixType || ''}::${sectionOrder ?? ''}::${textRole ?? ''}`;
  }
  // blog-image (agents/blog-image.js) has no live URL to key on — the
  // detector found this post by its real repo path, which is already
  // unambiguous ground truth, so keying on it directly avoids re-deriving a
  // URL from a title/slug guess that could drift from the real one.
  if (item.generatorId === 'blog-image') return `blog-image::${item.params?.filePath || ''}`;
  if (SITE_LEVEL_GENERATOR_IDS.has(item.generatorId)) return '';
  return item.params?.page || '';
}

// Every generator whose recommendation identity is something OTHER than the
// page alone, and the param that carries that identity.
//
// This is a coverage ledger, not a second implementation — recommendationPageKey
// above remains the one that computes the key. What this adds is the thing
// that function structurally cannot have: a list of which generators have
// been THOUGHT ABOUT. Every entry above was added reactively, after a real
// duplicate-card incident (GA4 colliding with Facebook Pixel on the homepage;
// four distinct broken links showing as one card; a second blog topic
// vanishing into the first one's finding_ids). The pattern in all of them is
// identical: a generator whose params carry more identity than `page` does,
// discovered only once a user reported seeing one card where there were
// several.
//
// The accompanying test asserts every registered generator appears here, so
// adding a generator forces the question "is `page` really this thing's
// identity?" at the time it is written, rather than after someone notices
// cards going missing. A generator whose identity genuinely IS its page (or
// which is site-wide) says so explicitly by being listed as such.
export const DEDUP_IDENTITY = {
  // Keyed on a discriminating param — page alone would collide.
  'analytics-install': 'provider',
  'expand-content': 'focus',
  'broken-link-fix': 'href',
  // Same identity as broken-link-fix — both are "this one dead href", and a
  // link can flip between the two resolutions as the section around it gains
  // or loses sibling pages, so they must key identically.
  'missing-page-create': 'href',
  'blog-outline': 'topic',
  'landing-page': 'topic|city|market',
  'comparison-page': 'topic',
  'content-integrity-repair': 'fixType|sectionOrder|textRole',
  'blog-image': 'filePath',
};

// Generators with no page dimension at all — one row per site, whatever the
// detector's `page` param happened to say this run (see the comment on
// SITE_LEVEL_GENERATOR_IDS).
export const SITE_LEVEL_IDENTITY = SITE_LEVEL_GENERATOR_IDS;

// True when this generator has an explicit, considered dedup identity. The
// test below is the only caller; it exists so the assertion reads as one
// question rather than three set lookups.
export function hasDeclaredDedupIdentity(generatorId, pageKeyedIds) {
  return Object.hasOwn(DEDUP_IDENTITY, generatorId)
    || SITE_LEVEL_IDENTITY.has(generatorId)
    || pageKeyedIds.has(generatorId);
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
      // ALWAYS merge, even when the *finding* itself is unchanged (same
      // deterministic id as yesterday). This used to early-return here on
      // the reasoning that a re-detected finding has nothing new to say —
      // true of the finding, false of its PARAMS. A detecting agent
      // recomputes params fresh every run from live/current state (e.g.
      // trust-compliance.js reads sites.ga4_measurement_id fresh each sync),
      // but analytics-install's finding id
      // (`trust-compliance:${provider}:missing`) never changes while the
      // tracker stays uninstalled — so under the old early return, a
      // recommendation created before an ID was configured in the database
      // NEVER picked up that ID through normal daily sync, only through the
      // failure-triggered recovery cycle in action-center-reconciler.js
      // (bounded, only reached after MAX_FAILED_ATTEMPTS worth of real
      // failures). Confirmed live: recommendation #47/#48 on site 1 carried
      // no trackingId from 2026-08-21 through 15 failed drafts, and only
      // gained one on 2026-09-07 when the recovery path finally forced a
      // refresh — 17 days and 15 wasted attempts a plain sync should have
      // avoided. mergeIntoRecommendation's `params = COALESCE($5, params)`
      // already replaces params wholesale with the fresh value (same
      // semantics expected_impact/confidence use), so calling it
      // unconditionally is exactly "recompute this recommendation's facts
      // from what was just re-detected" — never a data loss, since a
      // detecting agent that found nothing new about params still passes its
      // current, correct params, not a blank.
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
      // This pass only ever re-detects findings from Node's own grounded
      // agent roster — a row sourced entirely from analyst-insights,
      // analyst-keyword-gaps, or growth-opportunities (none of which run as
      // part of buildRecommendations) must never be closed here on the
      // strength of THIS roster's silence about it. See closeStaleRecommendations'
      // own comment for the incident this fixed.
      authoritativeAgentIds: new Set(RECOMMENDATION_AGENT_IDS),
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
    // A reportOnly-kind row (REPORT_ONLY_KINDS above) has no real generator
    // behind it — recommendations.js deliberately skips gates.evaluate for
    // these at detection time, with the exact same reasoning: "every gate
    // answers 'can we safely DRAFT this?', and the row exists precisely
    // because nothing will be drafted. Running them would mean asking a
    // url_file_map/design question about a fix that does not exist." This
    // refresh pass was the one place that reasoning wasn't applied — it
    // re-evaluates every open BLOCKED row through the generic gates
    // regardless of type, and for an unregistered generatorId every gate
    // case falls through to "not blocked", silently wiping the deliberate,
    // permanent blocked_reason back to null on the very next daily pass
    // (confirmed live: a query-cannibalization row's blocked_reason went
    // from its real text to null within the same run that inserted it,
    // exposing a dead "Generate Solution Draft" button that 404s with
    // `Unknown generator "query-cannibalization"` on click). Skipping here,
    // before gates ever sees it, is the fix — leaving the row exactly as
    // syncFromGrounded's own inline refresh already set it.
    if (REPORT_ONLY_KINDS.has(rec.recommendation_type)) continue;
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
//
// `refreshEvidence` (default false, preserving the manual "Re-check now"
// button's exact original behavior for every existing caller): when true and
// the finding is STILL detected — not resolved, so there's a real fix left to
// generate — this also merges the fresh finding's params onto the
// recommendation via mergeIntoRecommendation, the same store function
// syncFromGrounded uses, so this stays the coordinator's own write path
// rather than a second one. This is what lib/action-center-reconciler.js's
// autonomous-recovery pass (2026-09-06) uses: an ITEM_DEFECT failure (a
// stale anchor, a moved target) means the draft that failed was built from
// PARAMS captured at original detection time — shipRecommendation always
// calls generateDraft with `params: rec.params` (routes/action-center.js) —
// and those never update on their own between here and there. Re-detecting
// and refreshing them is what makes the NEXT generated draft target reality
// instead of reproducing the identical stale anchor forever.
export async function recheckRecommendation(siteId, recommendationId, { refreshEvidence = false } = {}) {
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
    // broken-link-fix has no separate "fresh params" to pull beyond the href
    // itself, which recheckLink just confirmed is still broken — nothing to
    // refresh, the existing params are already accurate. `recheckedLive: true`
    // still records that a genuine live re-check happened (as opposed to a
    // no-op) — driveAutonomousRecovery (action-center-reconciler.js) needs
    // that signal to ever count a recovery cycle for this recommendation
    // type. Without it, a permanently-dead external citation/link (DNS
    // failure, expired cert) can never accumulate the recovery cycles that
    // lead to blockRecommendation, and loops through "still open, nothing to
    // refresh" forever instead of ever escalating to a human.
    return { status: 'open', changed: false, recheckedLive: true, detail: result };
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
  const match = (output.facts?.findings || []).find((f) => (
    f.recommendedAction?.generatorId === rec.recommendation_type
    && recommendationPageKey({ generatorId: f.recommendedAction.generatorId, params: f.recommendedAction.params }) === rec.page
  ));
  if (!match) {
    await closeRecommendation(rec.id);
    return { status: 'superseded', changed: true };
  }
  if (refreshEvidence && rec.finding_ids?.length) {
    const freshParams = match.recommendedAction?.params;
    if (freshParams) {
      await mergeIntoRecommendation(rec.id, {
        // The SAME finding_id already on the row — a union with itself, not
        // a new one, so this can never grow finding_ids or duplicate
        // anything. Identity is preserved; only params move.
        findingId: rec.finding_ids[0],
        agentId,
        params: freshParams,
        blockedReason: null,
        riskTier: riskTierForGenerator(rec.recommendation_type),
      });
      return { status: 'open', changed: true, refreshed: true, freshParams };
    }
  }
  return { status: 'open', changed: false };
}

// Drop-in replacement for buildRecommendations() at the two call sites that
// render the Action Center's actual recommendation list (see
// routes/action-center.js) — same { items, lastAnalyzedAt } shape, sourced
// from the persisted, deduplicated table instead of a live recompute.
// Draft states that mean the work is FINISHED. A recommendation whose draft
// reached one of these is resolved, and drops off the active board — the
// "Fixed / already applied" end of the lifecycle. Verification
// (store/fix-verifications.js) is what re-opens it if the fix didn't hold.
const RESOLVED_DRAFT_STATUSES = new Set(['implemented', 'merged_to_stage']);

// Draft states that are waiting on a PERSON, not on the system. These stay
// visible as 'blocked' rather than reading as in-flight progress that will
// complete on its own — the distinction lib/draft-ship-state.js draws as
// HUMAN_OWNED, surfaced to the user instead of only to the shipping loop.
const HUMAN_OWNED_DRAFT_STATUSES = new Set(['submitted_for_approval', 'revision_requested']);

// One recommendation, one identity, for its whole life.
//
// Derived on read rather than stored in a column, on purpose. The truth about
// where a recommendation stands lives in three places that each already have
// an owner — the row's own status/blocked_reason, its draft's status and PR
// state, and its attempt history — and a stored lifecycle column would be a
// fourth copy that has to be written correctly by every one of those owners
// or go quietly stale. The bug this whole change exists to fix was caused by
// exactly that kind of drift: a draft that stopped moving while the thing
// deciding what the user sees never heard about it.
export function deriveLifecycle(rec, draft, attempts) {
  if (draft && RESOLVED_DRAFT_STATUSES.has(draft.status)) return 'fixed';
  if (draft && HUMAN_OWNED_DRAFT_STATUSES.has(draft.status)) return 'blocked';
  // A draft carrying an apply_error or a rollback is not in flight — it is a
  // failed attempt that hasn't been reclaimed yet (the reconciler will
  // abandon it on its next pass). Reporting it as 'in progress' is the
  // specific lie that made stalled work look healthy, so it reads as a
  // retry now and the card stays actionable in the meantime.
  if (draft && !draft.apply_error && !draft.rolled_back_at) return 'in_progress';
  if (rec.blocked_reason) return 'blocked';
  if (attempts?.attempts > 0) return 'retry';
  return 'new';
}

export async function getRecommendations(siteId) {
  const [rows, liveDrafts, attemptsByFinding, catByAgent] = await Promise.all([
    listOpenRecommendations(siteId),
    getLiveDraftsByFindingId(siteId),
    attemptSummaryByFinding(siteId),
    categoryByAgentId(),
  ]);
  // A single draft's generator params already cover the whole merged
  // recommendation (mergeIntoRecommendation refreshes `params` to the
  // latest evidence across all finding_ids), so ANY finding_id's draft
  // speaks for the whole recommendation — shipRecommendation only ever
  // drafts finding_ids[0] (routes/action-center.js), so keying off all of
  // them would miss a recommendation merged from multiple findings.
  const draftFor = (r) => {
    for (const fid of r.finding_ids) {
      const d = liveDrafts.get(fid);
      if (d) return d;
    }
    return null;
  };
  const attemptsFor = (r) => {
    // Attempt history is additive across every finding merged into this
    // recommendation: they are the same underlying issue by definition, and
    // resetting the count when a second detector merges in would hand the
    // item a fresh set of retries it hasn't earned.
    let merged = null;
    for (const fid of r.finding_ids) {
      const a = attemptsByFinding.get(fid);
      if (!a) continue;
      if (!merged) { merged = { ...a }; continue; }
      merged.attempts += a.attempts;
      merged.itemDefectAttempts += a.itemDefectAttempts;
      if (a.lastAt > merged.lastAt) {
        merged.lastAt = a.lastAt; merged.lastOutcome = a.lastOutcome;
        merged.lastPolicy = a.lastPolicy; merged.lastReason = a.lastReason;
      }
    }
    return merged;
  };
  const items = rows
    .map((r) => ({ r, draft: draftFor(r), attempts: attemptsFor(r) }))
    .map((ctx) => ({ ...ctx, lifecycle: deriveLifecycle(ctx.r, ctx.draft, ctx.attempts) }))
    // Only a FINISHED recommendation leaves the board. Everything else stays
    // on it — including work in flight, which used to disappear the instant a
    // draft existed and reappear later as a brand-new card with no history.
    // That disappearance is what let 48 recommendations sit invisible behind
    // stalled drafts on site 1, and what made the same issue look new every
    // time it came back. See lib/action-center-reconciler.js.
    .filter((ctx) => ctx.lifecycle !== 'fixed')
    .map(({ r, draft, attempts, lifecycle }) => {
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
        // ---- Lifecycle: one identity, whole life -----------------------
        // 'new' | 'in_progress' | 'retry' | 'blocked'. ('fixed' is derived
        // too, but never reaches here — a fixed recommendation is filtered
        // off the active board above.)
        lifecycle,
        // Where the in-flight work actually is, so "in progress" is a
        // statement the user can check rather than one they have to trust.
        draft: draft
          ? {
            id: draft.id,
            status: draft.status,
            prNumber: draft.pr_number || null,
            prUrl: draft.pr_url || null,
            prState: draft.pr_state || null,
            // A draft waiting on a person needs to say so on the card. The
            // reviewer is the only one who can move it, and until now the
            // card wasn't visible at all for them to find.
            awaitingReview: HUMAN_OWNED_DRAFT_STATUSES.has(draft.status),
          }
          : null,
        // ---- Attempt history -------------------------------------------
        // Why this card is back, in the user's terms. attemptCount is every
        // attempt; itemDefectAttempts is the subset that says something is
        // wrong with the item itself, which is the number the convergence
        // cap acts on (agents/lib/ship-pacing.js).
        attemptCount: attempts?.attempts || 0,
        itemDefectAttempts: attempts?.itemDefectAttempts || 0,
        lastAttemptAt: attempts?.lastAt || null,
        lastFailureReason: attempts?.lastReason || null,
        // 'retry' | 'needs_human' | 'already_resolved' | 'item_defect' |
        // 'never' — see lib/attempt-classification.js. The UI branches on
        // this to tell "we'll try again" apart from "this needs you".
        lastFailurePolicy: attempts?.lastPolicy || null,
      };
    });
  const lastAnalyzedAt = {};
  for (const r of rows) lastAnalyzedAt[r.detecting_agents[0]] = r.last_seen_at;
  return { items, lastAnalyzedAt };
}

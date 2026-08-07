import { findOpenRecommendation, insertRecommendation, mergeIntoRecommendation, listOpenRecommendations, closeStaleRecommendations, getRecommendationById, closeRecommendation } from '../../store/recommendations.js';
import { getDraftedFindingIds } from '../../store/drafts.js';
import { categoryByAgentId } from './command-center.js';
import { riskTierForGenerator } from './risk-tiers.js';
import { classify } from './recommendation-taxonomy.js';
import { recheckLink } from './technical-seo-analysis.js';
import { getSiteById } from '../../store/read.js';
import { daysAgoInTz } from '../../util/dates.js';
import { runAgent } from '../runner.js';

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
export function recommendationPageKey(item) {
  if (item.generatorId === 'analytics-install') return `analytics:${item.params?.provider || 'unknown'}`;
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
export async function syncFromGrounded(siteId, grounded) {
  for (const item of grounded.items) {
    if (!item.generatorId) continue; // buildRecommendations already filters these, but stay defensive
    const page = recommendationPageKey(item);
    const existing = await findOpenRecommendation(siteId, page, item.generatorId);
    if (existing) {
      if (existing.finding_ids.includes(item.id)) continue; // already merged this exact finding, nothing new
      await mergeIntoRecommendation(existing.id, {
        findingId: item.id, agentId: item.source, reason: item.reason,
        params: item.params, priority: item.priority, expectedImpact: item.expectedImpact,
      });
    } else {
      await insertRecommendation(siteId, {
        page, recommendationType: item.generatorId, issue: item.tag, reason: item.reason,
        params: item.params, findingId: item.id, detectingAgent: item.source,
        priority: item.priority, expectedImpact: item.expectedImpact, riskTier: riskTierForGenerator(item.generatorId),
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
    return { status: 'open', changed: false, reason: `re-check failed: ${err.message}` };
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
      };
    });
  const lastAnalyzedAt = {};
  for (const r of rows) lastAnalyzedAt[r.detecting_agents[0]] = r.last_seen_at;
  return { items, lastAnalyzedAt };
}

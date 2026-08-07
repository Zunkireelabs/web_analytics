import { findOpenRecommendation, insertRecommendation, mergeIntoRecommendation, listOpenRecommendations, closeStaleRecommendations } from '../../store/recommendations.js';
import { getDraftedFindingIds } from '../../store/drafts.js';
import { categoryByAgentId } from './command-center.js';
import { riskTierForGenerator } from './risk-tiers.js';
import { classify } from './recommendation-taxonomy.js';

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
  if (grounded.detectedKeys) await closeStaleRecommendations(siteId, grounded.detectedKeys);
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

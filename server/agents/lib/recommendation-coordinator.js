import { findOpenRecommendation, insertRecommendation, mergeIntoRecommendation, listOpenRecommendations } from '../../store/recommendations.js';
import { getDraftedFindingIds } from '../../store/drafts.js';
import { categoryByAgentId } from './command-center.js';
import { riskTierForGenerator } from './risk-tiers.js';

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

// grounded = buildRecommendations()'s { items, lastAnalyzedAt } output.
// Upserts one recommendations row per (siteId, page, generatorId): a new
// key inserts, an existing open key merges in the new finding/agent.
// Deliberately create-and-merge only, never closes a row — buildRecommendations()
// already hides findings that already have a draft, so an item's key
// disappearing from `grounded` could mean either "fixed" or "now drafted,"
// and this milestone has no way to tell those apart yet (auto-closing is
// deferred to whichever later milestone wires draft/execution status back
// into recommendation status).
export async function syncFromGrounded(siteId, grounded) {
  for (const item of grounded.items) {
    if (!item.generatorId) continue; // buildRecommendations already filters these, but stay defensive
    const page = item.params?.page || '';
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
  const items = rows
    .filter((r) => r.finding_ids.some((fid) => !draftedFindingIds.has(fid)))
    .map((r) => ({
      id: String(r.id), findingIds: r.finding_ids,
      source: r.detecting_agents[0], agentName: catByAgent.get(r.detecting_agents[0])?.name || r.detecting_agents[0],
      detectingAgents: r.detecting_agents, supportingAgents: r.supporting_agents,
      tag: r.issue, generatorId: r.recommendation_type,
      reason: r.reason, params: r.params, priority: r.priority, expectedImpact: r.expected_impact,
      riskTier: r.risk_tier,
    }));
  const lastAnalyzedAt = {};
  for (const r of rows) lastAnalyzedAt[r.detecting_agents[0]] = r.last_seen_at;
  return { items, lastAnalyzedAt };
}

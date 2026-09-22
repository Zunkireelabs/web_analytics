import { listOpenRecommendations } from '../../store/recommendations.js';
import { findRelevantMemory } from '../../agent-memory.js';
import { fetchInvestigationEvidence } from './investigation-evidence.js';

// Phase 2 of the "one intelligence" consolidation plan (fix/system) —
// proactive cross-domain evidence gathering for decision-engine.js. This is
// the piece that genuinely did not exist before this plan: the confirmed
// finding was that the Python Investigation Engine and the Node agents'
// `recommendations` table only ever meet at final output (both write via
// insertRecommendation, deduped by findOpenRecommendation), never exchange
// evidence beforehand. gatherCorrelatedEvidence reads from BOTH sides for a
// given situation, so decision-engine can correlate them at decision time
// instead of them silently racing for the same recommendation slot.
//
// Deliberately NOT "always fetch everything" — a relevance selector decides
// which sources are worth querying for a given situationType, per the
// plan's explicit requirement ("do not require every domain for every
// task... determine which evidence is relevant to the current problem").
// Extending this to a new domain later means adding one entry to
// SOURCES_BY_SITUATION plus one fetcher function, not touching the
// situations that already work.

export const SITUATION_TYPES = Object.freeze([
  'keyword_opportunity', 'traffic_decline', 'technical_issue', 'generic',
]);

// Which evidence sources are worth querying per situation type. All three
// current sources are cheap (one indexed DB read + one already-cached HTTP
// call), so the selector mostly documents INTENT rather than saving real
// cost today — but it's the seam a future, more expensive source (e.g. a
// live competitor re-crawl) plugs into without becoming a tax on every
// situation type that doesn't need it.
const SOURCES_BY_SITUATION = {
  keyword_opportunity: ['recommendations', 'memory', 'investigations'],
  traffic_decline: ['investigations', 'recommendations', 'memory'],
  technical_issue: ['recommendations', 'memory'],
  generic: ['recommendations', 'memory', 'investigations'],
};

function recommendationsToEvidence(rows) {
  return rows.map((r) => ({
    source: 'recommendation',
    summary: `${r.recommendation_type} on ${r.page}: ${r.issue}${r.blocked_reason ? ` (blocked: ${r.blocked_reason})` : ''}`,
    ref: `recommendation:${r.id}`,
    meta: {
      recommendationId: r.id, page: r.page, recommendationType: r.recommendation_type,
      priority: r.priority, riskTier: r.risk_tier, status: r.status, blockedKind: r.blocked_kind,
      detectingAgents: r.detecting_agents, expectedImpact: r.expected_impact,
    },
  }));
}

function memoryToEvidence(rows) {
  return rows.map((m) => ({
    source: 'agent-memory',
    summary: `Past outcome — ${m.problemSignature}: ${m.fixStrategy}`,
    ref: `agent_fix_memory:${m.id}`,
    meta: {
      confidence: m.confidence, occurrenceCount: m.occurrenceCount,
      successfulReuseCount: m.successfulReuseCount, failedReuseCount: m.failedReuseCount,
      category: m.category, relevanceReason: m.relevanceReason,
    },
  }));
}

// `deps` is injectable (same createX(deps) shape as recommendation-gates.js
// and decision-engine.js) so this is unit-testable without a real DB or a
// real Data Analyst call.
export function createEvidenceGatherer({
  listOpenRecommendationsFn = listOpenRecommendations,
  findRelevantMemoryFn = findRelevantMemory,
  fetchInvestigationEvidenceFn = fetchInvestigationEvidence,
} = {}) {
  async function gatherCorrelatedEvidence(situationType, siteId, { symptoms = null, problemSignature = null } = {}) {
    const sources = SOURCES_BY_SITUATION[situationType] || SOURCES_BY_SITUATION.generic;
    const evidence = [];

    // Each source is isolated in its own try/catch — the same "one hung/
    // failing source must never take the others down with it" discipline
    // orchestrator.js already applies per-agent (see its AGENT_TIMEOUT_MS
    // comment). A situation with 2 of 3 sources available is still real
    // evidence worth deciding on; decision-engine's own evidence-sufficiency
    // gate (MIN_EVIDENCE_TO_DECIDE) is what decides whether what's left is
    // enough, not this function silently returning nothing on one failure.
    if (sources.includes('recommendations')) {
      try {
        const rows = await listOpenRecommendationsFn(siteId);
        evidence.push(...recommendationsToEvidence(rows));
      } catch (err) {
        console.warn(`[decision-evidence] recommendations source failed for site ${siteId}: ${err.message}`);
      }
    }

    if (sources.includes('memory')) {
      try {
        const rows = await findRelevantMemoryFn({ siteId, symptoms, problemSignature, clientFacing: true });
        evidence.push(...memoryToEvidence(rows));
      } catch (err) {
        console.warn(`[decision-evidence] agent-memory source failed for site ${siteId}: ${err.message}`);
      }
    }

    if (sources.includes('investigations')) {
      try {
        const rows = await fetchInvestigationEvidenceFn(siteId);
        evidence.push(...rows);
      } catch (err) {
        console.warn(`[decision-evidence] investigations source failed for site ${siteId}: ${err.message}`);
      }
    }

    return evidence;
  }

  return { gatherCorrelatedEvidence };
}

export const evidenceGatherer = createEvidenceGatherer();

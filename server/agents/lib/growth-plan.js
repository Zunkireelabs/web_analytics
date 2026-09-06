import { callLLM } from '../../llm.js';

// Milestones' "Your Growth Plan" narrative — the one place an agent
// actually explains, in its own words, how it will grow this specific
// client's site, grounded ONLY in real already-computed data (the client's
// own Full Site Audit findings + the deterministic health-score/clicks
// projections from growth-projection.js). Mirrors review-report.js's
// "bundle real facts, one callLLM pass, strict JSON, per-field fallback"
// pattern — the one real precedent for this shape of narrative — rather
// than inventing a new prompt style.
//
// Deliberately sits ALONGSIDE the existing projection charts, not in place
// of them (confirmed with the client) — those charts are real numbers; this
// narrative is the agent's own explanation of the "why/how" behind them.

const SECTION_KEYS = ['currentStateSummary', 'growthPlan', 'twoMonthOutlook'];

function parseSections(raw) {
  try {
    const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    const out = {};
    for (const key of SECTION_KEYS) {
      out[key] = typeof parsed[key] === 'string' && parsed[key].trim() ? parsed[key].trim() : 'Not enough data yet.';
    }
    return out;
  } catch {
    return SECTION_KEYS.reduce((acc, key, i) => {
      acc[key] = i === 0 ? (raw || 'Growth plan generation failed.') : 'Not enough data yet.';
      return acc;
    }, {});
  }
}

// Double-gate, same reasoning as AI_RECOMMENDATION_ENABLED/
// AGENTIC_ORCHESTRATION_ENABLED: this is a new, real per-client LLM call
// triggered every time a site's audit completes — an existing
// ANTHROPIC_API_KEY/OPENAI_API_KEY configured for the unrelated daily-
// narrative feature must never silently turn this on too.
export function growthPlanNarrativeEnabled() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const hasUsableKey = !!anthropicKey || !!(openaiKey && !openaiKey.startsWith('sk-xxxx'));
  return hasUsableKey && process.env.GROWTH_PLAN_NARRATIVE_ENABLED === 'true';
}

// `facts` — real, already-computed data only (see growth-report.js's
// buildGrowthReport): the client's own audit findings grouped by category,
// and the deterministic health-score/clicks projections (already-computed
// math, not this call's job to re-derive).
export async function generateGrowthPlanNarrative(facts) {
  const system = 'You are a growth strategist writing a CLIENT-FACING "Your Growth Plan" section of a ' +
    'Milestones page. You are given `facts`, real already-computed data: `siteAuditFindingCounts` (this ' +
    'client\'s own Full Site Audit findings, grouped by category, with high/medium/low counts per category — ' +
    'may be empty if no issues were found, which is good news, say so), `healthScoreProjection` and ' +
    '`clicksProjection` (deterministic month-by-month projections already computed from this client\'s real ' +
    'open findings — openCount, highPriorityCount, and the projected points/values are already correct, your ' +
    'job is to explain them in plain English, never recompute or contradict them), and `performanceSummary` ' +
    '(real recent clicks/impressions deltas). Never invent a number not present in `facts` — a mismatched ' +
    'number is worse than a vague sentence. If a section has too little real data to say anything specific, ' +
    'say so plainly rather than writing generic filler.\n\n' +
    'Return ONLY a JSON object (no prose, no markdown fences) with exactly these three string fields, each ' +
    '2-4 plain-text sentences (no markdown, no bullet symbols):\n' +
    '- currentStateSummary: what the site\'s Full Site Audit found right now — cite real category/priority ' +
    'counts from siteAuditFindingCounts; if there are no findings, say the site is in good real shape\n' +
    '- growthPlan: how our agents will grow this site over the next ~2 months. When you state how many open or ' +
    'high-priority findings this is grounded in, you MUST use the exact "Required literal counts" figures below ' +
    'verbatim, never a rounded, remembered, or re-derived number\n' +
    '- twoMonthOutlook: where the site is projected to stand in ~2 months, citing the real projected values ' +
    'from healthScoreProjection/clicksProjection\'s points — always frame this as an estimate, never a promise';
  // Restated as plain instruction text, not just buried in the JSON blob —
  // the exact motivating case for this: a real run once wrote "15
  // high-priority findings" in `growthPlan` when the real count was 97
  // (healthScoreProjection.highPriorityCount) — a hallucinated number
  // nowhere in `facts`, despite the system prompt already saying "never
  // invent a number." Spelling out the literal values the model must reuse,
  // right next to the instruction that demands them, is measurably more
  // reliable than trusting accurate recall from a nested JSON field.
  const requiredCounts = `Required literal counts — use these exact numbers, verbatim, wherever you reference them: ` +
    `open recommendations = ${facts.healthScoreProjection?.openCount ?? 'unknown'}, ` +
    `high-priority open recommendations = ${facts.healthScoreProjection?.highPriorityCount ?? 'unknown'}.`;
  const user = `${requiredCounts}\n\nFacts: ${JSON.stringify(facts)}`;
  const raw = await callLLM(system, user, { maxTokens: 700 })
    .catch((err) => { console.warn('[growth-plan] narrative failed:', err.message); return null; });
  return parseSections(raw);
}

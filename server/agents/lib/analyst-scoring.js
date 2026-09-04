// Prioritizes fused analyst conclusions against EACH OTHER — a distinct
// ranking pass from growth-scoring.js's scoreRecommendation, which ranks a
// day's whole Action Center backlog together (analytics + analyst items
// mixed) once a conclusion has already become a recommendation. This one
// runs BEFORE that: it decides which of tonight's fused conclusions clear
// the evidence bar at all, and orders them so a high-confidence,
// high-impact opportunity always outranks a weak speculative one before
// either ever reaches a recommendation row.
//
// Every factor here is named so a stored analyst_evidence.score_factors
// array answers "why did this beat that" without re-running the function.

const WEIGHTS = {
  // How many INDEPENDENT signal families agree (fusion's corroboration
  // count) — the single strongest lever, because it is the direct answer to
  // "is this one signal dressed up, or several signals agreeing".
  corroboration: 220,
  // The freshness-adjusted confidence fusion computed (0..1).
  confidence: 260,
  // Real measured exposure — impressionsLost + at-risk, from
  // decline-detection.js, or estimatedTrafficGain for growth opportunities.
  // Capped so one enormous page can't make every other factor irrelevant.
  impact: 300,
  // Position erosion specifically is the earliest signal (rankings move
  // before impressions do) — a small urgency bonus on top of impact so two
  // equally-sized opportunities break the tie toward the one already
  // sliding, not the one only theoretically at risk.
  urgency: 80,
  // 'direct' capability relevance beats 'unmapped' — an opportunity tied to
  // a real, verified product is more defensible than one the mapping layer
  // could not place anywhere.
  productRelevance: 60,
  // Whether a real, safe generator/surface already exists for this
  // conclusion (expand an existing page, splice an FAQ) vs. one that would
  // need infrastructure that doesn't exist yet (a comparison-page
  // generator). An opportunity nothing can act on yet should still be
  // visible, just not out-rank one that is immediately actionable.
  feasibility: 50,
};

const IMPACT_CAP = 5000;

export function scoreConclusion(conclusion) {
  const factors = [];
  let score = 0;

  const corroborationPoints = Math.min(4, conclusion.corroboration) * (WEIGHTS.corroboration / 4);
  score += corroborationPoints;
  factors.push(`${conclusion.corroboration} corroborating signal(s) (+${Math.round(corroborationPoints)})`);

  const confidencePoints = (conclusion.confidence || 0) * WEIGHTS.confidence;
  score += confidencePoints;
  factors.push(`confidence ${(conclusion.confidence || 0).toFixed(2)} (+${Math.round(confidencePoints)})`);

  const impact = Math.min(IMPACT_CAP, Math.max(0, conclusion.impact || 0));
  const impactPoints = (impact / IMPACT_CAP) * WEIGHTS.impact;
  score += impactPoints;
  if (impact > 0) factors.push(`measured impact ${Math.round(conclusion.impact)} (+${Math.round(impactPoints)})`);

  if (conclusion.urgent) {
    score += WEIGHTS.urgency;
    factors.push(`early-signal urgency (+${WEIGHTS.urgency})`);
  }

  if (conclusion.productRelevance === 'direct') {
    score += WEIGHTS.productRelevance;
    factors.push(`direct product relevance (+${WEIGHTS.productRelevance})`);
  }

  if (conclusion.feasible) {
    score += WEIGHTS.feasibility;
    factors.push(`actionable surface available (+${WEIGHTS.feasibility})`);
  } else {
    factors.push('no actionable surface exists yet (+0)');
  }

  return { score: Math.round(score), factors };
}

// Duplicate suppression across THIS run's conclusions: two conclusions
// about the same underlying page/topic must not both ship as separate
// recommendations. Keeps the higher-scored one; the loser is folded into
// the winner's evidence rather than dropped silently, so a page that both
// declined AND showed a growth signal in adjacent queries is still visible
// as one richer conclusion instead of two competing ones.
export function dedupeConclusions(conclusions) {
  const bySubject = new Map();
  for (const c of conclusions) {
    const key = `${c.direction}:${c.subjectKey}`;
    const existing = bySubject.get(key);
    if (!existing || c.score > existing.score) {
      if (existing) c.mergedFrom = [...(c.mergedFrom || []), existing.findingId];
      bySubject.set(key, c);
    }
  }
  return [...bySubject.values()].sort((a, b) => b.score - a.score);
}

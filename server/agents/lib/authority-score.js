// Transparent, weighted, reproducible Authority Score (0-100) — see
// server/agents/authority.js. Every component is a documented, versioned
// formula over real DataForSEO backlink data (server/ingest/dataforseo-
// backlinks.js), never a random value or an opaque model. A component is
// computed ONLY when its real underlying data is present; missing
// components are excluded and the remaining weights renormalize to sum to
// 100 — never fabricated as a zero, which would silently punish a site for
// data DataForSEO simply didn't return this run (e.g. no anchor data yet).
//
// SCORING_VERSION bumps whenever a formula/weight changes, so a caller
// comparing scores across versions can detect the discontinuity instead of
// misreading a formula change as a real swing in authority.
export const SCORING_VERSION = 1;

// Weight budget out of 100 when every component has real data. A future
// spam/toxicity component (only available if DataForSEO's plan returns a
// real spam signal — it doesn't in the fields this agent currently reads)
// would take 10 from these, not add a 6th independent weight — kept as a
// comment, not implemented, so nothing here claims a signal that doesn't
// exist yet.
const WEIGHTS = {
  referringDomains: 30,
  diversity: 15,
  followRatio: 15,
  growth: 20,
  anchorDiversity: 10,
};

// Diminishing-returns curve — log-scaled so the jump from 10→100 referring
// domains matters far more than 10,000→10,090. Reaches 100 around 100k
// referring domains (an extreme, effectively unreachable ceiling for most
// real sites), by design never realistically saturating.
function scoreReferringDomains(n) {
  if (n == null) return null;
  return Math.max(0, Math.min(100, 20 * Math.log10(1 + Math.max(0, n))));
}

// Real referring IPs/subnets relative to referring domains — a link profile
// where every domain resolves to the same handful of IPs is a real,
// well-known link-scheme signal, not an invented penalty.
function scoreDiversity(ips, subnets, domains) {
  if (!domains || domains <= 0) return null;
  const ratios = [];
  if (ips != null) ratios.push(Math.min(1, ips / domains));
  if (subnets != null) ratios.push(Math.min(1, subnets / domains));
  if (!ratios.length) return null;
  return (ratios.reduce((a, b) => a + b, 0) / ratios.length) * 100;
}

// Follow links carry real ranking weight; nofollow largely doesn't — a
// higher follow ratio is a real (not assumed) stronger-authority signal.
function scoreFollowRatio(follow, nofollow) {
  if (follow == null && nofollow == null) return null;
  const total = (follow ?? 0) + (nofollow ?? 0);
  if (total <= 0) return null;
  return ((follow ?? 0) / total) * 100;
}

// Net new-minus-lost over the trailing 30 days, normalized against the
// site's own total backlink count so the same absolute net change means
// more for a small link profile than a huge one. 50 = flat, 100 = maximum
// real growth this run could show, 0 = maximum real loss.
function scoreGrowth(newCount, lostCount, totalBacklinks) {
  if (newCount == null || lostCount == null) return null;
  const net = newCount - lostCount;
  const base = Math.max(totalBacklinks || 0, 1);
  const ratio = Math.max(-1, Math.min(1, net / base));
  return 50 + ratio * 50;
}

// Anchor-text concentration — a single anchor phrase dominating every
// backlink is a real, well-known over-optimization/manipulation signal.
// Diversity = 1 minus the top anchor's real share of total anchor volume.
function scoreAnchorDiversity(anchors) {
  if (!anchors?.length) return null;
  const total = anchors.reduce((s, a) => s + (a.backlinks || 0), 0);
  if (total <= 0) return null;
  const topShare = Math.max(...anchors.map((a) => a.backlinks || 0)) / total;
  return Math.max(0, Math.min(100, (1 - topShare) * 100));
}

// Computes the overall score + a fully itemized, real breakdown (each
// component's raw input, computed sub-score, and its renormalized weight
// this run) — the literal data an executive narrative diffs against a
// prior snapshot to explain "why the score changed," and what
// score_breakdown persists for audit. Returns null only when every single
// component is unavailable (no real backlink data at all this run).
export function computeAuthorityScore({ summary, changes, anchors }) {
  const components = [];
  const rd = scoreReferringDomains(summary?.referringDomains);
  if (rd != null) components.push({ key: 'referringDomains', label: 'Referring domains', weight: WEIGHTS.referringDomains, score: rd, raw: summary.referringDomains });

  const div = scoreDiversity(summary?.referringIps, summary?.referringSubnets, summary?.referringDomains);
  if (div != null) components.push({ key: 'diversity', label: 'IP/subnet diversity', weight: WEIGHTS.diversity, score: div, raw: { ips: summary.referringIps, subnets: summary.referringSubnets } });

  const follow = scoreFollowRatio(summary?.followBacklinks, summary?.nofollowBacklinks);
  if (follow != null) components.push({ key: 'followRatio', label: 'Follow-link ratio', weight: WEIGHTS.followRatio, score: follow, raw: { follow: summary.followBacklinks, nofollow: summary.nofollowBacklinks } });

  const growth = scoreGrowth(changes?.newBacklinks, changes?.lostBacklinks, summary?.totalBacklinks);
  if (growth != null) components.push({ key: 'growth', label: 'Net backlink growth (30d)', weight: WEIGHTS.growth, score: growth, raw: { new: changes.newBacklinks, lost: changes.lostBacklinks } });

  const anchorDiv = scoreAnchorDiversity(anchors);
  if (anchorDiv != null) components.push({ key: 'anchorDiversity', label: 'Anchor-text diversity', weight: WEIGHTS.anchorDiversity, score: anchorDiv, raw: { distinctAnchors: anchors.length } });

  if (!components.length) return null;

  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  const overall = components.reduce((s, c) => s + (c.score * c.weight) / totalWeight, 0);
  const breakdown = components.map((c) => ({
    ...c,
    score: Math.round(c.score * 10) / 10,
    normalizedWeightPct: Math.round((c.weight / totalWeight) * 1000) / 10,
  }));

  return { score: Math.round(Math.max(0, Math.min(100, overall))), breakdown };
}

// Diffs two real stored score_breakdown arrays (this run vs. the prior
// snapshot) into plain-language reasons — "+18 referring domains" style —
// computed entirely in JS from real numbers, never asked of an LLM.
export function diffBreakdowns(current, prior) {
  if (!prior?.length) return [];
  const priorByKey = new Map(prior.map((c) => [c.key, c]));
  const reasons = [];
  for (const c of current) {
    const before = priorByKey.get(c.key);
    if (!before) continue;
    if (c.key === 'referringDomains' && typeof c.raw === 'number' && typeof before.raw === 'number') {
      const delta = c.raw - before.raw;
      if (delta !== 0) reasons.push(`${delta > 0 ? '+' : ''}${delta} referring domains`);
    }
    if (c.key === 'growth' && c.raw?.new != null && c.raw?.lost != null) {
      reasons.push(`${c.raw.new} new backlinks, ${c.raw.lost} lost`);
    }
    if (c.key === 'diversity' && c.score - before.score >= 5) reasons.push('improved IP/subnet diversity');
    if (c.key === 'diversity' && c.score - before.score <= -5) reasons.push('reduced IP/subnet diversity');
  }
  return reasons;
}

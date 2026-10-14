// Goal alignment — a NEW decision signal added alongside existing technical
// impact/evidence/risk/safety signals, never a replacement for them (see
// server/store/recommendations.js's listOpenRecommendations for where this
// combines with the existing priority tier, and recommendation-gates.js /
// ship-pacing.js for the safety/risk gates this module never touches).
//
// Deliberately fully deterministic, no LLM call — confirmed during scoping
// that decision-engine.js's decide() has essentially no real callers today
// (only action-center-reconciler.js's capability-gap pass), so "goal
// alignment reasoned by the Decision Engine" cannot mean an LLM call per
// finding per site: that's an uncosted, unbounded new API-spend surface
// across every finding on every site, every sync. This evaluator gives the
// same honest, non-fabricating verdict a careful human would reach from the
// same two concrete signals a site owner's own goal configuration provides —
// target page patterns and business-area/topic text — and explicitly
// reports insufficient_evidence rather than guessing when neither is
// checkable. Centralized here (not per-agent) so every agent's findings are
// judged by the same rule.

export const ALIGNMENT_LEVELS = Object.freeze(['strong', 'partial', 'weak', 'none', 'insufficient_evidence']);

// Lower rank = more informative/decisive verdict, used to pick the single
// best-matching goal across a site's several active goals for one finding.
const LEVEL_RANK = { strong: 0, partial: 1, weak: 2, none: 3, insufficient_evidence: 4 };

function normalizePath(value) {
  if (!value) return '/';
  let path = value;
  try { path = new URL(value).pathname; } catch { /* already a bare path/pattern fragment, not a full URL */ }
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path;
}

// A pattern is either an exact path ('/pricing') or a prefix wildcard
// ('/booking-software/*'). Boundary-safe: '/booking-software/*' matches
// '/booking-software' and '/booking-software/x' but never '/booking-softwarex'.
export function matchesPagePattern(page, pattern) {
  if (!page || !pattern) return false;
  const path = normalizePath(page);
  if (pattern.endsWith('*')) {
    const prefix = normalizePath(pattern.slice(0, -1));
    if (prefix === '/') return true; // '/*' matches every page
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return path === normalizePath(pattern);
}

export function matchesAnyPagePattern(page, patterns) {
  return Array.isArray(patterns) && patterns.some((p) => matchesPagePattern(page, p));
}

// Generic connective/structural words, PLUS generic SEO/business filler
// ("content", "growth", "quality", ...) excluded so a coincidental shared
// word never counts as real topical overlap — two goals about completely
// different business areas will both mention "content" or "improve"
// somewhere, and treating that as evidence of a real connection is exactly
// the kind of fabricated alignment this module must not produce. Only words
// specific enough to actually name a business area/topic (e.g. "booking",
// "software", "cardiology") count.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'with', 'is', 'are', 'was', 'were',
  'this', 'that', 'these', 'those', 'page', 'pages', 'site', 'sites', 'your', 'you', 'we', 'our',
  'it', 'its', 'be', 'as', 'at', 'by', 'from', 'will', 'has', 'have', 'not', 'but', 'can', 'more',
  'content', 'growth', 'grow', 'improve', 'improving', 'increase', 'increasing', 'quality', 'value',
  'coverage', 'performance', 'feature', 'features', 'result', 'results', 'business', 'goal', 'goals',
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

// null = the goal itself has no matchable text at all (extremely rare given
// objective is required, but a purely-stopword objective is possible) —
// distinct from false (real text on both sides, genuinely no overlap).
export function hasKeywordOverlap(findingText, goal) {
  const goalTokens = new Set(tokenize([goal.objective, goal.targetBusinessArea, goal.description].filter(Boolean).join(' ')));
  if (goalTokens.size === 0) return null;
  const findingTokens = tokenize(findingText);
  return findingTokens.some((t) => goalTokens.has(t));
}

// finding: { page, reason, tag, category } — the same fields buildRecommendations
// already has in hand per item (agents/lib/recommendations.js). Returns
// {level, rationale}, never throws, never fabricates a connection that isn't
// backed by an actual page-pattern or keyword match.
export function evaluateGoalAlignment(goal, finding) {
  const page = finding.page || null;
  const text = [finding.reason, finding.tag, finding.category].filter(Boolean).join(' ');

  const hasPagePatterns = Array.isArray(goal.targetPagePatterns) && goal.targetPagePatterns.length > 0;
  const keywordHit = hasKeywordOverlap(text, goal); // true | false | null

  if (!page && !hasPagePatterns && keywordHit === null) {
    return { level: 'insufficient_evidence', rationale: `Goal "${goal.objective}" has no target pages or descriptive detail, and this finding has no page, to compare.` };
  }
  if (hasPagePatterns && !page) {
    if (keywordHit === true) return { level: 'weak', rationale: `Goal "${goal.objective}" targets specific pages this finding's page could not be checked against, but the topic overlaps.` };
    return { level: 'insufficient_evidence', rationale: `Goal "${goal.objective}" targets specific pages, and this finding has no page to check it against.` };
  }

  const pageMatches = hasPagePatterns && matchesAnyPagePattern(page, goal.targetPagePatterns);
  if (pageMatches) {
    return { level: 'strong', rationale: `This finding's page directly matches goal "${goal.objective}"'s target pages.` };
  }
  if (keywordHit === true) {
    return hasPagePatterns
      ? { level: 'weak', rationale: `Topically related to goal "${goal.objective}", but not on one of its target pages.` }
      : { level: 'partial', rationale: `Topically related to goal "${goal.objective}" (no specific target pages configured for this goal).` };
  }
  if (keywordHit === null) {
    return { level: 'insufficient_evidence', rationale: `Goal "${goal.objective}" has no descriptive detail beyond its target pages, which this finding's page did not match.` };
  }
  return { level: 'none', rationale: `No page or topic overlap found with goal "${goal.objective}".` };
}

// Evaluates a finding against every active goal and returns the single most
// informative result — ties (same alignment level) broken by the goal's own
// configured importance (lower = more important, same convention
// PRIORITY_RANK already uses). Returns null when the site has no active
// goals at all, so a caller can skip persisting anything — the documented
// "absence means unconfigured" convention, not a fabricated 'none'.
export function pickBestGoalAlignment(activeGoals, finding) {
  if (!activeGoals || activeGoals.length === 0) return null;

  let best = null;
  let bestImportance = Infinity;
  for (const goal of activeGoals) {
    const result = evaluateGoalAlignment(goal, finding);
    const better = !best
      || LEVEL_RANK[result.level] < LEVEL_RANK[best.level]
      || (LEVEL_RANK[result.level] === LEVEL_RANK[best.level] && goal.importance < bestImportance);
    if (better) {
      best = { goalId: goal.id, level: result.level, rationale: result.rationale };
      bestImportance = goal.importance;
    }
  }
  return best;
}

// Combines the existing, agent-local priority tier with the goal-alignment
// boost into one blended score — the ONE new prioritization rule, applied
// centrally (server/store/recommendations.js's listOpenRecommendations),
// never per-agent. Tier gap is 10 points; 'strong' alignment (12) can bridge
// exactly one adjacent tier (e.g. medium+strong beats high+none) but never
// two (low+strong never beats high+none) — "a slightly lower raw-impact
// finding may surface ahead of a slightly higher one", not a leapfrog.
// 'partial'/'weak' are real but insufficient on their own to bridge a full
// tier — they only matter as a same-tier tie-breaker. 'none'/
// 'insufficient_evidence' add nothing: an unaligned finding is judged purely
// on its existing technical merit, never penalized for lacking a goal match.
export const PRIORITY_TIER_SCORE = Object.freeze({ high: 30, medium: 20, low: 10 });
export const GOAL_ALIGNMENT_BOOST = Object.freeze({ strong: 12, partial: 6, weak: 2, none: 0, insufficient_evidence: 0 });

export function effectivePriorityScore(priority, alignmentLevel) {
  const base = PRIORITY_TIER_SCORE[priority] ?? PRIORITY_TIER_SCORE.medium;
  const boost = GOAL_ALIGNMENT_BOOST[alignmentLevel] ?? 0;
  return base + boost;
}

// Descending — higher effective score sorts first. Callers with an existing
// ASCENDING PRIORITY_RANK comparator (0 = high first) are computing the
// opposite direction; this is a distinct, additive comparator, not a
// drop-in replacement, so a caller must intentionally switch sort direction
// when adopting it (see listOpenRecommendations for the one place that does).
export function compareByEffectivePriority(a, b) {
  const scoreA = effectivePriorityScore(a.priority, a.goalAlignment?.level);
  const scoreB = effectivePriorityScore(b.priority, b.goalAlignment?.level);
  return scoreB - scoreA;
}

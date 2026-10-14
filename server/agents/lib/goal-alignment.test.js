import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesPagePattern, hasKeywordOverlap, evaluateGoalAlignment, pickBestGoalAlignment,
  effectivePriorityScore, compareByEffectivePriority, ALIGNMENT_LEVELS,
} from './goal-alignment.js';

function goal(overrides = {}) {
  return {
    id: 1, objective: 'Generate leads for booking software', targetBusinessArea: 'booking software',
    targetPagePatterns: ['/booking-software/*'], description: null, importance: 1,
    ...overrides,
  };
}

describe('matchesPagePattern', () => {
  test('a trailing-* pattern matches the exact prefix and its sub-paths', () => {
    assert.equal(matchesPagePattern('/booking-software', '/booking-software/*'), true);
    assert.equal(matchesPagePattern('/booking-software/pricing', '/booking-software/*'), true);
  });
  test('never matches a boundary-unsafe near-miss', () => {
    assert.equal(matchesPagePattern('/booking-softwarex', '/booking-software/*'), false);
  });
  test('a bare pattern requires an exact path match', () => {
    assert.equal(matchesPagePattern('/pricing', '/pricing'), true);
    assert.equal(matchesPagePattern('/pricing/extra', '/pricing'), false);
  });
  test('a full URL and a bare path pattern are compared by pathname only', () => {
    assert.equal(matchesPagePattern('https://example.com/booking-software/pricing/', '/booking-software/*'), true);
  });
  test('"/*" matches every page', () => {
    assert.equal(matchesPagePattern('/anything/at/all', '/*'), true);
  });
  test('null/undefined page or pattern never matches', () => {
    assert.equal(matchesPagePattern(null, '/x/*'), false);
    assert.equal(matchesPagePattern('/x', null), false);
  });
});

describe('hasKeywordOverlap', () => {
  test('true when finding text shares a meaningful word with the goal', () => {
    assert.equal(hasKeywordOverlap('Meta description missing for booking page', goal()), true);
  });
  test('false when there is real text on both sides but no shared word', () => {
    assert.equal(hasKeywordOverlap('Alt text missing on the gallery image', goal()), false);
  });
  test('stopwords never count as overlap on their own', () => {
    assert.equal(hasKeywordOverlap('This page and your site', goal({ targetBusinessArea: null, objective: 'Generate more bookings for the site' })), false);
  });
  test('null when the goal itself has no matchable text at all', () => {
    const textless = goal({ objective: 'and the', targetBusinessArea: null, description: null });
    assert.equal(hasKeywordOverlap('anything', textless), null);
  });
});

describe('evaluateGoalAlignment — never fabricates, always evidence-backed', () => {
  test('strong: the finding\'s page matches the goal\'s target pages', () => {
    const result = evaluateGoalAlignment(goal(), { page: '/booking-software/pricing', reason: 'unrelated text', tag: '', category: '' });
    assert.equal(result.level, 'strong');
    assert.match(result.rationale, /target pages/);
  });

  test('weak: page-scoped goal, wrong page, but topical overlap', () => {
    const result = evaluateGoalAlignment(goal(), { page: '/blog/some-post', reason: 'Improve booking software onboarding flow', tag: '', category: '' });
    assert.equal(result.level, 'weak');
  });

  test('partial: topic-only goal (no page patterns), keyword match', () => {
    const topicGoal = goal({ targetPagePatterns: [] });
    const result = evaluateGoalAlignment(topicGoal, { page: '/anywhere', reason: 'This covers booking software features', tag: '', category: '' });
    assert.equal(result.level, 'partial');
  });

  test('none: real evidence on both sides, genuinely no overlap', () => {
    const result = evaluateGoalAlignment(goal(), { page: '/blog/unrelated', reason: 'Alt text missing on gallery image', tag: '', category: 'accessibility' });
    assert.equal(result.level, 'none');
  });

  test('insufficient_evidence: page-scoped goal, finding has no page at all', () => {
    const result = evaluateGoalAlignment(goal(), { page: null, reason: 'Something unrelated', tag: '', category: '' });
    assert.equal(result.level, 'insufficient_evidence');
  });

  test('page-scoped goal, no page, but topic DOES overlap -> weak, not insufficient (real evidence exists)', () => {
    const result = evaluateGoalAlignment(goal(), { page: null, reason: 'booking software improvements', tag: '', category: '' });
    assert.equal(result.level, 'weak');
  });

  test('insufficient_evidence: goal has no page patterns and no matchable text', () => {
    const emptyGoal = goal({ targetPagePatterns: [], objective: 'and the', targetBusinessArea: null, description: null });
    const result = evaluateGoalAlignment(emptyGoal, { page: '/x', reason: 'anything', tag: '', category: '' });
    assert.equal(result.level, 'insufficient_evidence');
  });

  test('every returned level is one of the declared ALIGNMENT_LEVELS', () => {
    const cases = [
      { page: '/booking-software/x', reason: '', tag: '', category: '' },
      { page: '/blog/x', reason: 'booking software', tag: '', category: '' },
      { page: '/blog/x', reason: 'nothing related', tag: '', category: '' },
      { page: null, reason: '', tag: '', category: '' },
    ];
    for (const finding of cases) {
      assert.ok(ALIGNMENT_LEVELS.includes(evaluateGoalAlignment(goal(), finding).level));
    }
  });
});

describe('pickBestGoalAlignment', () => {
  test('returns null when there are no active goals — never fabricates a "none"', () => {
    assert.equal(pickBestGoalAlignment([], { page: '/x', reason: 'x' }), null);
    assert.equal(pickBestGoalAlignment(null, { page: '/x', reason: 'x' }), null);
  });

  test('picks the most informative (lowest-rank) result across multiple goals', () => {
    const goals = [
      goal({ id: 1, targetPagePatterns: [], objective: 'Increase organic traffic overall', targetBusinessArea: null, importance: 1 }),
      goal({ id: 2, targetPagePatterns: ['/booking-software/*'], objective: 'Generate leads for booking software', importance: 2 }),
    ];
    const result = pickBestGoalAlignment(goals, { page: '/booking-software/pricing', reason: 'unrelated', tag: '', category: '' });
    assert.equal(result.goalId, 2); // strong beats goal 1's none/insufficient, even though goal 1 is "more important"
    assert.equal(result.level, 'strong');
  });

  test('ties on alignment level are broken by the goal\'s own importance (lower wins)', () => {
    const goals = [
      goal({ id: 1, targetPagePatterns: ['/a/*'], objective: 'Goal A', importance: 5 }),
      goal({ id: 2, targetPagePatterns: ['/a/*'], objective: 'Goal B', importance: 1 }),
    ];
    const result = pickBestGoalAlignment(goals, { page: '/a/x', reason: '', tag: '', category: '' });
    assert.equal(result.goalId, 2, 'both are strong; goal 2 has lower (more important) importance');
  });
});

describe('effectivePriorityScore / compareByEffectivePriority — the worked examples', () => {
  test("medium+strong beats high+none — the user's own example", () => {
    const A = { priority: 'high', goalAlignment: null };
    const B = { priority: 'medium', goalAlignment: { level: 'strong' } };
    assert.ok(effectivePriorityScore(B.priority, B.goalAlignment.level) > effectivePriorityScore(A.priority, A.goalAlignment?.level));
    const arr = [A, B].sort(compareByEffectivePriority);
    assert.equal(arr[0], B, 'B (medium+strong) sorts ahead of A (high+none)');
  });

  test('strong alignment can bridge exactly one tier, never two: low+strong does not beat high+none', () => {
    const low = { priority: 'low', goalAlignment: { level: 'strong' } };
    const high = { priority: 'high', goalAlignment: null };
    const arr = [low, high].sort(compareByEffectivePriority);
    assert.equal(arr[0], high);
  });

  test('partial/weak alignment never bridges a full tier on their own', () => {
    const mediumPartial = { priority: 'medium', goalAlignment: { level: 'partial' } };
    const high = { priority: 'high', goalAlignment: null };
    const arr = [mediumPartial, high].sort(compareByEffectivePriority);
    assert.equal(arr[0], high);
  });

  test('a finding with no goal association is judged purely on raw priority, never penalized', () => {
    const noGoal = { priority: 'high', goalAlignment: null };
    const insufficientEvidence = { priority: 'high', goalAlignment: { level: 'insufficient_evidence' } };
    assert.equal(effectivePriorityScore(noGoal.priority, noGoal.goalAlignment?.level), effectivePriorityScore(insufficientEvidence.priority, insufficientEvidence.goalAlignment.level));
  });

  test('within the same tier, alignment level still breaks the tie in a sensible order', () => {
    const items = [
      { id: 'none', priority: 'medium', goalAlignment: { level: 'none' } },
      { id: 'strong', priority: 'medium', goalAlignment: { level: 'strong' } },
      { id: 'weak', priority: 'medium', goalAlignment: { level: 'weak' } },
      { id: 'partial', priority: 'medium', goalAlignment: { level: 'partial' } },
    ];
    const order = [...items].sort(compareByEffectivePriority).map((i) => i.id);
    assert.deepEqual(order, ['strong', 'partial', 'weak', 'none']);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scoreConclusion, dedupeConclusions } from './analyst-scoring.js';

describe('scoreConclusion', () => {
  test('a high-confidence, high-impact, corroborated conclusion outranks a weak speculative one', () => {
    const strong = scoreConclusion({ corroboration: 4, confidence: 0.9, impact: 3000, urgent: true, productRelevance: 'direct', feasible: true });
    const weak = scoreConclusion({ corroboration: 1, confidence: 0.2, impact: 50, urgent: false, productRelevance: 'unmapped', feasible: false });
    assert.ok(strong.score > weak.score, `strong (${strong.score}) must outrank weak (${weak.score})`);
  });

  test('zero confidence (stale-gated conclusion) scores far lower than the same conclusion with real confidence', () => {
    const fresh = scoreConclusion({ corroboration: 3, confidence: 0.8, impact: 1000, urgent: false, productRelevance: 'direct', feasible: true });
    const staleGated = scoreConclusion({ corroboration: 3, confidence: 0, impact: 1000, urgent: false, productRelevance: 'direct', feasible: true });
    assert.ok(fresh.score > staleGated.score);
  });

  test('factors explain the score', () => {
    const { factors } = scoreConclusion({ corroboration: 2, confidence: 0.5, impact: 200, urgent: true, productRelevance: 'direct', feasible: true });
    assert.ok(factors.some((f) => f.includes('corroborating')));
    assert.ok(factors.some((f) => f.includes('confidence')));
  });
});

describe('dedupeConclusions', () => {
  test('keeps only the higher-scored conclusion for the same (direction, subject)', () => {
    const a = { direction: 'decline-risk', subjectKey: '/p', score: 500, findingId: 'a' };
    const b = { direction: 'decline-risk', subjectKey: '/p', score: 800, findingId: 'b' };
    const out = dedupeConclusions([a, b]);
    assert.equal(out.length, 1);
    assert.equal(out[0].findingId, 'b');
    assert.deepEqual(out[0].mergedFrom, ['a']);
  });

  test('different directions on the same page are NOT deduped — both are real', () => {
    const decline = { direction: 'decline-risk', subjectKey: '/p', score: 500, findingId: 'a' };
    const growth = { direction: 'growth-opportunity', subjectKey: '/p', score: 400, findingId: 'b' };
    const out = dedupeConclusions([decline, growth]);
    assert.equal(out.length, 2);
  });

  test('sorted best-first', () => {
    const out = dedupeConclusions([
      { direction: 'growth-opportunity', subjectKey: '/a', score: 100, findingId: 'a' },
      { direction: 'growth-opportunity', subjectKey: '/b', score: 900, findingId: 'b' },
      { direction: 'growth-opportunity', subjectKey: '/c', score: 400, findingId: 'c' },
    ]);
    assert.deepEqual(out.map((o) => o.findingId), ['b', 'c', 'a']);
  });
});

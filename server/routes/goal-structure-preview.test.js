import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validGoalStructureProposal } from './clients.js';

// The custom-goal AI structure preview (Stage 2b of the Business Goals plan)
// never saves anything — callLLMForJson's `validate` option is the only
// thing standing between a malformed/hallucinated shape and a 500, or worse,
// a proposal the frontend renders into form fields that silently accepts
// e.g. a non-array targetPagePatterns. Same "test the pure logic directly"
// convention as validateAnalyticsIdsRequest in this same file.

describe('validGoalStructureProposal', () => {
  test('accepts a well-formed proposal', () => {
    assert.equal(validGoalStructureProposal({
      objective: 'Grow qualified organic bookings for the pricing page',
      targetBusinessArea: 'Booking software product line',
      targetPagePatterns: ['/pricing', '/booking-software/*'],
      primaryMetric: 'Organic bookings',
    }), true);
  });

  test('accepts nulls for the optional fields', () => {
    assert.equal(validGoalStructureProposal({
      objective: 'Increase organic visibility',
      targetBusinessArea: null,
      targetPagePatterns: [],
      primaryMetric: null,
    }), true);
  });

  test('rejects a missing objective', () => {
    assert.equal(validGoalStructureProposal({
      targetBusinessArea: null, targetPagePatterns: [], primaryMetric: null,
    }), false);
  });

  test('rejects a blank objective', () => {
    assert.equal(validGoalStructureProposal({
      objective: '   ', targetBusinessArea: null, targetPagePatterns: [], primaryMetric: null,
    }), false);
  });

  test('rejects targetPagePatterns that is not an array', () => {
    assert.equal(validGoalStructureProposal({
      objective: 'x', targetBusinessArea: null, targetPagePatterns: '/pricing', primaryMetric: null,
    }), false);
  });

  test('rejects a targetPagePatterns array containing a non-string', () => {
    assert.equal(validGoalStructureProposal({
      objective: 'x', targetBusinessArea: null, targetPagePatterns: ['/pricing', 3], primaryMetric: null,
    }), false);
  });

  test('rejects a non-string, non-null targetBusinessArea', () => {
    assert.equal(validGoalStructureProposal({
      objective: 'x', targetBusinessArea: 5, targetPagePatterns: [], primaryMetric: null,
    }), false);
  });

  test('rejects null entirely', () => {
    assert.equal(validGoalStructureProposal(null), false);
  });
});

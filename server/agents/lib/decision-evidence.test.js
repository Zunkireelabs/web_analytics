import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
const { createEvidenceGatherer, SITUATION_TYPES } = await import(resolve('./decision-evidence.js'));

function neutralDeps(overrides = {}) {
  return {
    listOpenRecommendationsFn: async () => [],
    findRelevantMemoryFn: async () => [],
    fetchInvestigationEvidenceFn: async () => [],
    ...overrides,
  };
}

describe('gatherCorrelatedEvidence — source selection', () => {
  test('queries all three sources for a keyword_opportunity situation', async () => {
    const calls = { recs: 0, memory: 0, investigations: 0 };
    const gatherer = createEvidenceGatherer(neutralDeps({
      listOpenRecommendationsFn: async () => { calls.recs++; return []; },
      findRelevantMemoryFn: async () => { calls.memory++; return []; },
      fetchInvestigationEvidenceFn: async () => { calls.investigations++; return []; },
    }));

    await gatherer.gatherCorrelatedEvidence('keyword_opportunity', 1);
    assert.deepEqual(calls, { recs: 1, memory: 1, investigations: 1 });
  });

  test('falls back to the generic source set for an unknown situation type', async () => {
    const calls = { recs: 0 };
    const gatherer = createEvidenceGatherer(neutralDeps({
      listOpenRecommendationsFn: async () => { calls.recs++; return []; },
    }));
    await gatherer.gatherCorrelatedEvidence('not-a-real-situation', 1);
    assert.equal(calls.recs, 1);
  });
});

describe('gatherCorrelatedEvidence — mapping and isolation', () => {
  test('maps recommendation rows into Evidence shape', async () => {
    const gatherer = createEvidenceGatherer(neutralDeps({
      listOpenRecommendationsFn: async () => [{
        id: 10, page: '/blog/x', recommendation_type: 'meta-title', issue: 'missing meta description',
        blocked_reason: null, priority: 'high', risk_tier: 'auto', status: 'open', blocked_kind: null,
        detecting_agents: ['technical-seo'], expected_impact: { value: 50, basis: 'estimate' },
      }],
    }));
    const evidence = await gatherer.gatherCorrelatedEvidence('technical_issue', 1);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].source, 'recommendation');
    assert.equal(evidence[0].ref, 'recommendation:10');
    assert.match(evidence[0].summary, /missing meta description/);
  });

  test('maps memory rows into Evidence shape', async () => {
    const gatherer = createEvidenceGatherer(neutralDeps({
      findRelevantMemoryFn: async () => [{
        id: 3, problemSignature: 'missing-alt-text', fixStrategy: 'add descriptive alt text',
        confidence: 0.9, occurrenceCount: 4, successfulReuseCount: 3, failedReuseCount: 0,
        category: 'content', relevanceReason: 'keyword-overlap',
      }],
    }));
    const evidence = await gatherer.gatherCorrelatedEvidence('technical_issue', 1);
    assert.equal(evidence[0].source, 'agent-memory');
    assert.equal(evidence[0].ref, 'agent_fix_memory:3');
  });

  test('one failing source does not take the others down with it', async () => {
    const gatherer = createEvidenceGatherer(neutralDeps({
      listOpenRecommendationsFn: async () => { throw new Error('db down'); },
      findRelevantMemoryFn: async () => [{ id: 1, problemSignature: 'x', fixStrategy: 'y', confidence: 0.5, occurrenceCount: 1, successfulReuseCount: 0, failedReuseCount: 0, category: 'content', relevanceReason: 'x' }],
    }));
    const evidence = await gatherer.gatherCorrelatedEvidence('technical_issue', 1);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].source, 'agent-memory');
  });
});

describe('SITUATION_TYPES', () => {
  test('includes the four planned situation types', () => {
    assert.deepEqual(SITUATION_TYPES, ['keyword_opportunity', 'traffic_decline', 'technical_issue', 'generic']);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
const { createEvidenceGatherer, SITUATION_TYPES } = await import(resolve('./decision-evidence.js'));

function neutralDeps(overrides = {}) {
  return {
    listOpenRecommendationsFn: async () => [],
    findRelevantMemoryFn: async () => [],
    fetchInvestigationEvidenceFn: async () => [],
    listFindingsFn: async () => [],
    listDecisionsForSiteFn: async () => [],
    ...overrides,
  };
}

describe('gatherCorrelatedEvidence — source selection', () => {
  test('queries all five sources for a keyword_opportunity situation', async () => {
    const calls = { recs: 0, memory: 0, investigations: 0, siteUnderstanding: 0, pastDecisions: 0 };
    const gatherer = createEvidenceGatherer(neutralDeps({
      listOpenRecommendationsFn: async () => { calls.recs++; return []; },
      findRelevantMemoryFn: async () => { calls.memory++; return []; },
      fetchInvestigationEvidenceFn: async () => { calls.investigations++; return []; },
      listFindingsFn: async () => { calls.siteUnderstanding++; return []; },
      listDecisionsForSiteFn: async () => { calls.pastDecisions++; return []; },
    }));

    await gatherer.gatherCorrelatedEvidence('keyword_opportunity', 1);
    assert.deepEqual(calls, { recs: 1, memory: 1, investigations: 1, siteUnderstanding: 1, pastDecisions: 1 });
  });

  test('technical_issue still queries pastDecisions even without siteUnderstanding', async () => {
    const calls = { siteUnderstanding: 0, pastDecisions: 0 };
    const gatherer = createEvidenceGatherer(neutralDeps({
      listFindingsFn: async () => { calls.siteUnderstanding++; return []; },
      listDecisionsForSiteFn: async () => { calls.pastDecisions++; return []; },
    }));
    await gatherer.gatherCorrelatedEvidence('technical_issue', 1);
    assert.deepEqual(calls, { siteUnderstanding: 0, pastDecisions: 1 });
  });

  test('technical_issue does not query siteUnderstanding', async () => {
    let calls = 0;
    const gatherer = createEvidenceGatherer(neutralDeps({
      listFindingsFn: async () => { calls++; return []; },
    }));
    await gatherer.gatherCorrelatedEvidence('technical_issue', 1);
    assert.equal(calls, 0);
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

  test('maps site-understanding findings into Evidence shape, excluding unconfirmed ones', async () => {
    const gatherer = createEvidenceGatherer(neutralDeps({
      listFindingsFn: async () => [
        { id: 1, category: 'templates', subject: 'comparison-page', finding: { exists: false }, confidence: 0.9, risk: 'low', status: 'confirmed' },
        { id: 2, category: 'templates', subject: 'blog-post', finding: { exists: true }, confidence: 0.4, risk: 'medium', status: 'needs_confirmation' },
      ],
    }));
    const evidence = await gatherer.gatherCorrelatedEvidence('keyword_opportunity', 1);
    const siteEvidence = evidence.filter((e) => e.source === 'site-understanding');
    assert.equal(siteEvidence.length, 1);
    assert.equal(siteEvidence[0].ref, 'site_understanding:1');
    assert.match(siteEvidence[0].summary, /comparison-page/);
  });

  test('maps past decisions into Evidence shape, excluding ones with no known outcome yet', async () => {
    const gatherer = createEvidenceGatherer(neutralDeps({
      listDecisionsForSiteFn: async () => [
        { id: 1, situation: 'gap X', action: 'improve_page', status: 'verified', rationale: 'existing page fit', confidence: 0.8, outcome_ref: 'fix-impact:1' },
        { id: 2, situation: 'gap Y', action: 'new_page', status: 'decided', rationale: 'no page found', confidence: 0.6, outcome_ref: null },
      ],
    }));
    const evidence = await gatherer.gatherCorrelatedEvidence('generic', 1);
    const decisionEvidence = evidence.filter((e) => e.source === 'past-decision');
    assert.equal(decisionEvidence.length, 1);
    assert.equal(decisionEvidence[0].ref, 'decision:1');
    assert.match(decisionEvidence[0].summary, /improve_page/);
  });
});

describe('SITUATION_TYPES', () => {
  test('includes the four planned situation types', () => {
    assert.deepEqual(SITUATION_TYPES, ['keyword_opportunity', 'traffic_decline', 'technical_issue', 'generic']);
  });
});

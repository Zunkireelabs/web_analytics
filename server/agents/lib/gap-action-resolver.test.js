import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
const { createGapActionResolver, AMBIGUOUS_KINDS } = await import(resolve('./gap-action-resolver.js'));

const gap = { id: 1, topic: 'best crm software', search_intent: 'commercial', product_relevance: 'direct' };

function stubResolver({ eligibility, decisionEngineFn, gatherEvidenceFn }) {
  let decisionCalls = 0;
  let evidenceCalls = 0;
  const resolver = createGapActionResolver({
    gapDraftEligibilityFn: () => eligibility,
    decisionEngineFn: decisionEngineFn || { decide: async () => { decisionCalls++; return { action: 'do_nothing' }; } },
    gatherEvidenceFn: gatherEvidenceFn || (async () => { evidenceCalls++; return []; }),
  });
  return { resolver, getCalls: () => ({ decisionCalls, evidenceCalls }) };
}

describe('resolveGapAction — deterministic (confidently resolved) cases pass through untouched', () => {
  test('null eligibility (do-nothing) never calls decision-engine', async () => {
    let decisionCalls = 0;
    const resolver = createGapActionResolver({
      gapDraftEligibilityFn: () => null,
      decisionEngineFn: { decide: async () => { decisionCalls++; return {}; } },
      gatherEvidenceFn: async () => [],
    });
    const result = await resolver.resolveGapAction(gap, 1);
    assert.equal(result.source, 'deterministic');
    assert.equal(result.ambiguityKind, null);
    assert.equal(result.decision, null);
    assert.equal(decisionCalls, 0);
  });

  test('blog-outline eligibility never calls decision-engine', async () => {
    let decisionCalls = 0;
    const resolver = createGapActionResolver({
      gapDraftEligibilityFn: () => ({ eligible: true, generatorId: 'blog-outline', findingId: 'keyword-gap:1' }),
      decisionEngineFn: { decide: async () => { decisionCalls++; return {}; } },
      gatherEvidenceFn: async () => [],
    });
    const result = await resolver.resolveGapAction(gap, 1);
    assert.equal(result.source, 'deterministic');
    assert.equal(decisionCalls, 0);
  });

  test('faq eligibility (existing-page match) never calls decision-engine', async () => {
    let decisionCalls = 0;
    const resolver = createGapActionResolver({
      gapDraftEligibilityFn: () => ({ eligible: true, generatorId: 'faq', findingId: 'keyword-gap:1', existingPage: '/faq' }),
      decisionEngineFn: { decide: async () => { decisionCalls++; return {}; } },
      gatherEvidenceFn: async () => [],
    });
    const result = await resolver.resolveGapAction(gap, 1);
    assert.equal(result.source, 'deterministic');
    assert.equal(decisionCalls, 0);
  });
});

describe('resolveGapAction — ambiguous cases engage decision-engine', () => {
  test('requiresFutureInfrastructure gathers evidence and calls decision-engine', async () => {
    const { resolver, getCalls } = stubResolver({
      eligibility: { eligible: true, requiresFutureInfrastructure: true, findingId: 'keyword-gap:1', note: 'no comparison generator' },
    });
    const result = await resolver.resolveGapAction(gap, 1);
    assert.equal(result.source, 'decision-engine');
    assert.equal(result.ambiguityKind, 'requires-future-infrastructure');
    assert.deepEqual(result.decision, { action: 'do_nothing' });
    assert.deepEqual(getCalls(), { decisionCalls: 1, evidenceCalls: 1 });
  });

  test('landing-page (MANUAL tier) gathers evidence and calls decision-engine', async () => {
    const { resolver, getCalls } = stubResolver({
      eligibility: { eligible: true, generatorId: 'landing-page', findingId: 'keyword-gap:1' },
    });
    const result = await resolver.resolveGapAction(gap, 1);
    assert.equal(result.source, 'decision-engine');
    assert.equal(result.ambiguityKind, 'manual-landing-page');
    assert.deepEqual(getCalls(), { decisionCalls: 1, evidenceCalls: 1 });
  });

  test('passes gathered evidence straight through to decision-engine unmodified', async () => {
    const fakeEvidence = [{ source: 'test', summary: 'x', ref: '1' }];
    let receivedEvidence = null;
    const resolver = createGapActionResolver({
      gapDraftEligibilityFn: () => ({ eligible: true, generatorId: 'landing-page' }),
      decisionEngineFn: { decide: async (siteId, situation, evidence) => { receivedEvidence = evidence; return { action: 'improve_page' }; } },
      gatherEvidenceFn: async () => fakeEvidence,
    });
    await resolver.resolveGapAction(gap, 42);
    assert.equal(receivedEvidence, fakeEvidence);
  });
});

describe('AMBIGUOUS_KINDS', () => {
  test('names both ambiguity shapes gapDraftEligibility can produce', () => {
    assert.deepEqual(AMBIGUOUS_KINDS, ['requires-future-infrastructure', 'manual-landing-page']);
  });
});

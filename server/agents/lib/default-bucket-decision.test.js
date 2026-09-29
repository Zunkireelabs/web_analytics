import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDefaultBucketClassification, buildDefaultBucketSituation, applyDefaultBucketDecisions,
} from './default-bucket-decision.js';
import { DEFAULT_CLASSIFICATION, classify } from './recommendation-taxonomy.js';

describe('isDefaultBucketClassification', () => {
  test('true for a finding that falls all the way through to the catch-all', () => {
    const classification = classify({ source: 'some-agent', generatorId: 'genuinely-unknown-generator' });
    assert.ok(isDefaultBucketClassification(classification));
  });

  test('false for a finding the taxonomy explicitly maps', () => {
    const classification = classify({ source: 'content-gap', generatorId: 'meta-title' });
    assert.equal(isDefaultBucketClassification(classification), false);
  });
});

function candidate(item, overrides = {}) {
  const { situation, evidence } = buildDefaultBucketSituation({
    agentId: 'some-agent', generatorId: 'genuinely-unknown-generator',
    whyItMatters: 'A novel finding shape.', label: 'Do something', ...overrides,
  });
  return { item, situation, evidence };
}

// A no-op stub for every test below that isn't specifically exercising the
// correlated-evidence integration — keeps these tests hermetic (no real DB
// call attempted via the default evidenceGatherer) and focused on the
// behavior they actually assert, same discipline every other injectable-dep
// test in this file already uses for decisionEngineFn.
const noEvidence = async () => [];

describe('applyDefaultBucketDecisions — critical behavioral tests', () => {
  // 1. do_nothing suppresses the finding from the final output set.
  test('do_nothing removes the item from the returned array', async () => {
    const item = { id: 'f1', generatorId: 'x' };
    const items = [item];
    const decisionEngineFn = async () => ({ id: 42, action: 'do_nothing' });

    const result = await applyDefaultBucketDecisions(1, items, [candidate(item)], {
      site: { decision_engine_default_bucket_enabled: true }, decisionEngineFn, gatherEvidenceFn: noEvidence,
    });

    assert.deepEqual(result, []);
  });

  // 2. Two different valid outputs for the same finding shape produce
  // measurably different resulting states.
  test('investigate_further and a normal action produce measurably different item states', async () => {
    const itemA = { id: 'a', generatorId: 'x' };
    const itemB = { id: 'b', generatorId: 'x' };

    const resultA = await applyDefaultBucketDecisions(1, [itemA], [candidate(itemA)], {
      site: { decision_engine_default_bucket_enabled: true },
      decisionEngineFn: async () => ({ id: 1, action: 'investigate_further' }), gatherEvidenceFn: noEvidence,
    });
    const resultB = await applyDefaultBucketDecisions(1, [itemB], [candidate(itemB)], {
      site: { decision_engine_default_bucket_enabled: true },
      decisionEngineFn: async () => ({ id: 2, action: 'improve_page' }), gatherEvidenceFn: noEvidence,
    });

    assert.equal(resultA[0].decisionState, 'investigating');
    assert.equal(resultA[0].decisionId, 1);
    assert.equal(resultB[0].decisionState, undefined, 'a non-investigate_further action never gets the investigating badge');
    assert.equal(resultB[0].decisionId, 2);
  });

  // 3. Existing safety-relevant fields are never touched, regardless of output.
  test('blockedReason/riskTier/bucket/category-shaped fields are never touched by any decision output', async () => {
    const item = { id: 'f1', generatorId: 'x', blockedReason: 'needs a human', riskTier: 'manual', bucket: 'seo', category: 'Technical Fixes' };
    const before = { ...item };

    await applyDefaultBucketDecisions(1, [item], [candidate(item)], {
      site: { decision_engine_default_bucket_enabled: true },
      decisionEngineFn: async () => ({ id: 9, action: 'fix_technical' }), gatherEvidenceFn: noEvidence,
    });

    assert.equal(item.blockedReason, before.blockedReason);
    assert.equal(item.riskTier, before.riskTier);
    assert.equal(item.bucket, before.bucket);
    assert.equal(item.category, before.category);
  });

  // 4. Feature flag OFF behaves exactly as before — decide() never called,
  // items array returned unchanged (same reference).
  test('flag OFF: decide() is never invoked and items are returned unchanged', async () => {
    const item = { id: 'f1', generatorId: 'x' };
    const items = [item];
    let calls = 0;

    const result = await applyDefaultBucketDecisions(1, items, [candidate(item)], {
      site: { decision_engine_default_bucket_enabled: false },
      decisionEngineFn: async () => { calls++; return { id: 1, action: 'do_nothing' }; },
    });

    assert.equal(calls, 0);
    assert.equal(result, items, 'same array reference — zero work done');
    assert.equal(item.decisionId, undefined);
  });

  test('no site at all (undefined) behaves the same as flag OFF', async () => {
    const item = { id: 'f1', generatorId: 'x' };
    const items = [item];
    const result = await applyDefaultBucketDecisions(1, items, [candidate(item)], {
      decisionEngineFn: async () => ({ id: 1, action: 'do_nothing' }),
    });
    assert.equal(result, items);
  });

  // 5. decide() failure/timeout falls back safely — item unchanged, no throw,
  // rest of the run unaffected.
  test('a thrown/rejected decide() call leaves the item unchanged and does not throw', async () => {
    const item = { id: 'f1', generatorId: 'x' };
    const items = [item];

    const result = await applyDefaultBucketDecisions(1, items, [candidate(item)], {
      site: { decision_engine_default_bucket_enabled: true },
      decisionEngineFn: async () => { throw new Error('LLM timeout'); }, gatherEvidenceFn: noEvidence,
    });

    assert.equal(result, items);
    assert.equal(item.decisionId, undefined);
  });

  test('a decide() failure for one candidate does not stop the rest of the batch', async () => {
    const itemA = { id: 'a', generatorId: 'x' };
    const itemB = { id: 'b', generatorId: 'x' };
    let calls = 0;
    const decisionEngineFn = async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return { id: 7, action: 'improve_page' };
    };

    const result = await applyDefaultBucketDecisions(1, [itemA, itemB], [candidate(itemA), candidate(itemB)], {
      site: { decision_engine_default_bucket_enabled: true }, decisionEngineFn, gatherEvidenceFn: noEvidence,
    });

    assert.equal(calls, 2);
    assert.equal(itemA.decisionId, undefined, 'the failed candidate stays untouched');
    assert.equal(itemB.decisionId, 7, 'the batch continues past one failure');
    assert.equal(result.length, 2);
  });

  // 6. Multiple DEFAULT findings do not create uncontrolled/unbounded calls.
  test('respects maxCalls — findings beyond the cap never invoke decide() at all', async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ id: `f${i}`, generatorId: 'x' }));
    const candidates = items.map((it) => candidate(it));
    let calls = 0;

    await applyDefaultBucketDecisions(1, items, candidates, {
      site: { decision_engine_default_bucket_enabled: true },
      decisionEngineFn: async () => { calls++; return { id: calls, action: 'improve_page' }; },
      maxCalls: 3, gatherEvidenceFn: noEvidence,
    });

    assert.equal(calls, 3);
    assert.equal(items[0].decisionId, 1);
    assert.equal(items[1].decisionId, 2);
    assert.equal(items[2].decisionId, 3);
    assert.equal(items[3].decisionId, undefined, 'beyond the cap — untouched, exactly today\'s DEFAULT behavior');
    assert.equal(items[7].decisionId, undefined);
  });

  test('the default cap is a small, bounded constant, not unlimited', async () => {
    const { MAX_DECISION_ENGINE_CALLS_PER_RUN } = await import('./default-bucket-decision.js');
    assert.ok(MAX_DECISION_ENGINE_CALLS_PER_RUN > 0);
    assert.ok(MAX_DECISION_ENGINE_CALLS_PER_RUN <= 20, 'a real per-run cap, not effectively unbounded');
  });

  test('no candidates at all is a no-op, flag on or off', async () => {
    const items = [{ id: 'f1', generatorId: 'x' }];
    const result = await applyDefaultBucketDecisions(1, items, [], {
      site: { decision_engine_default_bucket_enabled: true },
      decisionEngineFn: async () => { throw new Error('must never be called'); },
    });
    assert.equal(result, items);
  });

  test('a do_nothing decision id is never attached to the suppressed item (nothing leaks through before removal)', async () => {
    const item = { id: 'f1', generatorId: 'x' };
    await applyDefaultBucketDecisions(1, [item], [candidate(item)], {
      site: { decision_engine_default_bucket_enabled: true },
      decisionEngineFn: async () => ({ id: 5, action: 'do_nothing' }), gatherEvidenceFn: noEvidence,
    });
    assert.equal(item.decisionId, undefined);
  });
});

// 2026-09-29 cross-domain reasoning seam: default-bucket-decision.js now
// widens a DEFAULT-bucket finding's evidence with decision-evidence.js's
// existing gatherCorrelatedEvidence (the same function gap-action-resolver.js
// already uses for capability-gap keyword decisions) before calling decide().
// No new evidence system — this proves the REUSE, not a new implementation.
describe('applyDefaultBucketDecisions — correlated evidence widening', () => {
  // 1. Flag OFF: the early return fires before the loop, so the evidence
  // gatherer must never even be called — identical to "existing behavior
  // unchanged" for every other codepath in this module.
  test('flag OFF: gatherEvidenceFn is never invoked', async () => {
    const item = { id: 'f1', generatorId: 'x' };
    const items = [item];
    let gathered = 0;
    const result = await applyDefaultBucketDecisions(1, items, [candidate(item)], {
      site: { decision_engine_default_bucket_enabled: false },
      gatherEvidenceFn: async () => { gathered++; return []; },
      decisionEngineFn: async () => { throw new Error('must not be reached either'); },
    });
    assert.equal(gathered, 0);
    assert.equal(result, items, 'same array reference — zero work done');
  });

  // 2. Flag ON: a DEFAULT finding's decide() call receives evidence beyond
  // just the triggering finding's own two hand-built items.
  test('flag ON: decide() receives the correlated evidence merged onto the base evidence', async () => {
    const item = { id: 'f1', generatorId: 'x' };
    let receivedEvidence;
    const correlated = [{ source: 'recommendation', summary: 'A related open item.', ref: 'recommendation:1' }];

    await applyDefaultBucketDecisions(1, [item], [candidate(item)], {
      site: { decision_engine_default_bucket_enabled: true },
      gatherEvidenceFn: async () => correlated,
      decisionEngineFn: async (siteId, situation, evidence) => { receivedEvidence = evidence; return { id: 1, action: 'investigate_further' }; },
    });

    assert.equal(receivedEvidence.length, 3, 'the original 2 base items plus 1 correlated item');
    assert.ok(receivedEvidence.some((e) => e.source === 'some-agent'), 'the triggering finding\'s own evidence is preserved, not replaced');
    assert.ok(receivedEvidence.some((e) => e.ref === 'recommendation:1'), 'the correlated evidence is actually included');
  });

  // 2b. Called with the honest 'generic' situationType and siteId, matching
  // the same call shape gap-action-resolver.js already uses (reuse, not a
  // new call convention).
  test('gatherEvidenceFn is called with the generic situationType, the real siteId, and the finding\'s situation as symptoms', async () => {
    const item = { id: 'f1', generatorId: 'x' };
    let args;
    await applyDefaultBucketDecisions(42, [item], [candidate(item)], {
      site: { decision_engine_default_bucket_enabled: true },
      gatherEvidenceFn: async (...a) => { args = a; return []; },
      decisionEngineFn: async () => ({ id: 1, action: 'investigate_further' }),
    });
    assert.equal(args[0], 'generic');
    assert.equal(args[1], 42);
    assert.match(args[2].symptoms, /some-agent/);
  });

  // 3. Correlated evidence can genuinely span multiple domains at once
  // (SEO/design/Analyst/history) — decide() sees all of it in one call,
  // proving this is real cross-domain fusion, not a single-source lookup.
  test('correlated evidence can include SEO, design, Analyst, and history sources together', async () => {
    const item = { id: 'f1', generatorId: 'x' };
    let receivedEvidence;
    const crossDomainEvidence = [
      { source: 'recommendation', summary: 'meta-title on /pricing: title too short', ref: 'recommendation:10', meta: { recommendationType: 'meta-title' } },
      { source: 'recommendation', summary: 'typography-drift on /pricing: heading size drifted', ref: 'recommendation:11', meta: { recommendationType: 'typography-drift' } },
      { source: 'investigations', summary: 'Analyst root-cause: device=mobile, 62% share of decline', ref: 'investigation:5' },
      { source: 'past-decision', summary: 'Past decision — similar gap: chose "improve_page" (verified).', ref: 'decision:3' },
    ];

    await applyDefaultBucketDecisions(1, [item], [candidate(item)], {
      site: { decision_engine_default_bucket_enabled: true },
      gatherEvidenceFn: async () => crossDomainEvidence,
      decisionEngineFn: async (siteId, situation, evidence) => { receivedEvidence = evidence; return { id: 1, action: 'investigate_further' }; },
    });

    const sources = receivedEvidence.map((e) => e.meta?.recommendationType || e.source);
    assert.ok(sources.includes('meta-title'), 'SEO evidence present');
    assert.ok(sources.includes('typography-drift'), 'design evidence present');
    assert.ok(receivedEvidence.some((e) => e.summary.includes('Analyst root-cause')), 'Analyst evidence present');
    assert.ok(receivedEvidence.some((e) => e.source === 'past-decision'), 'history evidence present');
  });

  // 4. A gatherEvidenceFn failure must never block the decision, and safety/
  // risk-relevant fields stay untouched regardless of how much correlated
  // evidence decide() saw — cross-domain reasoning informs the decision, it
  // never overrides deterministic safety fields.
  test('a gatherEvidenceFn failure falls back to base evidence only — decide() still runs, nothing throws', async () => {
    const item = { id: 'f1', generatorId: 'x' };
    let receivedEvidence;
    const result = await applyDefaultBucketDecisions(1, [item], [candidate(item)], {
      site: { decision_engine_default_bucket_enabled: true },
      gatherEvidenceFn: async () => { throw new Error('evidence source down'); },
      decisionEngineFn: async (siteId, situation, evidence) => { receivedEvidence = evidence; return { id: 1, action: 'improve_page' }; },
    });
    assert.equal(receivedEvidence.length, 2, 'falls back to exactly the base evidence, no throw, no missing decision');
    assert.equal(result[0].decisionId, 1);
  });

  test('safety/risk fields remain authoritative even with rich correlated evidence present', async () => {
    const item = { id: 'f1', generatorId: 'x', blockedReason: 'needs a human', riskTier: 'manual' };
    const before = { ...item };
    const crossDomainEvidence = [
      { source: 'recommendation', summary: 'a related SEO fix', ref: 'recommendation:1' },
      { source: 'investigations', summary: 'Analyst evidence suggesting urgency', ref: 'investigation:1' },
    ];

    await applyDefaultBucketDecisions(1, [item], [candidate(item)], {
      site: { decision_engine_default_bucket_enabled: true },
      gatherEvidenceFn: async () => crossDomainEvidence,
      decisionEngineFn: async () => ({ id: 1, action: 'fix_technical' }),
    });

    assert.equal(item.blockedReason, before.blockedReason, 'blockedReason (a human-approval boundary) is never overridden by cross-domain evidence');
    assert.equal(item.riskTier, before.riskTier, 'riskTier ceiling is never overridden by cross-domain evidence');
  });
});

describe('buildDefaultBucketSituation', () => {
  test('grounds situation/evidence in real finding data, never fabricating', () => {
    const { situation, evidence } = buildDefaultBucketSituation({
      agentId: 'mystery-agent', generatorId: 'novel-generator', whyItMatters: 'Something odd was found.', label: 'Odd thing',
    });
    assert.match(situation, /mystery-agent/);
    assert.match(situation, /novel-generator/);
    assert.match(situation, /Something odd was found\./);
    assert.equal(evidence.length, 2);
    assert.equal(evidence[0].source, 'mystery-agent');
    assert.equal(evidence[1].source, 'recommendation-taxonomy');
  });
});

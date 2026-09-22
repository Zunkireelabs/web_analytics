import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
const { createDecisionEngine, DECISION_ACTIONS, MIN_EVIDENCE_TO_DECIDE } = await import(resolve('./decision-engine.js'));

describe('decision-engine — evidence-sufficiency gate', () => {
  test('defers to investigate_further with zero evidence, never calling the LLM', async () => {
    let llmCalls = 0;
    const inserted = [];
    const engine = createDecisionEngine({
      callLLMForJsonFn: async () => { llmCalls++; throw new Error('should never be called'); },
      insertDecisionFn: async (siteId, decision) => { inserted.push({ siteId, ...decision }); return { id: 1, ...decision }; },
    });

    const result = await engine.decide(1, 'Traffic dropped on /pricing', []);

    assert.equal(llmCalls, 0);
    assert.equal(result.action, 'investigate_further');
    assert.equal(result.confidence, 0);
    assert.equal(inserted.length, 1);
  });
});

describe('decision-engine — decide()', () => {
  test('persists a valid LLM decision as-is', async () => {
    const evidence = [{ source: 'growth-queries', summary: 'keyword X has demand', ref: 'kw-1' }];
    let persisted = null;
    const engine = createDecisionEngine({
      callLLMForJsonFn: async (system, user, { validate }) => {
        const parsed = {
          situation: 'Keyword X has real demand and no covering page',
          rootCause: null,
          missingEvidence: [],
          action: 'new_page',
          actionTarget: { generatorId: 'blog-outline', pageUrl: null },
          rationale: 'No existing page covers this topic and demand is real.',
          alternativesConsidered: [{ action: 'improve_page', whyRejected: 'No relevant existing page found in inventory.' }],
          confidence: 0.8,
          validationPlan: 'Check GSC position for the target keyword after 28 days.',
        };
        assert.equal(validate(parsed), true);
        return parsed;
      },
      insertDecisionFn: async (siteId, decision) => { persisted = { siteId, ...decision }; return { id: 42, ...decision }; },
    });

    const result = await engine.decide(7, 'Keyword X gap', evidence);

    assert.equal(result.id, 42);
    assert.equal(persisted.siteId, 7);
    assert.equal(persisted.action, 'new_page');
    assert.equal(persisted.evidence, evidence);
  });

  test('rejects an LLM response with an invalid action via the validate callback', async () => {
    const engine = createDecisionEngine({
      callLLMForJsonFn: async (system, user, { validate }) => {
        assert.equal(validate({ action: 'delete_everything', rationale: 'x', missingEvidence: [], alternativesConsidered: [], confidence: 0.5 }), false);
        assert.equal(validate({ action: 'do_nothing', rationale: 'x', missingEvidence: [], alternativesConsidered: [], confidence: 0.5 }), true);
        return { action: 'do_nothing', rationale: 'Evidence shows no real opportunity.', missingEvidence: [], alternativesConsidered: [], confidence: 0.6 };
      },
      insertDecisionFn: async (siteId, decision) => ({ id: 1, ...decision }),
    });

    const result = await engine.decide(1, 'Low-value keyword', [{ source: 'x', summary: 'y', ref: 'z' }]);
    assert.equal(result.action, 'do_nothing');
  });
});

describe('decision-engine — exported constants', () => {
  test('DECISION_ACTIONS matches the plan\'s action space', () => {
    assert.deepEqual(DECISION_ACTIONS, [
      'improve_page', 'new_page', 'fix_technical', 'fix_metadata',
      'internal_linking', 'investigate_further', 'do_nothing',
    ]);
  });

  test('MIN_EVIDENCE_TO_DECIDE is a positive floor', () => {
    assert.ok(MIN_EVIDENCE_TO_DECIDE >= 1);
  });
});

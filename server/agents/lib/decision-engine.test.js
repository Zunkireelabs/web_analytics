import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
const { createDecisionEngine, DECISION_ACTIONS, MIN_EVIDENCE_TO_DECIDE, SELF_CRITIQUE_DOWNGRADE_CONFIDENCE } = await import(resolve('./decision-engine.js'));

const NO_CRITIQUE = { contradictingEvidence: [], alternativeExplanation: null, wouldBeWrongIf: 'The demand evidence turns out to be stale.', smallestSafeTest: null };

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
    assert.ok(result.selfCritique, 'even the no-evidence default path records a selfCritique, not just a bare action');
    assert.equal(result.selfCritique.contradictingEvidence.length, 0);
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
          selfCritique: NO_CRITIQUE,
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
    assert.equal(persisted.selfCritique, NO_CRITIQUE);
  });

  test('rejects an LLM response with an invalid action via the validate callback', async () => {
    const engine = createDecisionEngine({
      callLLMForJsonFn: async (system, user, { validate }) => {
        assert.equal(validate({ action: 'delete_everything', rationale: 'x', missingEvidence: [], alternativesConsidered: [], confidence: 0.5, selfCritique: NO_CRITIQUE }), false);
        assert.equal(validate({ action: 'do_nothing', rationale: 'x', missingEvidence: [], alternativesConsidered: [], confidence: 0.5, selfCritique: NO_CRITIQUE }), true);
        return { action: 'do_nothing', rationale: 'Evidence shows no real opportunity.', missingEvidence: [], alternativesConsidered: [], confidence: 0.6, selfCritique: NO_CRITIQUE };
      },
      insertDecisionFn: async (siteId, decision) => ({ id: 1, ...decision }),
    });

    const result = await engine.decide(1, 'Low-value keyword', [{ source: 'x', summary: 'y', ref: 'z' }]);
    assert.equal(result.action, 'do_nothing');
  });

  test('rejects a response missing selfCritique entirely via the validate callback', async () => {
    const engine = createDecisionEngine({
      callLLMForJsonFn: async (system, user, { validate }) => {
        assert.equal(validate({ action: 'do_nothing', rationale: 'x', missingEvidence: [], alternativesConsidered: [], confidence: 0.5 }), false);
        assert.equal(validate({ action: 'do_nothing', rationale: 'x', missingEvidence: [], alternativesConsidered: [], confidence: 0.5, selfCritique: { contradictingEvidence: [], wouldBeWrongIf: '' } }), false, 'an empty wouldBeWrongIf is not a real critique');
        return { action: 'do_nothing', rationale: 'x', missingEvidence: [], alternativesConsidered: [], confidence: 0.5, selfCritique: NO_CRITIQUE };
      },
      insertDecisionFn: async (siteId, decision) => ({ id: 1, ...decision }),
    });
    await engine.decide(1, 'x', [{ source: 'x', summary: 'y', ref: 'z' }]);
  });
});

describe('decision-engine — self-critique deterministic downgrade', () => {
  test('downgrades to investigate_further when contradicting evidence coincides with low confidence', async () => {
    let persisted = null;
    const engine = createDecisionEngine({
      callLLMForJsonFn: async () => ({
        action: 'new_page',
        rationale: 'Demand looks real.',
        missingEvidence: [],
        alternativesConsidered: [],
        confidence: SELF_CRITIQUE_DOWNGRADE_CONFIDENCE - 0.1,
        actionTarget: { generatorId: 'blog-outline', pageUrl: null },
        selfCritique: { contradictingEvidence: ['A near-duplicate page already ranks for this exact query.'], alternativeExplanation: 'The demand may already be served.', wouldBeWrongIf: 'The existing page already covers this.', smallestSafeTest: 'Check the existing page\'s content before creating a new one.' },
      }),
      insertDecisionFn: async (siteId, decision) => { persisted = decision; return { id: 9, ...decision }; },
    });

    const result = await engine.decide(1, 'Keyword gap', [{ source: 'x', summary: 'y', ref: 'z' }]);

    assert.equal(result.action, 'investigate_further');
    assert.equal(persisted.actionTarget, null);
    assert.match(persisted.rationale, /Self-critique found unresolved contradicting evidence/);
    assert.match(persisted.rationale, /new_page/, 'the original action is preserved in the rationale, not silently lost');
  });

  test('does NOT downgrade when confidence is high, even with contradicting evidence — a confident call already weighed it', async () => {
    let persisted = null;
    const engine = createDecisionEngine({
      callLLMForJsonFn: async () => ({
        action: 'new_page',
        rationale: 'Demand looks real despite the near-duplicate.',
        missingEvidence: [],
        alternativesConsidered: [],
        confidence: 0.85,
        selfCritique: { contradictingEvidence: ['A near-duplicate page exists but targets a different intent.'], alternativeExplanation: null, wouldBeWrongIf: 'The near-duplicate actually serves the same intent.', smallestSafeTest: null },
      }),
      insertDecisionFn: async (siteId, decision) => { persisted = decision; return { id: 10, ...decision }; },
    });

    const result = await engine.decide(1, 'Keyword gap', [{ source: 'x', summary: 'y', ref: 'z' }]);
    assert.equal(result.action, 'new_page');
    assert.equal(persisted.rationale, 'Demand looks real despite the near-duplicate.');
  });

  test('does not downgrade an already-cautious action (investigate_further/do_nothing) even at low confidence', async () => {
    const engine = createDecisionEngine({
      callLLMForJsonFn: async () => ({
        action: 'do_nothing',
        rationale: 'No worthwhile action found.',
        missingEvidence: [],
        alternativesConsidered: [],
        confidence: 0.1,
        selfCritique: { contradictingEvidence: ['Some signal suggests otherwise.'], alternativeExplanation: null, wouldBeWrongIf: 'x', smallestSafeTest: null },
      }),
      insertDecisionFn: async (siteId, decision) => ({ id: 11, ...decision }),
    });

    const result = await engine.decide(1, 'x', [{ source: 'x', summary: 'y', ref: 'z' }]);
    assert.equal(result.action, 'do_nothing');
  });

  test('no contradicting evidence at low confidence is left as-is — low confidence alone is not a downgrade trigger', async () => {
    const engine = createDecisionEngine({
      callLLMForJsonFn: async () => ({
        action: 'improve_page',
        rationale: 'Weak but real signal.',
        missingEvidence: [],
        alternativesConsidered: [],
        confidence: 0.2,
        selfCritique: NO_CRITIQUE,
      }),
      insertDecisionFn: async (siteId, decision) => ({ id: 12, ...decision }),
    });

    const result = await engine.decide(1, 'x', [{ source: 'x', summary: 'y', ref: 'z' }]);
    assert.equal(result.action, 'improve_page');
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

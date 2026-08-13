import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  producerStatus, classifyForSweep, listDeclaredProducers,
  NON_GENERATOR_PRODUCERS, RETIRED_PRODUCERS,
} from './lesson-producers.js';

// The obsolete-lesson sweep can permanently retire learned knowledge, so the
// tests that matter most are the ones proving what it must NOT touch.
//
// The rule these all enforce: a lesson is obsolete only when its producer is
// EXPLICITLY declared retired. Never because it is unrecognised, and never
// because it is absent from generators/registry.js.

const REGISTRY = ['faq', 'meta-title', 'alt-text', 'schema-repair', 'expand-content'];

describe('Design Agent lessons are first-class and cannot be swept', () => {
  const DESIGN = 'design-agent-component-templates';

  test('is declared active even though it is not a generator', () => {
    assert.equal(NON_GENERATOR_PRODUCERS[DESIGN].status, 'active');
    assert.equal(NON_GENERATOR_PRODUCERS[DESIGN].kind, 'design-agent');
  });

  test('is active even when the registry list does not contain it', () => {
    // This is the exact live condition: the Design Agent producer is not a
    // generator, so registry.js will never list it.
    assert.equal(producerStatus(DESIGN, REGISTRY), 'active');
  });

  test('is active even when the registry list is EMPTY', () => {
    // And this is the branch condition: recordRejectedTemplateLesson does not
    // exist on every branch, so a sweep run from a checkout without it would
    // derive an empty/partial producer list. It must still be preserved.
    assert.equal(producerStatus(DESIGN, []), 'active');
  });

  test('the sweep refuses to mark it obsolete', () => {
    const verdict = classifyForSweep({ id: 1, generator_id: DESIGN }, REGISTRY);
    assert.equal(verdict.obsolete, false);
    assert.equal(verdict.status, 'active');
  });

  test('REGRESSION: the old registry-absence rule would have deleted it', () => {
    // The precise bug this module exists to prevent, asserted directly so it
    // cannot quietly come back. Under the old rule this row was the ONE row a
    // live sweep would have retired.
    const oldRuleWouldRetire = !REGISTRY.includes(DESIGN);
    assert.equal(oldRuleWouldRetire, true, 'the old rule really did target this row');
    assert.equal(classifyForSweep({ generator_id: DESIGN }, REGISTRY).obsolete, false,
      'the new rule must preserve exactly the row the old rule destroyed');
  });
});

describe('unrecognised producers are preserved, not deleted', () => {
  test('an unknown producer is never obsolete', () => {
    const verdict = classifyForSweep({ generator_id: 'some-future-producer' }, REGISTRY);
    assert.equal(verdict.obsolete, false);
    assert.equal(verdict.status, 'unknown');
  });

  test('it says how to resolve the ambiguity instead of guessing', () => {
    const { reason } = classifyForSweep({ generator_id: 'some-future-producer' }, REGISTRY);
    assert.match(reason, /not recognised/i);
    assert.match(reason, /lesson-producers\.js/);
  });

  test('an empty registry makes everything unknown, and therefore everything safe', () => {
    // A caller that fails to load the registry must not be able to wipe the
    // table. Under the old rule, an empty list retired every row with a
    // generator_id.
    for (const id of REGISTRY) {
      assert.equal(classifyForSweep({ generator_id: id }, []).obsolete, false);
    }
  });
});

describe('generator_id NULL is a legitimate shape, never an orphan', () => {
  test('null producers are active', () => {
    // code/repo engineering lessons and cross-generator structural lessons —
    // 45 of the 58 live rows at the time of writing.
    assert.equal(producerStatus(null, REGISTRY), 'active');
    assert.equal(producerStatus(undefined, REGISTRY), 'active');
  });

  test('the sweep never marks them obsolete', () => {
    assert.equal(classifyForSweep({ generator_id: null }, []).obsolete, false);
  });
});

describe('registered generators stay active', () => {
  for (const id of REGISTRY) {
    test(`${id} is active`, () => {
      assert.equal(producerStatus(id, REGISTRY), 'active');
      assert.equal(classifyForSweep({ generator_id: id }, REGISTRY).obsolete, false);
    });
  }
});

describe('only an explicit retirement qualifies as obsolete', () => {
  test('nothing is retired today, so the sweep is currently a no-op', () => {
    // The honest current state: no producer in this codebase has been
    // retired, so a sweep run right now retires zero rows. That is the
    // correct outcome, not a missing feature.
    assert.deepEqual(Object.keys(RETIRED_PRODUCERS), []);
  });

  test('a producer declared retired IS swept', () => {
    // Proves the mechanism works rather than being permanently inert, without
    // retiring anything real: inject a declaration for this test only.
    RETIRED_PRODUCERS['gone-generator'] = { retiredAt: '2026-01-01', reason: 'Removed in a prior release.' };
    try {
      assert.equal(producerStatus('gone-generator', REGISTRY), 'retired');
      const verdict = classifyForSweep({ generator_id: 'gone-generator' }, REGISTRY);
      assert.equal(verdict.obsolete, true);
      assert.match(verdict.reason, /Removed in a prior release/);
    } finally {
      delete RETIRED_PRODUCERS['gone-generator'];
    }
  });

  test('retirement beats registry membership — an explicit decision wins', () => {
    RETIRED_PRODUCERS.faq = { retiredAt: '2026-01-01', reason: 'Superseded.' };
    try {
      assert.equal(producerStatus('faq', REGISTRY), 'retired');
    } finally {
      delete RETIRED_PRODUCERS.faq;
    }
  });
});

describe('listDeclaredProducers', () => {
  test('surfaces the Design Agent producer for operator review', () => {
    const ids = listDeclaredProducers().map((p) => p.id);
    assert.ok(ids.includes('design-agent-component-templates'));
  });
});

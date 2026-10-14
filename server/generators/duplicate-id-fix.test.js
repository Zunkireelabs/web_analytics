import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
let analyzeImpl;
mock.module(resolve('../agents/lib/page-content.js'), {
  namedExports: { analyzePageUrl: async (url) => analyzeImpl(url) },
});

const { generate, meta, verifyCurrentState } = await import('./duplicate-id-fix.js');

describe('duplicate-id-fix generator', () => {
  test('keeps the first occurrence, renames every later one with a numbered suffix', async () => {
    const { content } = await generate({
      params: {
        page: 'https://example.com/a',
        duplicateIds: [{ id: 'hero', count: 3, occurrences: [{ tag: 'div', snippet: '<div id="hero">' }, { tag: 'section', snippet: '<section id="hero">' }, { tag: 'span', snippet: '<span id="hero">' }] }],
      },
    });
    assert.equal(content.fixPlan[0].occurrences[0].keep, true);
    assert.equal(content.fixPlan[0].occurrences[0].suggestedId, 'hero');
    assert.equal(content.fixPlan[0].occurrences[1].keep, false);
    assert.equal(content.fixPlan[0].occurrences[1].suggestedId, 'hero-2');
    assert.equal(content.fixPlan[0].occurrences[2].suggestedId, 'hero-3');
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'duplicate-id-fix');
  });
});

describe('duplicate-id-fix verifyCurrentState (server/generators/lib/verification-layer.js contract)', () => {
  const rec = { params: { page: 'https://example.com/a', duplicateIds: [{ id: 'hero', count: 2 }] } };

  test('missing params: still_valid without calling anything', async () => {
    analyzeImpl = async () => { throw new Error('must not be called'); };
    const result = await verifyCurrentState({ params: {} }, {});
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'missing-params');
  });

  test('the named id is no longer duplicated on the live page: already_resolved', async () => {
    analyzeImpl = async () => ({ ok: true, analysis: { duplicateIds: [] } });
    const result = await verifyCurrentState(rec, {});
    assert.equal(result.decision, 'already_resolved');
  });

  test('the named id is still duplicated: still_valid', async () => {
    analyzeImpl = async () => ({ ok: true, analysis: { duplicateIds: [{ id: 'hero', count: 2 }] } });
    const result = await verifyCurrentState(rec, {});
    assert.equal(result.decision, 'still_valid');
    assert.deepEqual(result.evidence.remaining, ['hero']);
  });

  test('a DIFFERENT id is now duplicated instead of the named one: already_resolved — this recommendation named "hero" specifically', async () => {
    analyzeImpl = async () => ({ ok: true, analysis: { duplicateIds: [{ id: 'footer-link', count: 2 }] } });
    const result = await verifyCurrentState(rec, {});
    assert.equal(result.decision, 'already_resolved', 'the SPECIFIC id this recommendation named is resolved — a new unrelated duplicate is a different finding');
  });

  test('unreachable: still_valid, not a guess either way', async () => {
    analyzeImpl = async () => ({ ok: false, error: 'timeout' });
    const result = await verifyCurrentState(rec, {});
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'unreachable');
  });
});

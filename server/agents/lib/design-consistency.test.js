import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let existingRec;
let inserted;

const realRecommendations = await import(resolve('../../store/recommendations.js'));
mock.module(resolve('../../store/recommendations.js'), {
  namedExports: {
    ...realRecommendations,
    findOpenRecommendation: async () => existingRec,
    insertRecommendation: async (siteId, payload) => { inserted.push(payload); return { id: 999 }; },
  },
});

const { persistConsistencyFindings } = await import(resolve('./design-consistency.js'));

beforeEach(() => { existingRec = null; inserted = []; });

const finding = (overrides = {}) => ({
  id: 'typography-drift', pageUrl: 'https://example.com/legal/privacy',
  pageType: 'legal', sectionRole: 'content', sectionOrder: 0,
  evidence: { sectionClasses: 'x', siteConvention: 'y' },
  ...overrides,
});

describe('persistConsistencyFindings', () => {
  test('an empty finding list persists nothing', async () => {
    const result = await persistConsistencyFindings(1, []);
    assert.equal(result.created, 0);
    assert.equal(inserted.length, 0);
  });

  test('several findings on the SAME page collapse into ONE recommendation', async () => {
    const result = await persistConsistencyFindings(1, [
      finding({ id: 'typography-drift' }),
      finding({ id: 'missing-responsive-classes', sectionOrder: 1 }),
      finding({ id: 'table-style-drift', sectionOrder: 2 }),
    ]);
    assert.equal(result.created, 1);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].page, 'https://example.com/legal/privacy');
    assert.match(inserted[0].issue, /3 section\(s\)/);
  });

  test('findings on different pages become separate recommendations', async () => {
    const result = await persistConsistencyFindings(1, [
      finding({ pageUrl: 'https://example.com/a' }),
      finding({ pageUrl: 'https://example.com/b' }),
    ]);
    assert.equal(result.created, 2);
    assert.equal(inserted.length, 2);
  });

  test('a page that already has an open review recommendation is skipped, not duplicated', async () => {
    existingRec = { id: 5 };
    const result = await persistConsistencyFindings(1, [finding()]);
    assert.equal(result.created, 0);
    assert.equal(result.skipped, 1);
    assert.equal(inserted.length, 0);
  });

  test('is always risk-tier manual — no generator exists to auto-fix arbitrary drift', async () => {
    await persistConsistencyFindings(1, [finding()]);
    assert.equal(inserted[0].riskTier, 'manual');
    assert.equal(inserted[0].recommendationType, 'design-consistency-review');
  });

  test('3+ findings on one page escalate priority to high', async () => {
    await persistConsistencyFindings(1, [finding(), finding({ sectionOrder: 1 }), finding({ sectionOrder: 2 })]);
    assert.equal(inserted[0].priority, 'high');
  });

  test('1-2 findings on one page stay medium priority', async () => {
    await persistConsistencyFindings(1, [finding()]);
    assert.equal(inserted[0].priority, 'medium');
  });
});

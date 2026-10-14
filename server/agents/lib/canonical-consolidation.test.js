import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { allShareCanonical } from './canonical-consolidation.js';

const probes = (o) => new Map(Object.entries(o).map(([p, canonical]) => [p, { canonical }]));

describe('allShareCanonical', () => {
  test('true when every variant canonicalizes to the same URL', () => {
    const pages = ['https://x.com/apply/?p=a', 'https://x.com/apply/?p=b'];
    assert.equal(allShareCanonical(pages, probes({ [pages[0]]: 'https://x.com/apply/', [pages[1]]: 'https://x.com/apply/' })), true);
  });
  test('false when a variant has no canonical tag', () => {
    const pages = ['https://x.com/apply/?p=a', 'https://x.com/apply/?p=b'];
    assert.equal(allShareCanonical(pages, probes({ [pages[0]]: 'https://x.com/apply/', [pages[1]]: null })), false);
  });
  test('false when variants are each self-canonical (different canonicals)', () => {
    const pages = ['https://x.com/apply/?p=a', 'https://x.com/apply/?p=b'];
    assert.equal(allShareCanonical(pages, probes({ [pages[0]]: pages[0], [pages[1]]: pages[1] })), false);
  });
  test('false for a group of fewer than two pages', () => {
    assert.equal(allShareCanonical(['https://x.com/a/'], probes({ 'https://x.com/a/': 'https://x.com/a/' })), false);
  });
  test('uses the supplied normalizer', () => {
    const pages = ['https://x.com/a/?p=1', 'https://x.com/a/?p=2'];
    const norm = (u) => u.toLowerCase().replace(/\/$/, '');
    assert.equal(allShareCanonical(pages, probes({ [pages[0]]: 'https://X.com/a/', [pages[1]]: 'https://x.com/a' }), norm), true);
  });
});

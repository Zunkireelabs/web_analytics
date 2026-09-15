import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let site;
let inventory;

mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => site },
});
mock.module(resolve('../store/page-inventory.js'), {
  namedExports: { listPageInventory: async () => inventory },
});

const { run } = await import('./url-variant-duplicates.js');

beforeEach(() => {
  site = { id: 1 };
  inventory = [];
});

describe('url-variant-duplicates agent', () => {
  test('insufficient-data when the site has no inventory yet', async () => {
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'insufficient-data');
  });

  test('ok, no finding, when every page is already unique after normalization', async () => {
    inventory = [
      { page: 'https://example.com/', orphaned: false },
      { page: 'https://example.com/about/', orphaned: false },
      { page: 'https://example.com/blog/post-1/', orphaned: false },
    ];
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.findings, []);
  });

  test('flags a trailing-slash duplicate pair', async () => {
    inventory = [
      { page: 'https://example.com/about', orphaned: false },
      { page: 'https://example.com/about/', orphaned: false },
    ];
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings.length, 1);
    assert.deepEqual(result.facts.findings[0].evidence.variants, ['https://example.com/about', 'https://example.com/about/']);
  });

  test('flags a case-variant duplicate pair', async () => {
    inventory = [
      { page: 'https://example.com/Pricing/', orphaned: false },
      { page: 'https://example.com/pricing/', orphaned: false },
    ];
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings.length, 1);
  });

  test('flags a percent-encoding duplicate pair', async () => {
    inventory = [
      { page: 'https://example.com/caf%C3%A9/', orphaned: false },
      { page: 'https://example.com/café/', orphaned: false },
    ];
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings.length, 1);
  });

  test('orphaned rows are excluded from grouping', async () => {
    inventory = [
      { page: 'https://example.com/about', orphaned: true },
      { page: 'https://example.com/about/', orphaned: false },
    ];
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.findings, []);
  });

  test('recommendedAction is always null — which variant is canonical is a human decision', async () => {
    inventory = [
      { page: 'https://example.com/about', orphaned: false },
      { page: 'https://example.com/about/', orphaned: false },
    ];
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings[0].recommendedAction, null);
    assert.equal(result.facts.findings[0].reportOnly.kind, 'url-variant-duplicate');
  });
});

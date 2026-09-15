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

const { run } = await import('./query-param-duplicates.js');

beforeEach(() => {
  site = { id: 1 };
  inventory = [];
});

describe('query-param-duplicates agent', () => {
  test('insufficient-data with no inventory yet', async () => {
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'insufficient-data');
  });

  test('no finding when a page has only one query-string variant alongside its base', async () => {
    inventory = [
      { page: 'https://example.com/resources/', orphaned: false },
      { page: 'https://example.com/resources/?type=ebook', orphaned: false },
    ];
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.findings, []);
  });

  test('flags two or more distinct query-param variants of the same base path', async () => {
    inventory = [
      { page: 'https://example.com/resources/', orphaned: false },
      { page: 'https://example.com/resources/?type=ebook', orphaned: false },
      { page: 'https://example.com/resources/?type=case-study', orphaned: false },
    ];
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings.length, 1);
    assert.equal(result.facts.findings[0].evidence.variants.length, 3);
    assert.equal(result.facts.findings[0].recommendedAction, null);
    assert.equal(result.facts.findings[0].reportOnly.kind, 'query-param-duplicate');
  });

  test('two query-param variants with no base page found still flags (base-path key alone is enough)', async () => {
    inventory = [
      { page: 'https://example.com/resources/?type=ebook', orphaned: false },
      { page: 'https://example.com/resources/?type=case-study', orphaned: false },
    ];
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings.length, 1);
  });

  test('orphaned rows are excluded', async () => {
    inventory = [
      { page: 'https://example.com/resources/?type=ebook', orphaned: true },
      { page: 'https://example.com/resources/?type=case-study', orphaned: false },
    ];
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.findings, []);
  });
});

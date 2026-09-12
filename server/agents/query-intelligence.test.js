import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Regression coverage for a real fix on 2026-09-12: query-cannibalization
// findings used to be reportOnly (recommendedAction: null) forever — "which
// page should own this query" was treated as an unanswerable human
// question, even though the agent already computes exactly the GSC evidence
// (clicks/impressions/position) that answers it. pickCannibalizationWinner
// now makes that decision from that same real evidence, and each losing
// page gets a real, draftable internal-links recommendation reinforcing the
// decided winner — never touching the losing page's own content.
const resolve = (p) => new URL(p, import.meta.url).href;

let cannibalizedRaw;
let dropperMovers;

mock.module(resolve('../store/read.js'), {
  namedExports: {
    getGscBreakdownRange: async () => [],
    getTopMovers: async () => dropperMovers,
    getCannibalizedQueries: async () => cannibalizedRaw,
    getSiteById: async () => ({ id: 1, name: 'Example Co' }),
  },
});
mock.module(resolve('../llm.js'), {
  namedExports: { callLLM: async () => 'narrative' },
});

const { run } = await import('./query-intelligence.js');

beforeEach(() => {
  dropperMovers = { gainers: [], droppers: [] };
  cannibalizedRaw = [];
});

const runIt = () => run({ siteId: 1, start: '2026-08-01', end: '2026-08-28' });

describe('query-intelligence — cannibalization resolution', () => {
  test('the winner gets no finding; each losing page gets a real internal-links recommendation pointed at it', async () => {
    cannibalizedRaw = [{
      query: 'top ai companies in nepal',
      pages: [
        { page: 'https://example.com/blog/top-ai-companies-nepal-2026/', clicks: 12, impressions: 80, avg_position: 3.2 },
        { page: 'https://example.com/blog/other-article/', clicks: 0, impressions: 40, avg_position: 9.1 },
      ],
    }];
    const { facts } = await runIt();
    assert.equal(facts.findings.length, 1);
    const [finding] = facts.findings;
    assert.equal(finding.recommendedAction.generatorId, 'internal-links');
    assert.equal(finding.recommendedAction.params.page, 'https://example.com/blog/other-article/');
    assert.equal(finding.recommendedAction.params.mustLinkTo, 'https://example.com/blog/top-ai-companies-nepal-2026/');
    assert.equal(finding.evidence.winner, 'https://example.com/blog/top-ai-companies-nepal-2026/');
    assert.equal(finding.reportOnly, null);
  });

  test('a 3-way cannibalization produces one finding per losing page, none for the winner', async () => {
    cannibalizedRaw = [{
      query: 'ai company in nepal',
      pages: [
        { page: 'https://example.com/a', clicks: 20, impressions: 100, avg_position: 1.5 },
        { page: 'https://example.com/b', clicks: 3, impressions: 30, avg_position: 5 },
        { page: 'https://example.com/c', clicks: 1, impressions: 10, avg_position: 8 },
      ],
    }];
    const { facts } = await runIt();
    assert.equal(facts.findings.length, 2);
    const targeted = facts.findings.map((f) => f.recommendedAction.params.page).sort();
    assert.deepEqual(targeted, ['https://example.com/b', 'https://example.com/c']);
    for (const f of facts.findings) {
      assert.equal(f.recommendedAction.params.mustLinkTo, 'https://example.com/a');
    }
  });

  test('never invents a page not present in the real evidence', async () => {
    cannibalizedRaw = [{
      query: 'q',
      pages: [
        { page: 'https://example.com/x', clicks: 5, impressions: 50, avg_position: 2 },
        { page: 'https://example.com/y', clicks: 1, impressions: 5, avg_position: 9 },
      ],
    }];
    const { facts } = await runIt();
    const known = new Set(['https://example.com/x', 'https://example.com/y']);
    for (const f of facts.findings) {
      assert.ok(known.has(f.recommendedAction.params.page));
      assert.ok(known.has(f.recommendedAction.params.mustLinkTo));
    }
  });

  test('a branded query is filtered out before any decision is made', async () => {
    cannibalizedRaw = [{
      query: 'example co pricing',
      pages: [
        { page: 'https://example.com/a', clicks: 5, impressions: 20, avg_position: 1 },
        { page: 'https://example.com/b', clicks: 3, impressions: 15, avg_position: 2 },
      ],
    }];
    const { facts } = await runIt();
    assert.equal(facts.findings.length, 0);
  });

  test('no cannibalization at all produces no findings', async () => {
    const { facts } = await runIt();
    assert.equal(facts.findings.length, 0);
  });
});

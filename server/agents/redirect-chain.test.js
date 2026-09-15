import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let site;
let candidateBatch;
let impressionsByPage;
let redirectResultByPage; // page -> {hops, error, chain, finalStatus}
let markedChecked;

mock.module(resolve('../store/read.js'), {
  namedExports: {
    getSiteById: async () => site,
    getSearchPerformanceForPages: async () => [],
  },
});
mock.module(resolve('./lib/candidate-pages.js'), {
  namedExports: {
    selectCandidatePages: async () => ({ batch: candidateBatch, impressionsByPage }),
    markPagesChecked: async (siteId, agentId, batch) => { markedChecked = batch; },
  },
});
mock.module(resolve('./lib/technical-seo-analysis.js'), {
  namedExports: {
    followRedirectsWithRetry: async (page) => redirectResultByPage.get(page) || { hops: 0, error: null, chain: [{ url: page, status: 200 }], finalStatus: 200 },
  },
});

const { run } = await import('./redirect-chain.js');

beforeEach(() => {
  site = { id: 1, url_file_map: {} };
  candidateBatch = [];
  impressionsByPage = new Map();
  redirectResultByPage = new Map();
  markedChecked = null;
});

describe('redirect-chain agent', () => {
  test('insufficient-data when there is no candidate batch', async () => {
    const result = await run({ siteId: 1, start: '2026-01-01', end: '2026-01-07' });
    assert.equal(result.status, 'insufficient-data');
  });

  test('no finding for a page that resolves directly (0 hops) or a single normal redirect (1 hop)', async () => {
    candidateBatch = ['https://example.com/a/', 'https://example.com/b/'];
    redirectResultByPage.set('https://example.com/a/', { hops: 0, error: null, chain: [{ url: 'https://example.com/a/', status: 200 }], finalStatus: 200 });
    redirectResultByPage.set('https://example.com/b/', { hops: 1, error: null, chain: [{ url: 'https://example.com/b/', status: 301 }, { url: 'https://example.com/b2/', status: 200 }], finalStatus: 200 });
    const result = await run({ siteId: 1, start: '2026-01-01', end: '2026-01-07' });
    assert.deepEqual(result.facts.findings, []);
  });

  test('flags a page whose own URL takes 2+ hops to resolve, but stays reportOnly with no tracked nginx config', async () => {
    candidateBatch = ['https://example.com/old/'];
    impressionsByPage.set('https://example.com/old/', 50);
    redirectResultByPage.set('https://example.com/old/', {
      hops: 2, error: null, finalStatus: 200,
      chain: [
        { url: 'https://example.com/old/', status: 301 },
        { url: 'https://example.com/mid/', status: 301 },
        { url: 'https://example.com/new/', status: 200 },
      ],
    });
    const result = await run({ siteId: 1, start: '2026-01-01', end: '2026-01-07' });
    assert.equal(result.facts.findings.length, 1);
    assert.equal(result.facts.findings[0].reportOnly.kind, 'redirect-chain');
    assert.equal(result.facts.findings[0].recommendedAction, null);
    assert.equal(result.facts.findings[0].priority, 'medium');
  });

  test('3+ hops is priority high', async () => {
    candidateBatch = ['https://example.com/old/'];
    redirectResultByPage.set('https://example.com/old/', {
      hops: 3, error: null, finalStatus: 200,
      chain: [
        { url: 'https://example.com/old/', status: 301 },
        { url: 'https://example.com/mid1/', status: 301 },
        { url: 'https://example.com/mid2/', status: 301 },
        { url: 'https://example.com/new/', status: 200 },
      ],
    });
    const result = await run({ siteId: 1, start: '2026-01-01', end: '2026-01-07' });
    assert.equal(result.facts.findings[0].priority, 'high');
  });

  test('a page the check could not reach is never flagged as a chain', async () => {
    candidateBatch = ['https://example.com/broken/'];
    redirectResultByPage.set('https://example.com/broken/', { hops: 0, error: 'timeout', chain: [], finalStatus: null });
    const result = await run({ siteId: 1, start: '2026-01-01', end: '2026-01-07' });
    assert.deepEqual(result.facts.findings, []);
  });

  test('marks the checked batch, same rotation bookkeeping as other page-level agents', async () => {
    candidateBatch = ['https://example.com/a/'];
    await run({ siteId: 1, start: '2026-01-01', end: '2026-01-07' });
    assert.deepEqual(markedChecked, ['https://example.com/a/']);
  });

  describe('with a tracked nginx config', () => {
    beforeEach(() => {
      site = { id: 1, url_file_map: { siteRoot: { nginxConfig: 'nginx/static.conf' } } };
    });

    test('offers an auto-fix attempt via redirect-chain-nginx, with the observed hop/final target as params', async () => {
      candidateBatch = ['https://example.com/old/'];
      redirectResultByPage.set('https://example.com/old/', {
        hops: 2, error: null, finalStatus: 200,
        chain: [
          { url: 'https://example.com/old/', status: 301 },
          { url: 'https://example.com/mid/', status: 301 },
          { url: 'https://example.com/new/', status: 200 },
        ],
      });
      const result = await run({ siteId: 1, start: '2026-01-01', end: '2026-01-07' });
      const finding = result.facts.findings[0];
      assert.equal(finding.recommendedAction.generatorId, 'redirect-chain-nginx');
      assert.deepEqual(finding.recommendedAction.params, {
        page: 'https://example.com/old/', currentHopTarget: 'https://example.com/mid/', finalTarget: 'https://example.com/new/',
      });
      assert.equal(finding.reportOnly, null);
      assert.equal(result.facts.autoFixAttempted, 1);
    });
  });
});

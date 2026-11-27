import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
const counts = { '/a': 0, '/b': 10, '/c': 10, '/d': 10, '/e': 10, '/f': 10 };
mock.module(resolve('../store/read.js'), { namedExports: { getSearchPerformanceForPages: async (_s, _a, _b, pages) => pages.map((p) => ({ dim_value: p, impressions: 5 })) } });
mock.module(resolve('./lib/candidate-pages.js'), { namedExports: {
  selectCandidatePages: async () => ({ batch: ['/b', '/c', '/d', '/e', '/f'], impressionsByPage: new Map([['/b', 1]]) }),
  markPagesChecked: async () => { throw new Error('a re-check must not write to the rotation'); },
} });
mock.module(resolve('./lib/page-content.js'), { namedExports: {
  analyzePageUrl: async (p) => ({ ok: true, analysis: { internalLinkCount: counts[p] ?? 10 } }),
  effortForGenerator: () => 'low',
} });
mock.module(resolve('../llm.js'), { namedExports: { callLLM: async () => 'narrative' } });
const { run } = await import(resolve('./internal-linking.js'));

describe('internal-linking re-check with few pages', () => {
  test('one requested page still gets a trustworthy baseline from the site\'s other pages, and the verdict is only about the requested page', async () => {
    const out = await run({ siteId: 1, start: '2026-11-01', end: '2026-11-27', params: { pages: ['/a'] } });
    assert.equal(out.status, 'ok');
    assert.deepEqual(out.facts.checkedPages, ['/a']);
    assert.deepEqual(out.facts.findings.map((f) => f.evidence.page), ['/a']);
  });
  test('a requested page that already links well is not reported, and other pages are never reported for a re-check', async () => {
    const out = await run({ siteId: 1, start: '2026-11-01', end: '2026-11-27', params: { pages: ['/b'] } });
    assert.equal(out.status, 'ok');
    assert.deepEqual(out.facts.findings, []);
  });
});

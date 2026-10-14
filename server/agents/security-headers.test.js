import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
let candidatePages = [];
mock.module(resolve('../store/read.js'), {
  namedExports: {
    getSearchPerformanceForPages: async (siteId, start, end, pages) => pages.map((p) => ({ dim_value: p, impressions: 0 })),
    getSearchPerformanceRange: async () => [],
    getSiteById: async () => null,
  },
});
mock.module(resolve('../llm.js'), { namedExports: { callLLM: async () => 'stub' } });
mock.module(resolve('./lib/candidate-pages.js'), {
  namedExports: { selectCandidatePages: async () => ({ batch: candidatePages, impressionsByPage: new Map() }), markPagesChecked: async () => {} },
});
const headers = (obj) => new Headers(obj);
let headerResponses = {};
const realPageContent = await import(resolve('./lib/page-content.js'));
mock.module(resolve('./lib/page-content.js'), {
  namedExports: { ...realPageContent, fetchResponseHeaders: async (u) => ({ ok: true, headers: headers(headerResponses[u] || headerResponses.default) }) },
});

const { run, dedupePageVariants } = await import('./security-headers.js');

describe('dedupePageVariants', () => {
  test('collapses http/https, www and trailing-slash variants, preferring https', () => {
    const out = dedupePageVariants(['http://example.com/a', 'https://example.com/a/', 'https://www.example.com/a', 'https://example.com/b']);
    assert.deepEqual(out.sort(), ['https://example.com/a/', 'https://example.com/b'].sort());
  });
});

describe('security-headers run()', () => {
  const FULL = { 'strict-transport-security': 'x', 'content-security-policy': 'default-src self', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' };

  test('missing Referrer-Policy is low-priority informational and not in the combined fix', async () => {
    headerResponses = { default: FULL };
    const res = await run({ siteId: 1, start: 'a', end: 'b', params: { pages: ['https://example.com/'] } });
    const f = res.facts.findings.find((x) => x.id === 'security-headers:referrer-policy');
    assert.ok(f);
    assert.equal(f.priority, 'low');
    assert.equal(f.evidence.informational, true);
    assert.equal(res.facts.findings.some((x) => x.id === 'security-headers:site:missing-security-headers'), false);
  });

  test('http and https variants of one page count once', async () => {
    headerResponses = { default: {} };
    const res = await run({ siteId: 1, start: 'a', end: 'b', params: { pages: ['http://example.com/a', 'https://example.com/a'] } });
    const hsts = res.facts.findings.find((x) => x.id === 'security-headers:strict-transport-security');
    assert.equal(hsts.evidence.checkedCount, 1);
  });
});

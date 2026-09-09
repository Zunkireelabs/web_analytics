import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const resolve = (p) => new URL(p, import.meta.url).href;

let knownHashes; // what past runs already recorded for this site

mock.module(resolve('../store/read.js'), {
  namedExports: {
    getSearchPerformanceForPages: async (siteId, start, end, pages) =>
      pages.map((p) => ({ dim_value: p, impressions: 100 })),
  },
});
mock.module(resolve('../store/page-inventory.js'), {
  namedExports: {
    updatePageContentHashBatch: async () => {},
    listContentHashesForSite: async () => knownHashes,
  },
});
mock.module(resolve('./lib/candidate-pages.js'), {
  namedExports: { selectCandidatePages: async () => ({ batch: [], impressionsByPage: new Map() }), markPagesChecked: async () => {} },
});
mock.module(resolve('../llm.js'), {
  namedExports: { callLLM: async () => 'narrative' },
});

const { run } = await import('./duplicate-content.js');

const DUPLICATE_BODY = 'the same real body content served at more than one url';
const pageCache = async (page) => ({
  ok: true,
  analysis: { wordCount: 900, bodyText: page.includes('unique') ? `unique ${page}` : DUPLICATE_BODY },
});

const runOn = (pages) => run({ siteId: 1, start: '2026-08-01', end: '2026-08-28', pageCache, params: { pages } });

beforeEach(() => { knownHashes = []; });

describe('duplicate-content finding ids', () => {
  // The bug: the id was keyed on the alphabetically-first page in the group,
  // so discovering one more URL serving the same content re-issued the SAME
  // unresolved duplication under a brand-new id — a "new" finding, a broken
  // match against the already-open recommendation, and a lost history.
  test('the id is stable when another duplicate page joins the group', async () => {
    const first = await runOn(['https://example.com/b', 'https://example.com/c']);
    assert.equal(first.facts.findings.length, 1);
    const originalId = first.facts.findings[0].id;
    assert.equal(first.facts.findings[0].evidence.pages.length, 2);

    // A later run finds a third URL that sorts BEFORE the old anchor page.
    knownHashes = first.facts.findings[0].evidence.pages.map((page) => ({
      page, content_hash: first.facts.findings[0].evidence.contentHash,
    }));
    const second = await runOn(['https://example.com/a']);
    assert.equal(second.facts.findings.length, 1);
    assert.equal(second.facts.findings[0].evidence.pages.length, 3);
    assert.equal(second.facts.findings[0].id, originalId, 'the same unresolved duplication must keep its identity');
  });

  test('the id is stable when a page leaves the group too', async () => {
    knownHashes = [];
    const three = await runOn(['https://example.com/a', 'https://example.com/b', 'https://example.com/c']);
    const idOfThree = three.facts.findings[0].id;

    const two = await runOn(['https://example.com/b', 'https://example.com/c']);
    assert.equal(two.facts.findings[0].id, idOfThree);
  });

  test('genuinely different duplicate groups never collide on one id', async () => {
    const other = async (page) => ({
      ok: true,
      analysis: { wordCount: 900, bodyText: page.startsWith('https://example.com/x') ? 'group one body' : 'group two body' },
    });
    const result = await run({
      siteId: 1, start: '2026-08-01', end: '2026-08-28', pageCache: other,
      params: { pages: ['https://example.com/x1', 'https://example.com/x2', 'https://example.com/y1', 'https://example.com/y2'] },
    });
    assert.equal(result.facts.findings.length, 2);
    assert.equal(new Set(result.facts.findings.map((f) => f.id)).size, 2);
  });

  test('a page that is not a duplicate produces no finding at all', async () => {
    const result = await runOn(['https://example.com/unique-1', 'https://example.com/unique-2']);
    assert.equal(result.facts.findings.length, 0);
  });

  test('evidence pages are sorted, so the same group renders identically run to run', async () => {
    const result = await runOn(['https://example.com/c', 'https://example.com/a', 'https://example.com/b']);
    assert.deepEqual(result.facts.findings[0].evidence.pages, [
      'https://example.com/a', 'https://example.com/b', 'https://example.com/c',
    ]);
  });

  // Until 2026-09-09 this finding had a null recommendedAction and no
  // reportOnly, which is precisely the shape buildRecommendations discards —
  // so byte-identical duplicate pages were detected every run and surfaced to
  // nobody, despite duplicate-content being listed in RECOMMENDATION_AGENT_IDS.
  test('surfaces the group as a visible report-only row rather than being dropped', async () => {
    const result = await runOn(['https://example.com/c', 'https://example.com/a', 'https://example.com/b']);
    const ro = result.facts.findings[0].reportOnly;

    assert.equal(ro.kind, 'duplicate-content');
    // Points at a real member page, and at a stable one (sorted), so the row's
    // (page, kind) dedup key does not move between runs.
    assert.equal(ro.page, 'https://example.com/a');
    assert.match(ro.whyBlocked, /which single URL should own this content/);
  });

  test('still refuses to pick a canonical URL automatically', async () => {
    const result = await runOn(['https://example.com/a', 'https://example.com/b']);
    // Choosing the canonical decides which page keeps its ranking — evidence
    // here (impressions) does not establish editorial intent, so no generator
    // may be attached however tempting the canonical generator looks.
    assert.equal(result.facts.findings[0].recommendedAction, null);
  });
});

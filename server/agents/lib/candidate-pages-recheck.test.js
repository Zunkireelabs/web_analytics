import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// store/read.js and store/page-inventory.js are mocked at module scope,
// before candidate-pages.js (or anything importing it) ever loads —
// mock.module cannot retroactively intercept a module that already loaded
// via a static import. Every other collaborator selectCandidatePages reads
// (getCheckedAtForPages, filterSoftNotFound, markPagesCheckedFn,
// getOpenRecommendationPagesFn) is already injectable per-call, so only the
// two site/inventory reads need mocking here.
const SITE = { id: 1, website_domain: 'acme.example' };
const INVENTORY = [
  { page: 'https://acme.example/stale-1/' },
  { page: 'https://acme.example/stale-2/' },
  { page: 'https://acme.example/stale-3/' },
  { page: 'https://acme.example/never-checked/' },
];

mock.module(resolve('../../store/read.js'), {
  namedExports: {
    getSiteById: async () => SITE,
    getSearchPerformanceRange: async () => [],
    getSearchPerformanceForPages: async () => [],
  },
});
mock.module(resolve('../../store/page-inventory.js'), {
  namedExports: {
    listPageInventory: async () => INVENTORY,
  },
});

const { selectCandidatePages } = await import(resolve('./candidate-pages.js'));

// Real gap fixed 2026-09-29: a page with an OPEN recommendation for the
// requesting agent could go unrotated indefinitely on a large site (MAX_PAGES
// rotation only touches a handful of pages per run), so a finding a shared
// template fix had already resolved just stayed open forever — nothing ever
// re-checked that exact page again. selectCandidatePages now pulls pages
// with an open recommendation for this agent to the front of the batch,
// ahead of ordinary "never checked" rotation, capped at half the batch so it
// can't starve normal rotation/new-page discovery.
describe('selectCandidatePages — re-verifying stale open recommendations', () => {
  test('a page with an open recommendation for this agent is prioritized into the batch, not left to rotation luck', async () => {
    const { batch } = await selectCandidatePages(1, 'ai-visibility', {
      start: '2026-09-01',
      end: '2026-09-29',
      batchSize: 2,
      getCheckedAtForPages: async () => new Map(),
      filterSoftNotFound: async (siteId, pages) => ({ pages, dropped: [] }),
      markPagesCheckedFn: async () => {},
      getOpenRecommendationPagesFn: async () => ['https://acme.example/stale-1/'],
    });

    assert.ok(
      batch.includes('https://acme.example/stale-1/'),
      'the page with an open recommendation must be re-checked this run, not left to rotation'
    );
  });

  test('recheck pages never consume more than half the batch', async () => {
    // Deliberately NOT in the pages/inventory pool above — these URLs can only
    // land in the batch via the recheck path, so the cap is unambiguous
    // (unlike reusing pool URLs, which could also win a slot through
    // ordinary rotation and make the count look uncapped for the wrong reason).
    const { batch } = await selectCandidatePages(1, 'ai-visibility', {
      start: '2026-09-01',
      end: '2026-09-29',
      batchSize: 2,
      getCheckedAtForPages: async () => new Map(),
      filterSoftNotFound: async (siteId, pages) => ({ pages, dropped: [] }),
      markPagesCheckedFn: async () => {},
      getOpenRecommendationPagesFn: async () => [
        'https://acme.example/open-rec-a/',
        'https://acme.example/open-rec-b/',
        'https://acme.example/open-rec-c/',
      ],
    });

    const recheckCount = batch.filter((p) => p.includes('/open-rec-')).length;
    assert.equal(recheckCount, 1, 'batchSize 2 caps recheck slots at floor(2*0.5)=1, the rest stay for rotation');
    assert.equal(batch.length, 2, 'unused recheck slots are still filled by normal rotation — batch stays full');
  });

  test('no open recommendations means behavior is unchanged — pure rotation', async () => {
    const { batch } = await selectCandidatePages(1, 'ai-visibility', {
      start: '2026-09-01',
      end: '2026-09-29',
      batchSize: 2,
      getCheckedAtForPages: async () => new Map(),
      filterSoftNotFound: async (siteId, pages) => ({ pages, dropped: [] }),
      markPagesCheckedFn: async () => {},
      getOpenRecommendationPagesFn: async () => [],
    });

    assert.equal(batch.length, 2);
    for (const page of batch) {
      assert.ok(INVENTORY.some((r) => r.page === page), 'every candidate comes from the real inventory pool');
    }
  });
});

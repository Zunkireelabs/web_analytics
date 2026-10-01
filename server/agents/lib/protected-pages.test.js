import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { computeProtectedPages, isProtectedChange, normalizePageKey, PROTECTED_CHANGE_GENERATORS } from './protected-pages.js';
import { classifyRecommendation, AUTONOMY_DECISION } from './autonomy-decision.js';
import { getProtectedPageSet, clearProtectedPagesCache } from '../../store/protected-pages.js';

const row = (page, clicks, impressions, avgPos) => ({ page, clicks, impressions, positionSum: avgPos * impressions });

describe('computeProtectedPages', () => {
  test('a page with enough clicks is protected', () => {
    const s = computeProtectedPages([row('https://x.com/a/', 5, 100, 12), row('https://x.com/b/', 4, 100, 12)]);
    assert.deepEqual([...s], ['x.com/a']);
  });
  test('a page that ranks in the top 5 on real volume is protected even with no clicks yet', () => {
    const s = computeProtectedPages([row('https://x.com/c/', 0, 80, 3.2), row('https://x.com/d/', 0, 10, 2), row('https://x.com/e/', 0, 80, 9)]);
    assert.deepEqual([...s], ['x.com/c']);
  });
  test('position is impression-weighted, so one great-position blip does not protect a page', () => {
    assert.equal(computeProtectedPages([{ page: 'https://x.com/f/', clicks: 0, impressions: 100, positionSum: 100 * 18 }]).size, 0);
  });
  test('empty or missing data protects nothing', () => {
    assert.equal(computeProtectedPages([]).size, 0);
    assert.equal(computeProtectedPages(null).size, 0);
  });
});

describe('normalizePageKey', () => {
  test('www/apex, trailing slash, case and recommendation-key suffixes are one page', () => {
    const keys = ['https://www.X.com/a/', 'https://x.com/a', 'https://x.com/a/::external-citations', 'https://x.com/a/::typography-drift::2::subheading'].map(normalizePageKey);
    assert.equal(new Set(keys).size, 1);
  });
});

describe('isProtectedChange', () => {
  const pages = { pages: new Set(['x.com/a']), unknown: false };
  test('a ranking-sensitive change on a protected page is protected', () => {
    assert.equal(isProtectedChange({ recommendation_type: 'meta-title', page: 'https://x.com/a/' }, pages), true);
    assert.equal(isProtectedChange({ generatorId: 'canonical', params: { page: 'https://www.x.com/a' } }, pages), true);
  });
  test('the same change on an unprotected page, or a harmless change on a protected page, is not', () => {
    assert.equal(isProtectedChange({ recommendation_type: 'meta-title', page: 'https://x.com/other/' }, pages), false);
    for (const g of ['alt-text', 'schema', 'breadcrumbs', 'internal-links', 'broken-link-fix', 'llms-txt']) {
      assert.equal(PROTECTED_CHANGE_GENERATORS.has(g), false, g);
      assert.equal(isProtectedChange({ recommendation_type: g, page: 'https://x.com/a/' }, pages), false, g);
    }
  });
  test('when the lookup is unknown it fails closed for protected generators only', () => {
    const unknown = { pages: new Set(), unknown: true };
    assert.equal(isProtectedChange({ recommendation_type: 'meta-title', page: 'https://x.com/z/' }, unknown), true);
    assert.equal(isProtectedChange({ recommendation_type: 'alt-text', page: 'https://x.com/z/' }, unknown), false);
  });
  test('no guard data means no change in behaviour', () => {
    assert.equal(isProtectedChange({ recommendation_type: 'meta-title', page: 'https://x.com/a/' }, null), false);
  });
});

describe('classifyRecommendation with protected pages', () => {
  const pages = { pages: new Set(['x.com/a']), unknown: false };
  const rec = (type, page) => ({ risk_tier: 'safe', blocked_reason: null, status: 'open', recommendation_type: type, page });
  test('a safe-tier title change on a protected page needs human review', () => {
    const d = classifyRecommendation(rec('meta-title', 'https://x.com/a/'), null, pages);
    assert.equal(d.decision, AUTONOMY_DECISION.NEEDS_HUMAN_REVIEW);
    assert.match(d.reason, /person to approve/);
  });
  test('the same recommendation without the guard argument is unchanged (existing callers)', () => {
    assert.equal(classifyRecommendation(rec('meta-title', 'https://x.com/a/')).decision, AUTONOMY_DECISION.SAFE_TO_AUTO_EXECUTE);
  });
  test('an unprotected page still auto-executes', () => {
    assert.equal(classifyRecommendation(rec('meta-title', 'https://x.com/b/'), null, pages).decision, AUTONOMY_DECISION.SAFE_TO_AUTO_EXECUTE);
  });
});

describe('getProtectedPageSet', () => {
  beforeEach(() => clearProtectedPagesCache());
  test('builds the set from the page rows and caches it', async () => {
    let calls = 0;
    const run = async () => { calls++; return { rows: [{ page: 'https://x.com/a/', clicks: 9, impressions: 100, positionSum: 800 }] }; };
    const a = await getProtectedPageSet(1, { run, now: 1000 });
    const b = await getProtectedPageSet(1, { run, now: 2000 });
    assert.deepEqual([...a.pages], ['x.com/a']);
    assert.equal(a.unknown, false);
    assert.equal(calls, 1);
    assert.equal(b, a);
  });
  test('a failed lookup is unknown (fails closed), not an empty set', async () => {
    const run = async () => { throw new Error('db down'); };
    const v = await getProtectedPageSet(2, { run, now: 1000 });
    assert.equal(v.unknown, true);
  });
});

import { splitProtectedQueueItems, protectedFilePaths, splitProtectedFileEdits, sharedMappedFiles } from './protected-pages.js';

describe('shared-queue lanes', () => {
  const pages = { pages: new Set(['x.com/a']), unknown: false };

  test('learned-repair items on a protected page for a ranking-sensitive generator are held; others are kept', () => {
    const items = [
      { id: 1, generator_id: 'meta-title', params: { page: 'https://x.com/a/' } },
      { id: 2, generator_id: 'meta-title', params: { page: 'https://x.com/b/' } },
      { id: 3, generator_id: 'alt-text', params: { page: 'https://x.com/a/' } },
    ];
    const { kept, held } = splitProtectedQueueItems(items, pages);
    assert.deepEqual(held.map((i) => i.id), [1]);
    assert.deepEqual(kept.map((i) => i.id), [2, 3]);
  });

  const resolveFile = (_site, url) => ({ 'https://x.com/a/': 'src/blog/a.md', 'https://x.com/a': 'src/blog/a.md' }[url] || null);
  test('protectedFilePaths maps protected pages to their repo files, with or without a trailing slash', () => {
    assert.deepEqual([...protectedFilePaths({}, pages, resolveFile)], ['src/blog/a.md']);
    assert.equal(protectedFilePaths({}, { pages: new Set(['x.com/zzz']), unknown: false }, resolveFile).size, 0);
  });

  const bundle = (edits) => ({ id: 9, params: { edits, commitMessage: `Repair (${edits.length} file(s))\n\n${edits.map((e) => `- ${e.path}`).join('\n')}\n\nSee script.` } });
  test('a protected page file is taken out of a bundle and the rest still ships', () => {
    const files = new Set(['src/blog/a.md']);
    const { items, held } = splitProtectedFileEdits([bundle([{ path: 'src/blog/a.md', content: 'A' }, { path: 'src/blog/b.md', content: 'B' }])], files);
    assert.deepEqual(items[0].params.edits.map((e) => e.path), ['src/blog/b.md']);
    assert.ok(!items[0].params.commitMessage.includes('- src/blog/a.md'));
    assert.match(items[0].params.commitMessage, /- src\/blog\/b\.md/);
    assert.match(items[0].params.commitMessage, /Held for review \(ranking pages\): src\/blog\/a\.md/);
    assert.deepEqual(held, [{ itemId: 9, paths: ['src/blog/a.md'] }]);
  });
  test('a bundle with only protected files is dropped; an untouched bundle passes through unchanged', () => {
    const files = new Set(['src/blog/a.md']);
    assert.equal(splitProtectedFileEdits([bundle([{ path: 'src/blog/a.md', content: 'A' }])], files).items.length, 0);
    const clean = bundle([{ path: 'src/_includes/layouts/blog-post.njk', content: 'T' }]);
    assert.equal(splitProtectedFileEdits([clean], files).items[0], clean);
  });
  test('shared templates are never held, so a template repair is not frozen by a protected page', () => {
    const files = protectedFilePaths({}, pages, resolveFile);
    const tpl = bundle([{ path: 'src/_includes/layouts/blog-post.njk', content: 'T' }]);
    assert.equal(splitProtectedFileEdits([tpl], files).items.length, 1);
  });
  test('when the lookup is unknown the bundles wait for the next run', () => {
    const { items, held } = splitProtectedFileEdits([bundle([{ path: 'src/x.md', content: 'x' }])], new Set(), { unknown: true });
    assert.equal(items.length, 0);
    assert.equal(held.length, 1);
  });
});

describe('sharedMappedFiles — a template is never a page\'s own file', () => {
  const site = {
    url_file_map: {
      pages: { '/': { file: 'src/pages/index.njk' }, '/index': { file: 'src/pages/index.njk' }, '/about/': { file: 'src/pages/about.njk' }, '/a': { file: 'src/pages/shared.njk' }, '/b': { file: 'src/pages/shared.njk' } },
      patterns: [
        { match: '^/blog/([^/]+)/?$', file: 'src/blog/$1.md' },
        { match: '^/([^/]+)/?$', file: 'src/app/[slug]/page.tsx' },
        { match: '^/x/([^/]+)/?$', file: 'src/app/x/[id]/page.tsx' },
        { match: '^/loc/([^/]+)/?$' },
        { match: '^/legal/.*$', file: 'src/pages/legal.njk' },
      ],
    },
  };
  test('flags no-capture pattern files, dynamic-segment files, and files named by two distinct pages', () => {
    const shared = sharedMappedFiles(site);
    assert.ok(shared.has('src/app/[slug]/page.tsx'));
    assert.ok(shared.has('src/app/x/[id]/page.tsx'));
    assert.ok(shared.has('src/pages/legal.njk'));
    assert.ok(shared.has('src/pages/index.njk'));
    assert.ok(shared.has('src/pages/shared.njk'));
  });
  test('a page that has a file of its own, or a per-page pattern file, is not shared', () => {
    const shared = sharedMappedFiles(site);
    assert.equal(shared.has('src/pages/about.njk'), false);
    assert.equal(shared.has('src/blog/$1.md'), false);
  });
  test('a protected page resolving to a shared file does not put that file in the protected set', () => {
    const resolveFile = (_s, url) => (url.includes('contact') ? 'src/app/[slug]/page.tsx' : 'src/pages/about.njk');
    const pages = { pages: new Set(['x.com/contact', 'x.com/about']), unknown: false };
    assert.deepEqual([...protectedFilePaths(site, pages, resolveFile)].sort(), ['src/pages/about.njk']);
  });
  test('a url_file_map-less site has no shared files and nothing breaks', () => {
    assert.equal(sharedMappedFiles({}).size, 0);
    assert.equal(sharedMappedFiles(null).size, 0);
  });
});

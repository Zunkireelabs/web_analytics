import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runQualityGate } from './quality-gate.js';
import { isArticlePageUrl, _resetArticlePageCacheForTest } from './article-page.js';

const site = { url_file_map: { siteRoot: { visibleClaimBans: ['consultancy'], visibleClaimBansExemptArticlePages: true } } };
const content = { sections: [{ heading: 'Why choose a partner', body: 'A reliable study abroad consultancy helps you compare options and plan every step of your application with clear, honest guidance.' }] };
const banned = (r) => r.issues.some((i) => i.patternId === 'banned-visible-claim');

beforeEach(() => _resetArticlePageCacheForTest());

describe('runQualityGate — word ban follows the PAGE, not the generator', () => {
  test('the same copy passes on a blog post and fails on a landing page, for the same generator', async () => {
    await isArticlePageUrl('https://x.test/blog-post', { analyze: async () => ({ ok: true, analysis: { isArticlePage: true } }) });
    await isArticlePageUrl('https://x.test/landing', { analyze: async () => ({ ok: true, analysis: { isArticlePage: false } }) });
    const onBlog = await runQualityGate(content, 'expand-content', 1, { site, page: 'https://x.test/blog-post' });
    const onLanding = await runQualityGate(content, 'expand-content', 1, { site, page: 'https://x.test/landing' });
    assert.equal(banned(onBlog), false);
    assert.equal(banned(onLanding), true);
  });
  test('an unpublished blog post is exempt by the site blog URL pattern, for any generator', async () => {
    const withPattern = { url_file_map: { ...site.url_file_map, newContentTargets: { 'blog-outline': { urlPattern: '/blogs/{slug}' } } } };
    assert.equal(banned(await runQualityGate(content, 'faq', 1, { site: withPattern, page: 'https://x.test/blogs/not-live-yet' })), false);
    assert.equal(banned(await runQualityGate(content, 'faq', 1, { site: withPattern, page: 'https://x.test/not-a-post' })), true);
  });
  test('no page known: the ban applies', async () => {
    assert.equal(banned(await runQualityGate(content, 'expand-content', 1, { site })), true);
  });
});

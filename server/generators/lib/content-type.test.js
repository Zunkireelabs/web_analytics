import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveContentType, ensureClassification, isArticleClassification, needsTypeReview, typeDependentRestrictionsApply, groupOf, PAGE_TYPES,
} from './content-type.js';
import { _resetArticlePageCacheForTest } from './article-page.js';

const blogSite = {
  url_file_map: {
    siteRoot: { visibleClaimBans: ['consultancy'] },
    newContentTargets: {
      'blog-outline': { urlPattern: '/blogs/{slug}', dir: 'src/app/blogs' },
      'direct-answer': { urlPattern: '/blogs/{slug}' },
      'landing-page': { urlPattern: '/{slug}' },
    },
  },
};
const noBans = { url_file_map: { siteRoot: {}, newContentTargets: blogSite.url_file_map.newContentTargets } };
const never = async () => { throw new Error('the page must not be read'); };
const analyzeAs = (isArticlePage) => async () => ({ ok: true, analysis: { isArticlePage } });

describe('automatic detection — with a URL', () => {
  test('a URL under the site\'s own blog pattern is a blog post (high), no page read', async () => {
    _resetArticlePageCacheForTest();
    const c = await resolveContentType({ site: blogSite, generatorId: 'faq', params: { page: 'https://x.test/blogs/new-post' }, analyze: never });
    assert.equal(c.status, 'resolved'); assert.equal(c.group, 'article'); assert.equal(c.confidence, 'high');
    assert.ok(c.evidence.some((e) => e.source === 'site-blog-pattern'));
  });
  test('a page that declares itself an article is an article (high)', async () => {
    _resetArticlePageCacheForTest();
    const c = await resolveContentType({ site: noBans, generatorId: 'expand-content', params: { page: 'https://x.test/a-post-with-no-blog-in-the-url' }, analyze: analyzeAs(true) });
    assert.equal(c.status, 'resolved'); assert.equal(c.group, 'article'); assert.equal(c.confidence, 'high');
  });
  test('a page that loads and is NOT an article is non-article (medium), so restrictions stay on', async () => {
    _resetArticlePageCacheForTest();
    const c = await resolveContentType({ site: blogSite, generatorId: 'faq', params: { page: 'https://x.test/study-in-the-uk' }, analyze: analyzeAs(false) });
    assert.equal(c.status, 'resolved'); assert.equal(c.group, 'non-article'); assert.equal(isArticleClassification(c), false);
  });
  test('stored page metadata (captured design profile) is used for the exact page', async () => {
    _resetArticlePageCacheForTest();
    const site = { url_file_map: { siteRoot: { designProfile: { pages: [{ url: 'https://x.test/pricing/', pageType: 'service' }] } } } };
    const c = await resolveContentType({ site, generatorId: 'faq', params: { page: 'https://x.test/pricing' }, fetchPage: false });
    assert.equal(c.pageType, 'service-page'); assert.equal(c.confidence, 'medium');
    assert.ok(c.evidence.some((e) => e.source === 'stored-page-metadata'));
  });
  test('the page analysis the caller already holds is reused instead of reading the page again', async () => {
    const c = await resolveContentType({ site: noBans, generatorId: 'meta-title', params: { page: 'https://x.test/p' }, pageAnalysis: { isArticlePage: true }, analyze: never });
    assert.equal(c.group, 'article');
  });
});

describe('automatic detection — NO URL yet', () => {
  test('blog-outline IS a blog post, with no URL at all', async () => {
    const c = await resolveContentType({ site: blogSite, generatorId: 'blog-outline', params: { topic: 'UK visa rules' } });
    assert.equal(c.status, 'resolved'); assert.equal(c.pageType, 'blog'); assert.equal(c.confidence, 'high'); assert.equal(isArticleClassification(c), true);
  });
  test('landing-page is a landing page with no URL — and is NOT treated as a blog', async () => {
    const c = await resolveContentType({ site: blogSite, generatorId: 'landing-page', params: { topic: 'Study in Canada' } });
    assert.equal(c.pageType, 'landing-page'); assert.equal(isArticleClassification(c), false);
  });
  test('a generator whose configured destination is the blog directory is blog content (site destination)', async () => {
    const c = await resolveContentType({ site: blogSite, generatorId: 'direct-answer', params: { question: 'How much is the UK visa fee?' } });
    assert.equal(c.group, 'article'); assert.ok(c.evidence.some((e) => e.source === 'site-destination'));
  });
  test('a generator with a non-blog destination is not made a blog by the missing URL', async () => {
    const c = await resolveContentType({ site: blogSite, generatorId: 'cookie-policy', params: {} });
    assert.equal(c.pageType, 'other'); assert.equal(isArticleClassification(c), false);
  });
  test('a declared pageType is honoured, and an invalid one is ignored', async () => {
    assert.equal((await resolveContentType({ site: noBans, generatorId: 'faq', params: { pageType: 'product-page' } })).pageType, 'product-page');
    assert.equal((await resolveContentType({ site: noBans, generatorId: 'faq', params: { pageType: 'banana' } })).status, 'unknown');
  });
});

describe('unknown and conflicting evidence — the controlled fallback', () => {
  test('no evidence at all is UNKNOWN, never silently a landing page or a blog', async () => {
    const c = await resolveContentType({ site: noBans, generatorId: 'faq', params: {} });
    assert.equal(c.status, 'unknown'); assert.equal(c.pageType, null); assert.equal(isArticleClassification(c), false);
  });
  test('only weak evidence (task wording, URL shape) is UNKNOWN, with the guess kept as tentative', async () => {
    _resetArticlePageCacheForTest();
    const c = await resolveContentType({ site: noBans, generatorId: 'faq', params: { topic: 'Write a blog post about visas' }, fetchPage: false });
    assert.equal(c.status, 'unknown'); assert.equal(c.tentativeType, 'blog'); assert.equal(isArticleClassification(c), false);
    const u = await resolveContentType({ site: noBans, generatorId: 'faq', params: { page: 'https://x.test/blog/some-post' }, fetchPage: false });
    assert.equal(u.status, 'unknown'); assert.equal(isArticleClassification(u), false);
  });
  test('equally strong evidence that disagrees is a CONFLICT, and is not relaxed', async () => {
    _resetArticlePageCacheForTest();
    // generator says landing page (high) while the site's own blog pattern says blog post (high)
    const c = await resolveContentType({ site: blogSite, generatorId: 'landing-page', params: { page: 'https://x.test/blogs/oops' } });
    assert.equal(c.status, 'conflict'); assert.equal(c.pageType, null); assert.equal(isArticleClassification(c), false);
    assert.ok(c.evidence.length >= 2);
  });
  test('weaker evidence that disagrees with stronger evidence does NOT cause a conflict — the stronger wins and both are recorded', async () => {
    _resetArticlePageCacheForTest();
    const c = await resolveContentType({ site: blogSite, generatorId: 'faq', params: { page: 'https://x.test/blogs/post', topic: 'our landing page copy' } });
    assert.equal(c.status, 'resolved'); assert.equal(c.group, 'article');
    assert.ok(c.evidence.some((e) => e.source === 'task-wording' && e.strength === 'low'));
  });
  test('needsTypeReview: only when the type is unclear AND the site has a type-dependent restriction', async () => {
    const unknown = await resolveContentType({ site: blogSite, generatorId: 'faq', params: {} });
    const resolved = await resolveContentType({ site: blogSite, generatorId: 'blog-outline', params: {} });
    assert.equal(needsTypeReview(unknown, blogSite), true);
    assert.equal(needsTypeReview(unknown, noBans), false, 'a site with no type-dependent restriction is never held');
    assert.equal(needsTypeReview(resolved, blogSite), false);
    assert.equal(needsTypeReview(null, blogSite), true, 'a missing classification counts as unclear');
    assert.equal(typeDependentRestrictionsApply(noBans), false);
    assert.equal(typeDependentRestrictionsApply({ url_file_map: { siteRoot: { titleClaimBans: ['x'] } } }), true);
  });
});

describe('storage and reuse', () => {
  test('ensureClassification stores pageType + the full classification with its evidence on the params', async () => {
    const { params, classification } = await ensureClassification({ site: blogSite, generatorId: 'blog-outline', params: { topic: 't' } });
    assert.equal(params.pageType, 'blog');
    assert.equal(params.pageClassification, classification);
    assert.ok(classification.evidence.length >= 1 && classification.resolvedAt);
    assert.equal(params.topic, 't', 'the caller\'s own params are kept');
  });
  test('a stored classification is reused as-is: nothing is re-derived (no page read, same result)', async () => {
    const first = await ensureClassification({ site: blogSite, generatorId: 'blog-outline', params: {} });
    const again = await ensureClassification({ site: blogSite, generatorId: 'faq', params: { ...first.params, page: 'https://x.test/anything' }, analyze: never });
    assert.equal(again.classification, first.classification);
    assert.equal(again.params.pageType, 'blog');
  });
  test('an unresolved type leaves NO pageType behind for a later step to trust', async () => {
    const { params, classification } = await ensureClassification({ site: noBans, generatorId: 'faq', params: { pageType: 'banana' } });
    assert.equal(classification.status, 'unknown');
    assert.equal('pageType' in params, false);
    assert.equal(params.pageClassification.status, 'unknown');
  });
  test('vocabulary covers blog, article, blog-post, landing-page, service-page, product-page and other', () => {
    for (const t of ['blog', 'article', 'blog-post', 'landing-page', 'service-page', 'product-page', 'other']) assert.ok(PAGE_TYPES.includes(t), t);
    assert.equal(groupOf('blog-post'), 'article'); assert.equal(groupOf('service-page'), 'non-article');
  });
});

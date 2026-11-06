import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mayInsertContentBlock, mayWriteComparisonInto, comparisonPlacement, CONTENT_FACT_RULES } from './content-placement-policy.js';

// These rules exist because of how a real designed page breaks when they are ignored: a block of generated prose
// spliced under a designed section is filler in a layout that was never meant to hold it, and a comparison on a page
// that is not about that comparison is a claim the page never earned.

describe('no generated block on a designed page', () => {
  const blocked = [
    ['the homepage', 'https://site.com/'],
    ['a blog index', 'https://site.com/blog/'],
    ['an articles index', 'https://site.com/articles/'],
    ['an insights index', 'https://site.com/insights/'],
    ['a products hub', 'https://site.com/products/'],
    ['a solutions hub', 'https://site.com/solutions/'],
    ['a services hub', 'https://site.com/services/'],
    ['a locations hub', 'https://site.com/locations/'],
    ['a customers index', 'https://site.com/customers/'],
    ['a team page', 'https://site.com/team/'],
    ['a projects index', 'https://site.com/projects/'],
    ['an industries index', 'https://site.com/industries/'],
  ];

  for (const [what, url] of blocked) {
    test(`${what} is refused`, () => {
      const out = mayInsertContentBlock('expand-content', url);
      assert.equal(out.allowed, false, url);
      assert.ok(out.detail.includes(url));
    });
  }

  test('a blog post is allowed — that is a prose page', () => {
    assert.equal(mayInsertContentBlock('expand-content', 'https://site.com/blog/teeth-whitening-cost/').allowed, true);
  });

  test('a detail page BENEATH a hub is allowed — only the hub itself is designed sections', () => {
    for (const url of [
      'https://site.com/services/teeth-whitening/',
      'https://site.com/products/widget-x/',
      'https://site.com/solutions/for-clinics/',
      'https://site.com/locations/pokhara/',
      'https://site.com/customers/acme-case-study/',
    ]) {
      assert.equal(mayInsertContentBlock('expand-content', url).allowed, true, url);
    }
  });

  test('ordinary content pages are allowed', () => {
    assert.equal(mayInsertContentBlock('expand-content', 'https://site.com/about/').allowed, true);
    assert.equal(mayInsertContentBlock('expand-content', 'https://site.com/contact/').allowed, true);
  });

  test('FAQ and Q&A blocks follow the same rule as expanded content', () => {
    for (const generator of ['faq', 'qa-content']) {
      assert.equal(mayInsertContentBlock(generator, 'https://site.com/').allowed, false, generator);
      assert.equal(mayInsertContentBlock(generator, 'https://site.com/blog/post/').allowed, true, generator);
    }
  });

  test('a generator that does not insert a block is not this rule\'s business', () => {
    for (const generator of ['meta-title', 'schema', 'internal-links', 'blog-outline', 'landing-page']) {
      assert.equal(mayInsertContentBlock(generator, 'https://site.com/').allowed, true, generator);
    }
  });

  test('product-site section pages are refused on a product tenant', () => {
    for (const path of ['/pricing/', '/features/', '/how-it-works/', '/demo/']) {
      const out = mayInsertContentBlock('expand-content', `https://app.site.com${path}`, { propertyType: 'product' });
      assert.equal(out.allowed, false, path);
    }
  });

  test('the refusal names the page type, so it can be explained to a human', () => {
    const out = mayInsertContentBlock('expand-content', 'https://site.com/blog/');
    assert.equal(out.pageType, 'blog-listing');
    assert.equal(out.reason, 'designed-section-page');
  });

  test('no page to judge leaves the decision to the generator\'s own checks', () => {
    assert.equal(mayInsertContentBlock('expand-content', null).allowed, true);
  });

  test('a malformed URL is still judged on its path rather than waved through', () => {
    assert.equal(mayInsertContentBlock('expand-content', '/customers/').allowed, false);
  });
});

describe('where a comparison may go', () => {
  const comparePages = [
    { url: '/compare/zunkiree-labs-vs-generic-ai-providers/', title: 'Zunkiree Labs vs generic AI providers' },
    { url: '/compare/gaas-vs-saas/', title: 'GaaS vs SaaS' },
  ];

  test('a blog post that is itself a comparison may hold the comparison', () => {
    const out = comparisonPlacement('https://site.com/blog/gaas-vs-saas/', { topic: 'gaas vs saas', comparePages });
    assert.equal(out.kind, 'inline');
  });

  test('a real page gets one link to the matching compare page, never the comparison itself', () => {
    const out = comparisonPlacement('https://site.com/products/', { topic: 'gaas vs saas', comparePages });
    assert.equal(out.kind, 'link');
    assert.equal(out.comparePage, '/compare/gaas-vs-saas/');
  });

  test('the homepage is a real page too', () => {
    assert.equal(comparisonPlacement('https://site.com/', { topic: 'gaas vs saas', comparePages }).kind, 'link');
  });

  test('with no matching compare page the answer is to report it, not to invent it', () => {
    const out = comparisonPlacement('https://site.com/products/', { topic: 'rag vs fine tuning', comparePages });
    assert.equal(out.kind, 'report-missing');
    assert.equal(out.topic, 'rag vs fine tuning');
  });

  test('a near-miss is reported as missing rather than linked to the wrong comparison', () => {
    const out = comparisonPlacement('https://site.com/products/', { topic: 'gaas vs paas pricing models', comparePages });
    assert.equal(out.kind, 'report-missing');
  });

  test('no topic at all cannot be matched to anything', () => {
    assert.equal(comparisonPlacement('https://site.com/products/', { comparePages }).kind, 'report-missing');
  });

  test('compare pages given as plain strings also match', () => {
    const out = comparisonPlacement('https://site.com/products/', { topic: 'gaas vs saas', comparePages: ['/compare/gaas-vs-saas/'] });
    assert.equal(out.kind, 'link');
  });
});

describe('fact rules', () => {
  test('they forbid unnamed competitors, unsourced statistics and stray comparisons', () => {
    assert.match(CONTENT_FACT_RULES, /named source and a link/);
    assert.match(CONTENT_FACT_RULES, /unnamed competitor/);
    assert.match(CONTENT_FACT_RULES, /never compare this company with another one/);
  });
});

describe('a comparison is refused on any page that is not about it', () => {
  test('only a post whose subject is the comparison may hold one', () => {
    assert.equal(mayWriteComparisonInto('https://site.com/blog/gaas-vs-saas/').allowed, true);
  });

  test('every other page type is refused, including ones that accept ordinary sections', () => {
    for (const url of [
      'https://site.com/', 'https://site.com/blog/', 'https://site.com/products/',
      'https://site.com/products/widget-x/', 'https://site.com/about/', 'https://site.com/services/whitening/',
    ]) {
      const out = mayWriteComparisonInto(url);
      assert.equal(out.allowed, false, url);
      assert.equal(out.reason, 'comparison-off-page');
    }
  });

  test('a detail page accepts an expanded section but still not a comparison', () => {
    const url = 'https://site.com/services/whitening/';
    assert.equal(mayInsertContentBlock('expand-content', url).allowed, true);
    assert.equal(mayWriteComparisonInto(url).allowed, false);
  });

  test('no page means no placement', () => {
    assert.equal(mayWriteComparisonInto(null).allowed, false);
  });
});

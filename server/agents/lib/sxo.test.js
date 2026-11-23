import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyResultType, serpConsensus, ourPageKind, judgeMismatch, findStrikingPairs } from './sxo.js';

const r = (title, url = 'https://x.example/page', domain = 'x.example') => ({ title, url, domain });

describe('classifyResultType', () => {
  test('each type from its title or address', () => {
    assert.equal(classifyResultType(r('Free mortgage calculator')), 'tool');
    assert.equal(classifyResultType(r('HubSpot vs Salesforce: which is better?')), 'comparison');
    assert.equal(classifyResultType(r('Top 5 CRM alternatives')), 'comparison');
    assert.equal(classifyResultType(r('Blue running shoes', 'https://shop.example/products/blue-shoes/')), 'product');
    assert.equal(classifyResultType(r('Buy running shoes online | From $59')), 'product');
    assert.equal(classifyResultType(r('Emergency plumber near me', 'https://a.example/services/plumbing/')), 'service');
    assert.equal(classifyResultType(r('Plumbing company in Denver')), 'service');
    assert.equal(classifyResultType(r('How to fix a leaking tap', 'https://a.example/blog/leaking-tap/')), 'article');
    assert.equal(classifyResultType(r('10 best CRM tools for plumbers')), 'article');
    assert.equal(classifyResultType(r('Acme')), 'other');
  });
  test('"best" and "how to" titles are articles even when they mention price or services', () => {
    assert.equal(classifyResultType(r('Best price comparison tips: how to save on boilers')), 'comparison'); // the word compar wins by precedence
    assert.equal(classifyResultType(r('How to price your plumbing services')), 'article');
    assert.equal(classifyResultType(r('Best plumbing services in Denver')), 'article');
  });
  test('a result with no usable address is judged on its title alone', () => assert.equal(classifyResultType({ title: 'How to bake bread', url: 'not a url' }), 'article'));
});

describe('serpConsensus', () => {
  const many = (n, title, url) => Array.from({ length: n }, (_, i) => r(`${title} ${i}`, url ? `${url}${i}/` : undefined, `d${i}.example`));
  test('strong when 60%+ of the typed results agree (and at least five can be typed)', () => {
    const c = serpConsensus([...many(7, 'Buy shoes online', 'https://s.example/products/'), ...many(2, 'How to choose shoes'), r('Acme')]);
    assert.equal(c.dominant, 'product'); assert.equal(c.strong, true); assert.ok(c.share >= 0.7);
    assert.equal(c.examples.length, 3); assert.equal(c.typedCount, 9);
  });
  test('a mixed results page, or too few typed results, is not strong: no verdict will be made from it', () => {
    assert.equal(serpConsensus([...many(3, 'Buy shoes online', 'https://s.example/products/'), ...many(3, 'Shoe repair services near me', 'https://a.example/services/'), ...many(3, 'How to choose shoes')]).strong, false, 'a three-way split');
    assert.equal(serpConsensus(many(3, 'Buy shoes online', 'https://s.example/products/')).strong, false, 'only 3 typed results');
    assert.deepEqual([serpConsensus([]).dominant, serpConsensus([]).strong], ['other', false]);
  });
});

describe('judgeMismatch', () => {
  const strong = (dominant) => ({ dominant, strong: true, share: 0.8 });
  test('an article against product listings is a high-severity mismatch with advice', () => {
    const v = judgeMismatch('article', strong('product'));
    assert.equal(v.severity, 'high'); assert.match(v.advice, /product and shop pages/);
  });
  test('a sales page against articles is high; the same page type as the results is no finding', () => {
    assert.equal(judgeMismatch('service', strong('article')).severity, 'high');
    assert.equal(judgeMismatch('article', strong('article')), null);
    assert.equal(judgeMismatch('service', strong('service')), null);
  });
  test('softer mismatches are medium', () => {
    assert.equal(judgeMismatch('article', strong('service')).severity, 'medium');
    assert.equal(judgeMismatch('product', strong('comparison')).severity, 'medium');
  });
  test('no verdict when the results page is not clear, or the page\'s own type is unknown', () => {
    assert.equal(judgeMismatch('article', { dominant: 'product', strong: false }), null);
    assert.equal(judgeMismatch(null, strong('product')), null);
    assert.equal(judgeMismatch('article', strong('other')), null);
  });
});

describe('ourPageKind', () => {
  test('maps the page classifier\'s types, and leaves legal and unknown pages alone', () => {
    assert.deepEqual(['blog', 'faq', 'product', 'category', 'service', 'landing'].map(ourPageKind), ['article', 'article', 'product', 'product', 'service', 'service']);
    assert.equal(ourPageKind('legal'), null); assert.equal(ourPageKind('other'), null); assert.equal(ourPageKind(undefined), null);
  });
});

describe('findStrikingPairs', () => {
  const row = (page, query, avgPosition, impressions) => ({ page, query, avgPosition, impressions });
  test('positions 8-20 with real impressions, the strongest query per page, biggest first, capped', () => {
    const pairs = findStrikingPairs([
      row('/a', 'q1', 9, 100), row('/a', 'q2', 12, 400), row('/b', 'q3', 15, 250), row('/c', 'q4', 4, 9000), row('/d', 'q5', 35, 9000),
      row('/e', 'q6', 10, 10), row('/f', 'q7', 8, 60), row('/g', 'q8', 20, 70), row('/h', 'q9', 21, 5000),
    ], { max: 4 });
    assert.deepEqual(pairs.map((p) => [p.page, p.query]), [['/a', 'q2'], ['/b', 'q3'], ['/g', 'q8'], ['/f', 'q7']]);
  });
  test('junk rows and no rows are fine', () => {
    assert.deepEqual(findStrikingPairs([{ page: null, query: 'x', avgPosition: 10, impressions: 100 }, { page: '/a', query: 'x', avgPosition: 'n/a', impressions: 100 }]), []);
    assert.deepEqual(findStrikingPairs(null), []);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractSnapshot, normalizePageUrl, stableStringify } from './seo-snapshot.js';

const PAGE = 'https://example.com/blog/post/';
const html = (over = {}) => `<!doctype html><html><head>
  <title>${over.title ?? '  Best   Salon Software  '}</title>
  ${over.desc === null ? '' : `<meta name="description" content="${over.desc ?? 'Run your salon.'}">`}
  ${over.canonical === null ? '' : `<link rel="canonical" href="${over.canonical ?? '/blog/post/'}">`}
  ${over.robots ? `<meta name="robots" content="${over.robots}">` : ''}
  <meta property="og:title" content="OG title"><meta property="og:image" content="https://example.com/i.png">
  ${over.ld === null ? '' : `<script type="application/ld+json">${over.ld ?? '{"@context":"https://schema.org","@type":"Article","headline":"X"}'}</script>`}
  <script>var nonce = "${over.nonce ?? 'abc123'}";</script>
</head><body>
  <h1>${over.h1 ?? 'Salon software'}</h1><h2>Pricing</h2><h2>Features</h2>
  <p>Posted ${over.date ?? '3 days ago'} with ${over.comments ?? 4} comments. Everything a salon needs to run.</p>
  <!-- rendered at ${over.nonce ?? 'abc123'} -->
</body></html>`;

describe('extractSnapshot', () => {
  test('pulls the SEO-critical elements', () => {
    const s = extractSnapshot({ html: html(), statusCode: 200, headers: {}, pageUrl: PAGE });
    assert.equal(s.statusCode, 200);
    assert.equal(s.title, 'Best Salon Software');
    assert.equal(s.metaDescription, 'Run your salon.');
    assert.equal(s.canonical, 'https://example.com/blog/post/', 'a relative canonical is resolved against the page');
    assert.deepEqual(s.h1, ['Salon software']);
    assert.deepEqual(s.h2, ['Pricing', 'Features']);
    assert.deepEqual(s.schemaTypes, ['Article']);
    assert.ok(s.schemaHash);
    assert.deepEqual(Object.keys(s.openGraph).sort(), ['og:image', 'og:title']);
    assert.equal(s.robots, null);
  });

  test('robots directives come from the meta tag and the X-Robots-Tag header, merged and sorted', () => {
    const s = extractSnapshot({ html: html({ robots: 'NoFollow, index' }), headers: { 'x-robots-tag': 'noindex' }, pageUrl: PAGE });
    assert.equal(s.robots, 'index, nofollow, noindex');
  });

  test('structured data: @graph and nested types are found; key order does not change the hash', () => {
    const a = extractSnapshot({ html: html({ ld: '{"@context":"x","@graph":[{"@type":"Organization","name":"A"},{"@type":["WebSite","Thing"],"url":"u"}]}' }), pageUrl: PAGE });
    assert.deepEqual(a.schemaTypes, ['Organization', 'Thing', 'WebSite']);
    const b1 = extractSnapshot({ html: html({ ld: '{"@type":"Article","headline":"X","author":"Y"}' }), pageUrl: PAGE });
    const b2 = extractSnapshot({ html: html({ ld: '{"author":"Y","headline":"X","@type":"Article"}' }), pageUrl: PAGE });
    assert.equal(b1.schemaHash, b2.schemaHash);
    const b3 = extractSnapshot({ html: html({ ld: '{"@type":"Article","headline":"CHANGED","author":"Y"}' }), pageUrl: PAGE });
    assert.notEqual(b1.schemaHash, b3.schemaHash);
  });

  test('broken JSON-LD still counts as "something is there"', () => {
    const s = extractSnapshot({ html: html({ ld: '{not json' }), pageUrl: PAGE });
    assert.ok(s.schemaHash);
    assert.deepEqual(s.schemaTypes, []);
  });

  test('no structured data gives a null hash', () => {
    assert.equal(extractSnapshot({ html: html({ ld: null }), pageUrl: PAGE }).schemaHash, null);
  });

  test('the content hash ignores scripts, comments and digits, so a nonce, a date or a counter is not "drift"', () => {
    const a = extractSnapshot({ html: html({ nonce: 'aaa', date: '3 days ago', comments: 4 }), pageUrl: PAGE });
    const b = extractSnapshot({ html: html({ nonce: 'zzz', date: '5 days ago', comments: 11 }), pageUrl: PAGE });
    assert.equal(a.contentHash, b.contentHash);
    const c = extractSnapshot({ html: html({ h1: 'A completely different heading' }), pageUrl: PAGE });
    assert.notEqual(a.contentHash, c.contentHash);
  });

  test('an error page or empty body does not throw', () => {
    const s = extractSnapshot({ html: null, statusCode: 503, pageUrl: PAGE });
    assert.equal(s.statusCode, 503);
    assert.equal(s.title, null);
    assert.deepEqual(s.h1, []);
    assert.equal(s.contentHash, null);
    assert.equal(extractSnapshot({ html: '<html></html>', statusCode: 200, pageUrl: PAGE }).wordCount, 0);
  });
});

describe('normalizePageUrl', () => {
  test('lowercases host, drops fragment and tracking parameters, sorts the rest, keeps the path as written', () => {
    assert.equal(normalizePageUrl('HTTPS://Example.COM/Blog/Post/?utm_source=x&b=2&a=1&gclid=9#top'), 'https://example.com/Blog/Post/?a=1&b=2');
    assert.equal(normalizePageUrl('https://example.com/a'), 'https://example.com/a');
    assert.notEqual(normalizePageUrl('https://example.com/a/'), normalizePageUrl('https://example.com/a'), 'a trailing slash is a different URL');
  });
  test('rejects what is not a URL', () => {
    assert.throws(() => normalizePageUrl('not a url'));
  });
});

test('stableStringify sorts keys at every depth', () => {
  assert.equal(stableStringify({ b: [{ z: 1, a: 2 }], a: null }), '{"a":null,"b":[{"a":2,"z":1}]}');
});

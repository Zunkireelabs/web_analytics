import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { __testables } from './audit-url-file-map.js';

const { looksLikeOgPlaceholder, verifyLiveOpenGraph, extractMetaContent } = __testables;

describe('extractMetaContent', () => {
  test('reads a real og:title content value', () => {
    const html = '<meta property="og:title" content="Study in Australia - Admizz Education">';
    assert.equal(extractMetaContent(html, 'og:title'), 'Study in Australia - Admizz Education');
  });

  test('returns null when the tag is absent', () => {
    assert.equal(extractMetaContent('<html></html>', 'og:title'), null);
  });

  test('returns null for an empty content attribute, not an empty string that looks truthy', () => {
    assert.equal(extractMetaContent('<meta property="og:title" content="">', 'og:title'), null);
  });
});

describe('looksLikeOgPlaceholder', () => {
  test('flags common scaffolding text', () => {
    for (const v of ['TODO', 'tbd', 'Lorem ipsum', 'Placeholder', 'Untitled', 'Coming Soon', 'test', 'xxx']) {
      assert.equal(looksLikeOgPlaceholder(v), true, `expected "${v}" to be flagged`);
    }
  });

  test('flags a suspiciously short fragment', () => {
    assert.equal(looksLikeOgPlaceholder('Hi'), true);
  });

  test('does not flag a real, short-but-legitimate title', () => {
    assert.equal(looksLikeOgPlaceholder('About Us | Admizz Education'), false);
    assert.equal(looksLikeOgPlaceholder('Home'), false, 'a real, common page title — "Home" is not on the denylist, only exact scaffolding phrases are');
  });

  test('does not flag a real description sentence', () => {
    assert.equal(looksLikeOgPlaceholder('Dreaming of studying abroad? We help you explore top destinations.'), false);
  });
});

describe('verifyLiveOpenGraph', () => {
  test('ok:true when both tags are present and look real', async () => {
    const html = '<meta property="og:title" content="Study in Australia - Admizz Education">'
      + '<meta property="og:description" content="Top universities, visa support, and scholarships.">';
    const result = await verifyLiveOpenGraph('https://example.com/', async () => ({ ok: true, html }));
    assert.equal(result.ok, true);
    assert.equal(result.title, 'Study in Australia - Admizz Education');
  });

  test('ok:false when og:title looks like placeholder text, even though it is present and non-empty', async () => {
    const html = '<meta property="og:title" content="TODO">'
      + '<meta property="og:description" content="Top universities, visa support, and scholarships.">';
    const result = await verifyLiveOpenGraph('https://example.com/', async () => ({ ok: true, html }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /placeholder/);
  });

  test('ok:false when the fetch itself fails — never guessed clean on missing evidence', async () => {
    const result = await verifyLiveOpenGraph('https://example.com/', async () => ({ ok: false, error: 'HTTP 404' }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'HTTP 404');
  });
});

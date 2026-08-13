import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeSiteFingerprint, fingerprintCompatible } from './site-fingerprint.js';

// The fingerprint is what decides whether a repair proven on one client is
// allowed to run on another's repository. Two properties matter equally:
// it must REFUSE on any missing or conflicting required signal, and it must
// never carry client-identifying data (it is stored on a cross-tenant row).

const ELEVENTY = {
  tech_stack: null,
  url_file_map: {
    renderCapabilities: {
      generator: 'eleventy',
      extensions: { '.njk': { markdown: false }, '.md': { markdown: true }, '.11ty.md': { markdown: true } },
    },
    pages: {
      'https://zunkireelabs.com/products/alpha': {
        file: 'src/pages/products/alpha.njk',
        adapters: { faq: { id: 'data-array-content' } },
      },
    },
  },
};

const NEXTJS = {
  tech_stack: 'nextjs',
  url_file_map: {
    renderCapabilities: { generator: 'nextjs', extensions: { '.tsx': { markdown: false } } },
  },
};

describe('computeSiteFingerprint', () => {
  test('captures the generator, extensions and adapters', () => {
    const fp = computeSiteFingerprint(ELEVENTY);
    assert.ok(fp.includes('render:eleventy'));
    assert.ok(fp.includes('ext:.njk'));
    assert.ok(fp.includes('ext:.md'));
    assert.ok(fp.includes('adapter:data-array-content'));
  });

  test('adds the target file extension and its markdown capability', () => {
    const fp = computeSiteFingerprint(ELEVENTY, { targetFilePath: 'src/pages/products/alpha.njk' });
    assert.ok(fp.includes('target-ext:.njk'));
    assert.ok(fp.includes('md:false'));
  });

  test('resolves compound extensions the way the rendering gate does', () => {
    // .11ty.md must not be shadowed by a naive split on the last dot, or the
    // lesson would be matched against the wrong capability entry.
    const fp = computeSiteFingerprint(ELEVENTY, { targetFilePath: 'src/pages/guide.11ty.md' });
    assert.ok(fp.includes('target-ext:.11ty.md'));
    assert.ok(fp.includes('md:true'));
  });

  test('omits tech_stack when it is null (the real state of every live site)', () => {
    assert.ok(!computeSiteFingerprint(ELEVENTY).some((t) => t.startsWith('stack:')));
    assert.ok(computeSiteFingerprint(NEXTJS).includes('stack:nextjs'));
  });

  test('a site with no renderCapabilities produces no required tokens rather than a false match', () => {
    const fp = computeSiteFingerprint({ url_file_map: {} });
    assert.ok(!fp.some((t) => t.startsWith('render:')));
  });

  test('output is stable and sorted — the same site always fingerprints identically', () => {
    assert.deepEqual(computeSiteFingerprint(ELEVENTY), computeSiteFingerprint(ELEVENTY));
    assert.deepEqual(computeSiteFingerprint(ELEVENTY), [...computeSiteFingerprint(ELEVENTY)].sort());
  });

  test('PRIVACY: no token can carry a URL, domain, email or path', () => {
    // This row gets stored cross-tenant and is readable while deciding a
    // different client's repair, so this assertion is the wall.
    const fp = computeSiteFingerprint(ELEVENTY, { targetFilePath: 'src/pages/products/alpha.njk' });
    for (const token of fp) {
      assert.doesNotMatch(token, /https?:\/\//, `token leaked a URL: ${token}`);
      assert.doesNotMatch(token, /zunkireelabs|lifelinknepal|admizz/i, `token leaked a client name: ${token}`);
      assert.doesNotMatch(token, /@/, `token leaked an email: ${token}`);
      assert.doesNotMatch(token, /\//, `token leaked a path: ${token}`);
    }
  });
});

describe('fingerprintCompatible', () => {
  const eleventyNjk = computeSiteFingerprint(ELEVENTY, { targetFilePath: 'a.njk' });

  test('a site matches itself', () => {
    const result = fingerprintCompatible(eleventyNjk, eleventyNjk);
    assert.equal(result.ok, true);
    assert.equal(result.score, 1);
  });

  test('refuses across different generators', () => {
    const other = computeSiteFingerprint(NEXTJS, { targetFilePath: 'a.tsx' });
    const result = fingerprintCompatible(eleventyNjk, other);
    assert.equal(result.ok, false);
    assert.ok(result.missing.some((m) => m.startsWith('render:')));
  });

  test('refuses across different target extensions on the same generator', () => {
    const md = computeSiteFingerprint(ELEVENTY, { targetFilePath: 'a.md' });
    assert.equal(fingerprintCompatible(eleventyNjk, md).ok, false);
  });

  test('refuses when a required token is absent on EITHER side', () => {
    // A lesson learned before fingerprints existed, or a site with incomplete
    // renderCapabilities, must not read as "compatible with everything".
    const noRender = computeSiteFingerprint({ url_file_map: {} }, { targetFilePath: 'a.njk' });
    assert.equal(fingerprintCompatible(eleventyNjk, noRender).ok, false);
    assert.equal(fingerprintCompatible([], eleventyNjk).ok, false);
    assert.equal(fingerprintCompatible(eleventyNjk, []).ok, false);
  });

  test('names why it refused, so a dry run can explain itself', () => {
    const noRender = computeSiteFingerprint({ url_file_map: {} }, { targetFilePath: 'a.njk' });
    const { missing } = fingerprintCompatible(eleventyNjk, noRender);
    assert.ok(missing.some((m) => m.includes('unknown')));
  });

  test('a declared tech_stack conflict is disqualifying, a missing one is not', () => {
    const withStack = [...eleventyNjk, 'stack:eleventy'];
    const conflicting = [...eleventyNjk, 'stack:hugo'];
    assert.equal(fingerprintCompatible(withStack, conflicting).ok, false);
    // One side silent -> still compatible; this is why stack: is not required.
    assert.equal(fingerprintCompatible(withStack, eleventyNjk).ok, true);
  });

  test('optional-token differences lower the score but still match', () => {
    const fewerAdapters = eleventyNjk.filter((t) => !t.startsWith('adapter:'));
    const result = fingerprintCompatible(eleventyNjk, fewerAdapters);
    assert.equal(result.ok, true);
    assert.ok(result.score < 1 && result.score > 0);
  });
});

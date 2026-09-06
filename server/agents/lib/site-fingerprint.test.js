import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeSiteFingerprint, fingerprintCompatible } from './site-fingerprint.js';

// The fingerprint is what decides whether a repair proven on one client is
// allowed to run on another's repository. Two properties matter equally:
// it must REFUSE on any missing or conflicting required signal, and it must
// never carry client-identifying data (it is stored on a cross-tenant row).

const ALPHA_PAGE = 'https://zunkireelabs.com/products/alpha';

const ELEVENTY = {
  tech_stack: null,
  url_file_map: {
    renderCapabilities: {
      generator: 'eleventy',
      extensions: { '.njk': { markdown: false }, '.md': { markdown: true }, '.11ty.md': { markdown: true } },
    },
    // Keyed by PATHNAME, not the full URL — getPageEntry (url-file-map.js)
    // normalizes any pageUrl through `new URL(...).pathname` before looking
    // it up, so a full-URL key here would silently never match.
    pages: {
      '/products/alpha': {
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

  test('adds page-adapter for a (pageUrl, actionType) routed through an adapter', () => {
    const fp = computeSiteFingerprint(ELEVENTY, { pageUrl: ALPHA_PAGE, actionType: 'faq' });
    assert.ok(fp.includes('page-adapter:data-array-content'));
  });

  test('page-adapter is "none" for a (pageUrl, actionType) with no adapter — default routing is still a fact worth recording', () => {
    const fp = computeSiteFingerprint(ELEVENTY, { pageUrl: ALPHA_PAGE, actionType: 'meta-title' });
    assert.ok(fp.includes('page-adapter:none'));
  });

  test('omits page-adapter entirely when pageUrl/actionType are not given', () => {
    const fp = computeSiteFingerprint(ELEVENTY, { targetFilePath: 'src/pages/products/alpha.njk' });
    assert.ok(!fp.some((t) => t.startsWith('page-adapter:')));
  });

  test('pushes content-type when the caller resolved one', () => {
    const fp = computeSiteFingerprint(ELEVENTY, { contentType: 'blog' });
    assert.ok(fp.includes('content-type:blog'));
  });

  test('omits content-type entirely when the caller has no resolved classification', () => {
    const fp = computeSiteFingerprint(ELEVENTY, { targetFilePath: 'src/pages/products/alpha.njk' });
    assert.ok(!fp.some((t) => t.startsWith('content-type:')));
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

  test('AUDITED: never derives stack: from any other signal — only site.tech_stack, verbatim', () => {
    // ELEVENTY has a populated renderCapabilities.generator ('eleventy') and
    // real extensions/adapters, but tech_stack itself is null — no reliable
    // auto-detection of stack exists in this codebase (tech_stack is staff-
    // entered via connect-repo.js), so this must stay absent rather than be
    // guessed from render:/ext:/adapter: tokens that ARE available. A future
    // "helpful" heuristic here would let two sites that merely share a guess
    // register as a false stack: agreement, or a real one register as a
    // false conflict.
    const fp = computeSiteFingerprint(ELEVENTY, { targetFilePath: 'src/pages/products/alpha.njk', pageUrl: ALPHA_PAGE, actionType: 'meta-title', contentType: 'product' });
    assert.ok(!fp.some((t) => t.startsWith('stack:')), 'stack: must not be inferred from render:/ext:/adapter: signals');
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
  // Every real caller (fix-verification.js, learned-repair.js) always has a
  // pageUrl + actionType + a resolved contentType alongside targetFilePath,
  // so the fixture here does too — a fingerprint missing one of these
  // required tokens is the "learned before this token existed" / "still
  // unclassified" case covered separately below, not the normal path.
  const eleventyNjk = computeSiteFingerprint(ELEVENTY, { targetFilePath: 'a.njk', pageUrl: ALPHA_PAGE, actionType: 'meta-title', contentType: 'product' });

  test('a site matches itself', () => {
    const result = fingerprintCompatible(eleventyNjk, eleventyNjk);
    assert.equal(result.ok, true);
    assert.equal(result.score, 1);
  });

  test('TECHNICAL: refuses across different generators', () => {
    const other = computeSiteFingerprint(NEXTJS, { targetFilePath: 'a.tsx', pageUrl: ALPHA_PAGE, actionType: 'meta-title', contentType: 'product' });
    const result = fingerprintCompatible(eleventyNjk, other);
    assert.equal(result.ok, false);
    assert.ok(result.missing.some((m) => m.startsWith('render:')));
  });

  test('TECHNICAL: refuses across different target extensions on the same generator', () => {
    const md = computeSiteFingerprint(ELEVENTY, { targetFilePath: 'a.md', pageUrl: ALPHA_PAGE, actionType: 'meta-title', contentType: 'product' });
    assert.equal(fingerprintCompatible(eleventyNjk, md).ok, false);
  });

  test('STRUCTURAL: refuses across page-adapter routing even when generator/extension both match', () => {
    // Same site, same file type, but this action IS adapter-routed on one
    // side and default-routed (marker-merge) on the other — different write
    // mechanisms, must not read as portable.
    const adapterRouted = computeSiteFingerprint(ELEVENTY, { targetFilePath: 'a.njk', pageUrl: ALPHA_PAGE, actionType: 'faq', contentType: 'product' });
    const result = fingerprintCompatible(eleventyNjk, adapterRouted);
    assert.equal(result.ok, false);
    assert.ok(result.missing.some((m) => m.startsWith('page-adapter:')));
  });

  test('CONTENT-CONTEXT match: identical content-type on both sides is compatible', () => {
    const sameType = computeSiteFingerprint(ELEVENTY, { targetFilePath: 'a.njk', pageUrl: ALPHA_PAGE, actionType: 'meta-title', contentType: 'product' });
    assert.equal(fingerprintCompatible(eleventyNjk, sameType).ok, true);
  });

  test('CONTENT-CONTEXT mismatch (wrong page type): refuses even when every technical/structural token matches', () => {
    const wrongType = computeSiteFingerprint(ELEVENTY, { targetFilePath: 'a.njk', pageUrl: ALPHA_PAGE, actionType: 'meta-title', contentType: 'blog' });
    const result = fingerprintCompatible(eleventyNjk, wrongType);
    assert.equal(result.ok, false);
    assert.ok(result.missing.some((m) => m.startsWith('content-type:') && m.includes('product') && m.includes('blog')));
  });

  test('CONTENT-CONTEXT missing: an unclassified page (contentType omitted) refuses, never assumed compatible', () => {
    const unclassified = computeSiteFingerprint(ELEVENTY, { targetFilePath: 'a.njk', pageUrl: ALPHA_PAGE, actionType: 'meta-title' });
    const result = fingerprintCompatible(eleventyNjk, unclassified);
    assert.equal(result.ok, false);
    assert.ok(result.missing.some((m) => m.startsWith('content-type:') && m.includes('unknown')));
  });

  test('refuses when a required token is absent on EITHER side', () => {
    // A lesson learned before fingerprints existed, or a site with incomplete
    // renderCapabilities, must not read as "compatible with everything".
    const noRender = computeSiteFingerprint({ url_file_map: {} }, { targetFilePath: 'a.njk', pageUrl: ALPHA_PAGE, actionType: 'meta-title', contentType: 'product' });
    assert.equal(fingerprintCompatible(eleventyNjk, noRender).ok, false);
    assert.equal(fingerprintCompatible([], eleventyNjk).ok, false);
    assert.equal(fingerprintCompatible(eleventyNjk, []).ok, false);
  });

  test('names why it refused, so a dry run can explain itself', () => {
    const noRender = computeSiteFingerprint({ url_file_map: {} }, { targetFilePath: 'a.njk', pageUrl: ALPHA_PAGE, actionType: 'meta-title', contentType: 'product' });
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

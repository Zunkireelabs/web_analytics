import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const { probeUrl, probeMany, readCanonical, isSelfCanonical, createVariantProber } = await import('./live-probe.js');

const ok200 = (url) => ({ chain: [{ url, status: 200 }], finalStatus: 200, hops: 0, error: null });
const page = (canonical) => async () => ({ ok: true, html: `<html><head>${canonical ? `<link rel="canonical" href="${canonical}">` : ''}</head></html>` });

describe('probeUrl', () => {
  test('a clean 200 is live; its declared canonical is read and absolutized', async () => {
    const r = await probeUrl('https://a.com/x/', { checkCanonical: true, followRedirects: async (u) => ok200(u), fetchPage: page('/y/') });
    assert.equal(r.verdict, 'live');
    assert.equal(r.canonical, 'https://a.com/y/');
    assert.equal(isSelfCanonical(r), false);
  });

  test('a redirect is not live, and reports where it goes', async () => {
    const r = await probeUrl('https://a.com/x', {
      followRedirects: async () => ({ chain: [{ url: 'https://a.com/x', status: 301 }, { url: 'https://a.com/x/', status: 200 }], finalStatus: 200, hops: 1, error: null }),
    });
    assert.equal(r.verdict, 'redirect');
    assert.equal(r.redirectsTo, 'https://a.com/x/');
  });

  test('404 is dead; 403-after-retry and network errors are unverifiable, never dead', async () => {
    assert.equal((await probeUrl('https://a.com/', { followRedirects: async () => ({ chain: [], finalStatus: 404, hops: 0, error: null }) })).verdict, 'dead');
    assert.equal((await probeUrl('https://a.com/', { followRedirects: async () => ({ chain: [], finalStatus: 403, hops: 0, error: null, unverifiable: true }) })).verdict, 'unverifiable');
    assert.equal((await probeUrl('https://a.com/', { followRedirects: async () => ({ chain: [], finalStatus: null, hops: 0, error: 'network error' }) })).verdict, 'unverifiable');
    assert.equal((await probeUrl('https://a.com/', { followRedirects: async () => ({ chain: [], finalStatus: 500, hops: 0, error: null }) })).verdict, 'unverifiable');
  });

  test('an unreadable page cannot prove its canonical -> unverifiable', async () => {
    const r = await probeUrl('https://a.com/', { checkCanonical: true, followRedirects: async (u) => ok200(u), fetchPage: async () => ({ ok: false }) });
    assert.equal(r.verdict, 'unverifiable');
  });
});

describe('readCanonical / probeMany / createVariantProber', () => {
  test('no canonical tag is null, not unreadable', async () => {
    assert.deepEqual(await readCanonical('https://a.com/', { fetchPage: page(null) }), { canonical: null, unreadable: false });
  });

  test('probeMany respects the per-run cap', async () => {
    const urls = Array.from({ length: 10 }, (_, i) => `https://a.com/${i}`);
    const { results, skipped } = await probeMany(urls, { maxProbes: 3, probe: async (u) => ({ url: u, verdict: 'live' }) });
    assert.equal(results.length, 3);
    assert.equal(skipped.length, 7);
  });

  test('createVariantProber marks pages beyond the budget unverifiable and caches repeats', async () => {
    let calls = 0;
    const probeVariants = createVariantProber({ maxProbes: 2, probe: async (u) => { calls++; return { url: u, verdict: 'live' }; } });
    const m = await probeVariants(['https://a.com/1', 'https://a.com/2', 'https://a.com/3']);
    assert.equal(m.get('https://a.com/3').verdict, 'unverifiable');
    await probeVariants(['https://a.com/1']);
    assert.equal(calls, 2);
  });
});

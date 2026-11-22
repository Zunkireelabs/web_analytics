import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let hasBrokenLinkFix;
mock.module(resolve('../registry.js'), {
  namedExports: {
    getGenerator: async (id) => {
      if (id !== 'broken-link-fix') return null;
      return hasBrokenLinkFix
        ? { meta: { id: 'broken-link-fix' }, generate: async () => ({}), verifyCurrentState: hasBrokenLinkFix }
        : { meta: { id: 'broken-link-fix' }, generate: async () => ({}) };
    },
  },
});

const { verifyRecommendation, isAlreadyResolved, VERIFICATION_DECISION } = await import('./verification-layer.js');

describe('verifyRecommendation', () => {
  test('a generator with no verifyCurrentState keeps today\'s behavior exactly: still_valid, no evidence', async () => {
    hasBrokenLinkFix = null;
    const result = await verifyRecommendation({ recommendation_type: 'broken-link-fix' }, {});
    assert.deepEqual(result, { decision: 'still_valid', reason: 'no-verifier-available', evidence: null });
  });

  test('an unknown recommendation_type is treated the same as no verifier', async () => {
    const result = await verifyRecommendation({ recommendation_type: 'nonexistent-generator' }, {});
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'no-verifier-available');
  });

  test('passes through a generator\'s valid decision verbatim', async () => {
    hasBrokenLinkFix = async () => ({ decision: 'already_resolved', reason: 'confirmed-absent', evidence: { x: 1 } });
    const result = await verifyRecommendation({ recommendation_type: 'broken-link-fix' }, { site: {} });
    assert.deepEqual(result, { decision: 'already_resolved', reason: 'confirmed-absent', evidence: { x: 1 } });
  });

  test('a generator throwing is not evidence about the recommendation — falls back to still_valid', async () => {
    hasBrokenLinkFix = async () => { throw new Error('GitHub rate limit reached'); };
    const result = await verifyRecommendation({ recommendation_type: 'broken-link-fix' }, { site: {} });
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'verification-error');
    assert.match(result.evidence.error, /rate limit/);
  });

  test('a generator returning an invalid decision is treated as an error, not trusted verbatim', async () => {
    hasBrokenLinkFix = async () => ({ decision: 'definitely-fixed-trust-me' });
    const result = await verifyRecommendation({ recommendation_type: 'broken-link-fix' }, { site: {} });
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'verification-error');
  });
});

describe('isAlreadyResolved', () => {
  test('true only for the already_resolved decision', () => {
    assert.equal(isAlreadyResolved({ decision: VERIFICATION_DECISION.ALREADY_RESOLVED }), true);
    assert.equal(isAlreadyResolved({ decision: VERIFICATION_DECISION.STILL_VALID }), false);
    assert.equal(isAlreadyResolved(null), false);
  });
});

describe('verifyRecommendation: whose page is it, and has it moved?', () => {
  const siteWithApps = {
    website_domain: 'example.com',
    url_file_map: { mounts: [{ prefix: '/biz' }], otherApps: [{ name: 'shop-app', repo: 'org/shop-app', paths: ['/'], prefixes: ['/shop'] }] },
  };
  const noMove = async () => ({ ok: true, moved: false, finalUrl: 'x', hops: [] });

  test('a page served by another app is parked with the reason, never drafted', async () => {
    const r = await verifyRecommendation({ recommendation_type: 'schema', params: { page: 'https://example.com/shop/item' } }, { site: siteWithApps, resolvePageMove: noMove });
    assert.equal(r.decision, 'needs_human'); assert.equal(r.reason, 'page-served-by-another-app');
    assert.match(r.evidence.message, /shop-app/);
  });

  test('a page under the mount prefix is the connected repo\'s and continues to the normal check', async () => {
    hasBrokenLinkFix = null;
    const r = await verifyRecommendation({ recommendation_type: 'broken-link-fix', params: { page: 'https://example.com/biz/faq' } }, { site: siteWithApps, resolvePageMove: noMove });
    assert.equal(r.reason, 'no-verifier-available');
  });

  test('a page-bound recommendation whose page permanently moved is obsolete, with the new address as evidence', async () => {
    const moved = async () => ({ ok: true, moved: true, finalUrl: 'https://example.com/biz/blog/x', permanent: true, hops: [{ status: 308 }] });
    const r = await verifyRecommendation({ recommendation_type: 'internal-links', params: { page: 'https://example.com/blog/x' } }, { site: { website_domain: 'example.com' }, resolvePageMove: moved });
    assert.equal(r.decision, 'obsolete'); assert.equal(r.reason, 'page-moved');
    assert.equal(r.evidence.finalUrl, 'https://example.com/biz/blog/x'); assert.equal(r.evidence.status, 308);
  });

  test('a generator that is NOT page-bound is never judged by redirects (sitemap/redirect work targets the redirect itself)', async () => {
    let called = false;
    const moved = async () => { called = true; return { ok: true, moved: true, finalUrl: 'y', hops: [] }; };
    hasBrokenLinkFix = null;
    const r = await verifyRecommendation({ recommendation_type: 'broken-link-fix', params: { page: 'https://example.com/a' } }, { site: {}, resolvePageMove: moved });
    assert.equal(called, false); assert.equal(r.reason, 'no-verifier-available');
  });

  test('an unreadable redirect chain is not evidence of a move', async () => {
    const r = await verifyRecommendation({ recommendation_type: 'faq', params: { page: 'https://example.com/a' } }, { site: {}, resolvePageMove: async () => ({ ok: false, moved: false }) });
    assert.notEqual(r.decision, 'obsolete');
  });

  test('a redirect lookup that throws never breaks verification', async () => {
    const r = await verifyRecommendation({ recommendation_type: 'faq', params: { page: 'https://example.com/a' } }, { site: {}, resolvePageMove: async () => { throw new Error('x'); } });
    assert.notEqual(r.decision, 'obsolete');
  });
});

describe('verifyRecommendation: verified page source', () => {
  const rec = { recommendation_type: 'faq', params: { page: 'https://example.com/category/uk' } };
  const noMove = async () => ({ ok: true, moved: false, hops: [] });
  test('a shared-template page is stopped with an investigation request, never drafted', async () => {
    const r = await verifyRecommendation(rec, { site: {}, resolvePageMove: noMove, resolveSource: async () => ({ kind: 'shared-template', file: 'src/app/category/[slug]/page.tsx' }) });
    assert.equal(r.decision, 'needs_human'); assert.equal(r.reason, 'shared-template-page-specific-change');
  });
  test('a page with its own verified file continues to the normal check', async () => {
    hasBrokenLinkFix = null;
    const r = await verifyRecommendation(rec, { site: {}, resolvePageMove: noMove, resolveSource: async () => ({ kind: 'own-file', file: 'x.tsx' }) });
    assert.notEqual(r.decision, 'needs_human');
  });
  test('a verifier that throws never blocks', async () => {
    const r = await verifyRecommendation(rec, { site: {}, resolvePageMove: noMove, resolveSource: async () => { throw new Error('x'); } });
    assert.notEqual(r.decision, 'needs_human');
  });
});

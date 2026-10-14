import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
let mergeImpl;
mock.module(resolve('../implementers/backend.js'), {
  namedExports: { computeRedirectFixMerge: async (site, draft, ref) => mergeImpl(site, draft, ref) },
});
mock.module(resolve('../implementers/lib/github-ops.js'), {
  namedExports: { baseBranch: () => 'main' },
});

const { generate, meta, verifyCurrentState } = await import('./redirect-fix.js');

describe('redirect-fix generator', () => {
  test('passes through page/oldHref/newHref verbatim', async () => {
    const { content } = await generate({ params: { page: 'https://example.com/a', oldHref: '/old', newHref: 'https://example.com/new' } });
    assert.equal(content.oldHref, '/old');
    assert.equal(content.newHref, 'https://example.com/new');
  });

  test('requires page', async () => {
    await assert.rejects(() => generate({ params: { oldHref: '/old', newHref: 'https://example.com/new' } }));
  });

  test('requires both oldHref and newHref', async () => {
    await assert.rejects(() => generate({ params: { page: 'https://example.com/a', oldHref: '/old' } }));
  });

  test('rejects a malformed newHref', async () => {
    await assert.rejects(() => generate({ params: { page: 'https://example.com/a', oldHref: '/old', newHref: 'not a url' } }));
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'redirect-fix');
  });
});

describe('redirect-fix verifyCurrentState (server/generators/lib/verification-layer.js contract)', () => {
  const rec = { params: { page: 'https://example.com/a', oldHref: '/old', newHref: 'https://example.com/new' } };

  test('no site context: reports still_valid without guessing', async () => {
    const result = await verifyCurrentState(rec, {});
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'no-site-context');
  });

  test('missing params: reports still_valid without calling the implementer', async () => {
    mergeImpl = async () => { throw new Error('must not be called when params are missing'); };
    const result = await verifyCurrentState({ params: {} }, { site: {} });
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'missing-params');
  });

  test('oldHref no longer in the one mapped file: already_resolved — a single authoritative file makes this direct evidence, not merely inconclusive', async () => {
    mergeImpl = async () => ({ ok: false, reason: 'no-match', error: 'no href="/old" found', filePath: 'a.njk' });
    const result = await verifyCurrentState(rec, { site: {} });
    assert.equal(result.decision, 'already_resolved');
    assert.equal(result.reason, 'no-match');
  });

  test('still rewritable: still_valid, fixable-now', async () => {
    mergeImpl = async () => ({ ok: true, filePath: 'a.njk' });
    const result = await verifyCurrentState(rec, { site: {} });
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'fixable-now');
  });

  test('a real but different failure (e.g. a merge conflict marker) stays still_valid, not already_resolved', async () => {
    mergeImpl = async () => ({ ok: false, reason: 'merge-conflict-markers', error: 'conflict markers found' });
    const result = await verifyCurrentState(rec, { site: {} });
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'merge-conflict-markers');
  });
});

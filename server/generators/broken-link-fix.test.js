import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
let mergeImpl;
mock.module(resolve('../implementers/backend.js'), {
  namedExports: { computeBrokenLinkFixMerge: async (site, draft, ref) => mergeImpl(site, draft, ref) },
});
mock.module(resolve('../implementers/lib/github-ops.js'), {
  namedExports: { baseBranch: () => 'main' },
});

const { generate, meta, verifyCurrentState } = await import('./broken-link-fix.js');

describe('broken-link-fix generator', () => {
  test('passes through page/href verbatim, never fabricates a replacement', async () => {
    const { content } = await generate({ params: { page: 'https://example.com/a', href: '/dead' } });
    assert.equal(content.page, 'https://example.com/a');
    assert.equal(content.href, '/dead');
    assert.deepEqual(content.sourcePages, ['https://example.com/a']); // defaults to [page]
    assert.equal(Object.keys(content).length, 3); // no invented target field
  });

  test('forwards sourcePages when the crawler found the href on multiple pages', async () => {
    const { content } = await generate({
      params: { page: 'https://example.com/a', href: '/dead', sourcePages: ['https://example.com/a', 'https://example.com/b'] },
    });
    assert.deepEqual(content.sourcePages, ['https://example.com/a', 'https://example.com/b']);
  });

  test('requires page', async () => {
    await assert.rejects(() => generate({ params: { href: '/dead' } }));
  });

  test('requires href', async () => {
    await assert.rejects(() => generate({ params: { page: 'https://example.com/a' } }));
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'broken-link-fix');
  });
});

describe('broken-link-fix verifyCurrentState (server/generators/lib/verification-layer.js contract)', () => {
  const rec = { params: { page: 'https://example.com/a', href: '/dead' } };

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

  test('implementer confirms the href is hardcoded nowhere in the repo: already_resolved', async () => {
    mergeImpl = async () => ({ ok: false, reason: 'confirmed-absent', stale: true, error: 'gone', attempted: [] });
    const result = await verifyCurrentState(rec, { site: {} });
    assert.equal(result.decision, 'already_resolved');
    assert.equal(result.reason, 'confirmed-absent');
  });

  test('implementer can strip it right now: still_valid, fixable-now', async () => {
    mergeImpl = async () => ({ ok: true, files: [{ filePath: 'a.njk' }], attempted: [] });
    const result = await verifyCurrentState(rec, { site: {} });
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'fixable-now');
    assert.deepEqual(result.evidence.files, ['a.njk']);
  });

  test('a real but inconclusive failure (e.g. no-file-mapping) stays still_valid — a config gap is not proof the recommendation is resolved', async () => {
    mergeImpl = async () => ({ ok: false, reason: 'no-file-mapping', stale: false, error: 'no mapping', attempted: [] });
    const result = await verifyCurrentState(rec, { site: {} });
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'no-file-mapping');
  });
});

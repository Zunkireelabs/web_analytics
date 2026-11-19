import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://x:x@127.0.0.1:1/x';
const { assertAnchorPatchable } = await import('./schema-repair.js');

const deps = (content, extra = {}) => ({
  fetchSite: async () => ({ id: 1 }),
  resolve: () => 'src/areas/trust.njk',
  fetchFile: async () => (content == null ? null : { content }),
  branchOf: () => 'main',
  ...extra,
});

test('passes when the rendered block is in the source exactly once', async () => {
  await assert.doesNotReject(assertAnchorPatchable(1, '/p/', '{"a":1}', deps('x {"a":1} y')));
});

test('refuses (as a refusal, not a failure) when the source is templated and lacks the text', async () => {
  await assert.rejects(
    assertAnchorPatchable(1, '/p/', '{"name":"Chayce"}', deps('{"name":"{{ site.name }}"}')),
    (e) => e.refusal === true && e.reason === 'source-anchor-not-found' && e.status === 400 && /by hand/.test(e.message),
  );
});

test('refuses when the block appears twice (ambiguous)', async () => {
  await assert.rejects(assertAnchorPatchable(1, '/p/', 'dup', deps('dup and dup')), (e) => e.refusal === true);
});

test('skips the check when the source cannot be read, leaving the apply step as authority', async () => {
  await assert.doesNotReject(assertAnchorPatchable(1, '/p/', 'x', deps(null)));
  await assert.doesNotReject(assertAnchorPatchable(1, '/p/', 'x', deps('', { fetchFile: async () => { throw new Error('github down'); } })));
});

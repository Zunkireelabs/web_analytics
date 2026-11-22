import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://x:x@127.0.0.1:1/x';
const { verifyCurrentState } = await import('./schema-repair.js');

const rec = { id: 9, site_id: 1, recommendation_type: 'schema-repair', params: { page: 'https://admizz.test/contact/' } };
const analysis = (over = {}) => ({ ok: true, analysis: { malformedSchemaBlocks: [], duplicateSchemaTypes: [], schemaScriptBlocks: [], ...over } });
const block = (raw, types) => ({ raw, types });
const anchorDeps = (content) => ({ fetchSite: async () => ({ id: 1 }), resolve: () => 'src/pages/contact.tsx', fetchFile: async () => (content == null ? null : { content }), branchOf: () => 'main' });
const ctx = (analyze, content) => ({ site: { id: 1 }, analyze, anchorDeps: anchorDeps(content) });

test('nothing malformed or duplicate on the live page → already_resolved, with the evidence that proves it', async () => {
  const r = await verifyCurrentState(rec, ctx(async () => analysis({ schemaScriptBlocks: [block('{}', ['Organization'])] }), 'x'));
  assert.equal(r.decision, 'already_resolved');
  assert.equal(r.evidence.page, rec.params.page);
  assert.ok(r.evidence.checkedAt);
});

test('a duplicate that is NOT in the page file (shared layout) → needs_human with a site-level explanation, never a per-page fix', async () => {
  const dupes = [block('{"@type":"LocalBusiness","a":1}', ['LocalBusiness']), block('{"@type":"LocalBusiness","a":2}', ['LocalBusiness'])];
  const r = await verifyCurrentState(rec, ctx(async () => analysis({ duplicateSchemaTypes: ['LocalBusiness'], schemaScriptBlocks: dupes }), '<Layout />'));
  assert.equal(r.decision, 'needs_human');
  assert.equal(r.reason, 'shared-layout-schema');
  assert.match(r.evidence.message, /shared template or layout/);
});

test('a genuine duplicate that IS in the page file stays valid (and patchable)', async () => {
  const dupes = [block('{"a":1}', ['Thing']), block('{"a":2}', ['Thing'])];
  const r = await verifyCurrentState(rec, ctx(async () => analysis({ duplicateSchemaTypes: ['Thing'], schemaScriptBlocks: dupes }), 'x {"a":2} y'));
  assert.equal(r.decision, 'still_valid');
  assert.equal(r.reason, 'confirmed-on-live-page-and-patchable');
});

test('a live check that fails is never evidence the issue is gone', async () => {
  assert.equal((await verifyCurrentState(rec, ctx(async () => ({ ok: false, error: 'timeout' }), 'x'))).decision, 'still_valid');
  assert.equal((await verifyCurrentState(rec, ctx(async () => { throw new Error('boom'); }, 'x'))).decision, 'still_valid');
});

test('a source that cannot be read leaves the recommendation valid rather than guessing', async () => {
  const dupes = [block('{"a":1}', ['Thing']), block('{"a":2}', ['Thing'])];
  const r = await verifyCurrentState(rec, ctx(async () => analysis({ duplicateSchemaTypes: ['Thing'], schemaScriptBlocks: dupes }), null));
  assert.equal(r.decision, 'still_valid');
});

test('works for any site: no site-specific assumption, only the page and its own source', async () => {
  const other = { ...rec, site_id: 2, params: { page: 'https://other.test/about/' } };
  const r = await verifyCurrentState(other, ctx(async () => analysis({ schemaScriptBlocks: [block('{}', ['Organization'])] }), 'x'));
  assert.equal(r.decision, 'already_resolved');
  assert.equal(r.evidence.page, 'https://other.test/about/');
});

test('a page that shows NO structured data at all (challenge/error page) is never taken as proof the issue is fixed', async () => {
  const r = await verifyCurrentState(rec, ctx(async () => analysis({ schemaScriptBlocks: [] }), 'x'));
  assert.equal(r.decision, 'still_valid');
  assert.equal(r.reason, 'no-structured-data-seen');
});

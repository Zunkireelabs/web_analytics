import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { merge3 } from './json-merge3.js';

describe('merge3 — recovering a refused url_file_map write without losing either change', () => {
  const base = { _rev: 4, pages: { '/a': 'a.njk' }, siteRoot: { designProfile: { v: 1 }, componentTemplates: { faq: 'x' } } };
  test('two writers changing DIFFERENT parts both survive', () => {
    const theirs = { ...base, _rev: 5, siteRoot: { ...base.siteRoot, componentTemplates: { faq: 'NEW' } } };
    const ours = { ...base, siteRoot: { ...base.siteRoot, designProfile: { v: 2 } } };
    const { merged, conflicts } = merge3(base, theirs, ours);
    assert.deepEqual(conflicts, []);
    assert.equal(merged.siteRoot.componentTemplates.faq, 'NEW');
    assert.deepEqual(merged.siteRoot.designProfile, { v: 2 });
    assert.equal(merged._rev, 5, 'revision comes from the current row');
  });
  test('deletions are preserved in both directions', () => {
    const theirs = { ...base, _rev: 5, pages: {} };
    const ours = { ...base, siteRoot: { ...base.siteRoot, extra: 1 } };
    const { merged } = merge3(base, theirs, ours);
    assert.deepEqual(merged.pages, {}); assert.equal(merged.siteRoot.extra, 1);
  });
  test('the SAME value changed differently is a conflict, reported by path, never guessed', () => {
    const theirs = { ...base, _rev: 5, siteRoot: { ...base.siteRoot, designProfile: { v: 3 } } };
    const ours = { ...base, siteRoot: { ...base.siteRoot, designProfile: { v: 2 } } };
    assert.deepEqual(merge3(base, theirs, ours).conflicts, ['siteRoot.designProfile.v']);
  });
  test('identical changes on both sides are not a conflict; arrays are atomic', () => {
    const theirs = { ...base, list: [1, 2] }; const ours = { ...base, list: [1, 2] };
    assert.deepEqual(merge3(base, theirs, ours).conflicts, []);
    assert.deepEqual(merge3({ l: [1] }, { l: [1, 2] }, { l: [1, 3] }).conflicts, ['l']);
  });
});

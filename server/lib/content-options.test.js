import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_OPTIONS, optionKeysFor, validatePick, validatePickBatch } from './content-options.js';

test('every kind of content offers three options, A to C, each with a name and a plain note', () => {
  for (const [id, c] of Object.entries(CONTENT_OPTIONS)) {
    assert.deepEqual(c.options.map((o) => o.key), ['A', 'B', 'C'], id);
    for (const o of c.options) { assert.ok(o.name && o.note, `${id} ${o.key}`); }
  }
});

test('a pick must be for content that has options and for one of its keys', () => {
  assert.deepEqual(validatePick({ generatorId: 'landing-page', optionKey: 'B' }), { ok: true });
  assert.equal(validatePick({ generatorId: 'landing-page', optionKey: 'Z' }).ok, false);
  assert.equal(validatePick({ generatorId: 'security-headers', optionKey: 'A' }).ok, false);
  assert.equal(validatePick({}).ok, false);
  assert.deepEqual(optionKeysFor('nope'), []);
});

test('no option makes a claim about a particular client (the catalog is generic)', () => {
  const text = JSON.stringify(CONTENT_OPTIONS).toLowerCase();
  for (const bad of ['closest to your site', 'matches your', 'your existing']) assert.ok(!text.includes(bad), bad);
});

test('a batch is checked as a whole before any of it is saved', () => {
  const ok = (id, g = 'landing-page', k = 'B') => ({ findingId: id, generatorId: g, optionKey: k });
  assert.deepEqual(validatePickBatch([ok('a'), ok('b', 'translation', 'C'), ok('c', 'blog-outline', 'A')]), { ok: true });
  assert.equal(validatePickBatch([]).ok, false, 'nothing selected');
  assert.equal(validatePickBatch('x').ok, false);
  const bad = validatePickBatch([ok('a'), ok('b', 'landing-page', 'Z')]);
  assert.equal(bad.ok, false); assert.equal(bad.index, 1, 'it says which one is wrong');
  assert.equal(validatePickBatch([ok('a'), ok('a')]).ok, false, 'the same item twice');
  assert.equal(validatePickBatch([ok('a', 'security-headers', 'A')]).ok, false, 'an item with no options');
  assert.equal(validatePickBatch(Array.from({ length: 101 }, (_, i) => ok(`f${i}`))).ok, false);
});

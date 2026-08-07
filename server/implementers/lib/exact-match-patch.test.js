import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { countOccurrences, applyExactMatchPatches, describePatchFailure } from './exact-match-patch.js';

describe('countOccurrences', () => {
  test('counts non-overlapping matches', () => {
    assert.equal(countOccurrences('abcabcabc', 'abc'), 3);
  });

  test('zero for no match', () => {
    assert.equal(countOccurrences('hello', 'xyz'), 0);
  });

  test('zero for an empty needle', () => {
    assert.equal(countOccurrences('hello', ''), 0);
  });
});

describe('applyExactMatchPatches', () => {
  test('replaces a single unique anchor', () => {
    const result = applyExactMatchPatches('before {"a":1} after', [{ anchor: '{"a":1}', replacement: '{"a":2}' }]);
    assert.equal(result.ok, true);
    assert.equal(result.content, 'before {"a":2} after');
  });

  test('refuses when the anchor is missing entirely', () => {
    const result = applyExactMatchPatches('before after', [{ anchor: '{"a":1}', replacement: '{"a":2}' }]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['{"a":1}']);
    assert.deepEqual(result.ambiguous, []);
  });

  test('refuses when the anchor is ambiguous (appears more than once)', () => {
    const result = applyExactMatchPatches('x{"a":1}y{"a":1}z', [{ anchor: '{"a":1}', replacement: '{"a":2}' }]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.ambiguous, ['{"a":1}']);
  });

  test('all-or-nothing: one bad anchor in a batch blocks every edit, none applied', () => {
    const content = 'AAA BBB';
    const result = applyExactMatchPatches(content, [
      { anchor: 'AAA', replacement: 'XXX' },
      { anchor: 'ZZZ', replacement: 'YYY' },
    ]);
    assert.equal(result.ok, false);
  });

  test('multiple valid, non-conflicting anchors all get replaced', () => {
    const result = applyExactMatchPatches('AAA BBB', [
      { anchor: 'AAA', replacement: 'XXX' },
      { anchor: 'BBB', replacement: 'YYY' },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.content, 'XXX YYY');
  });
});

describe('describePatchFailure', () => {
  test('mentions the file path and prompts regeneration', () => {
    const msg = describePatchFailure('src/blog/post.md', { missing: ['a'], ambiguous: [] });
    assert.match(msg, /src\/blog\/post\.md/);
    assert.match(msg, /regenerate/i);
  });
});

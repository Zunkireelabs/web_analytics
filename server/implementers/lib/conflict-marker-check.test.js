import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectConflictMarkers } from './conflict-marker-check.js';

// Regression coverage for a real production incident (2026-07-28): a human
// resolving a GitHub merge conflict left raw conflict markers committed
// into zunkireelabs-web's main, and this tool's own marker-merge silently
// spliced new content on top of it, compounding the corruption across
// several later drafts before it was caught. This is the guard that now
// stops that from ever happening silently again.

describe('detectConflictMarkers', () => {
  test('clean, normal file content returns null', () => {
    assert.equal(detectConflictMarkers('<html><body>hello</body></html>'), null);
  });

  test('detects a bare "=======" conflict marker on its own line', () => {
    const content = 'some real content\n=======\nmore content';
    const result = detectConflictMarkers(content);
    assert.notEqual(result, null);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'conflict-markers');
    assert.match(result.error, /=======/);
  });

  test('detects "<<<<<<<" with a ref name (e.g. "<<<<<<< HEAD")', () => {
    const result = detectConflictMarkers('line one\n<<<<<<< HEAD\nline two');
    assert.notEqual(result, null);
    assert.match(result.error, /<<<<<<</);
  });

  test('detects ">>>>>>>" with a branch name suffix', () => {
    const result = detectConflictMarkers('line one\n>>>>>>> feature-branch\nline two');
    assert.notEqual(result, null);
  });

  test('reports the correct 1-indexed line number', () => {
    const content = 'line1\nline2\nline3\n=======\nline5';
    const result = detectConflictMarkers(content);
    assert.match(result.error, /line 4/);
  });

  test('does not false-positive on unrelated repeated characters mid-line', () => {
    // "=======" must be the whole line (or start it with trailing text),
    // not just present somewhere inside a longer line.
    assert.equal(detectConflictMarkers('const x = "======="; // just a string'), null);
  });

  test('does not false-positive on fewer than 7 repeats', () => {
    assert.equal(detectConflictMarkers('someline\n======\nmore'), null); // only 6
  });

  test('non-string input returns null rather than throwing', () => {
    assert.equal(detectConflictMarkers(null), null);
    assert.equal(detectConflictMarkers(undefined), null);
  });
});

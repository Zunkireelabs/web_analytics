import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setViewportMeta, getViewportMeta } from './viewport-inject.js';

const CORRECT = 'width=device-width, initial-scale=1';

describe('setViewportMeta', () => {
  test('inserts a new tag right after <head> when none exists', () => {
    const file = '<html>\n<head>\n<title>Site</title>\n</head>\n<body></body>\n</html>';
    const result = setViewportMeta(file, CORRECT);
    assert.equal(result.ok, true);
    assert.match(result.newContent, new RegExp(`<head>\\s*<meta name="viewport" content="${CORRECT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">`));
    assert.match(result.newContent, /<title>Site<\/title>/);
  });

  test('replaces content on an existing misconfigured tag', () => {
    const file = '<head><meta name="viewport" content="width=1024"></head>';
    const result = setViewportMeta(file, CORRECT);
    assert.equal(result.ok, true);
    assert.match(result.newContent, new RegExp(`content="${CORRECT}"`));
    assert.doesNotMatch(result.newContent, /width=1024/);
  });

  test('replaces a zoom-blocking tag, dropping user-scalable=no', () => {
    const file = '<head><meta name="viewport" content="width=device-width, user-scalable=no"></head>';
    const result = setViewportMeta(file, CORRECT);
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.newContent, /user-scalable/);
  });

  test('honest no-op when the tag already matches', () => {
    const file = `<head><meta name="viewport" content="${CORRECT}"></head>`;
    const result = setViewportMeta(file, CORRECT);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'viewport-already-correct');
  });

  test('fails honestly with no-head-tag when there is no <head>', () => {
    const result = setViewportMeta('<div>not a layout file</div>', CORRECT);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-head-tag');
  });

  test('only touches the viewport tag, rest of file untouched', () => {
    const file = '<html>\n<head>\n<title>Real Site</title>\n</head>\n<body>content</body>\n</html>\n';
    const result = setViewportMeta(file, CORRECT);
    assert.equal(result.newContent, `<html>\n<head><meta name="viewport" content="${CORRECT}">\n<title>Real Site</title>\n</head>\n<body>content</body>\n</html>\n`);
  });
});

describe('getViewportMeta', () => {
  test('reads the live tag verbatim', () => {
    assert.equal(getViewportMeta(`<meta name="viewport" content="${CORRECT}">`), `<meta name="viewport" content="${CORRECT}">`);
  });

  test('returns null when absent', () => {
    assert.equal(getViewportMeta('<div>no viewport tag</div>'), null);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { injectHtmlLang, getHtmlTag } from './html-lang-inject.js';

describe('injectHtmlLang', () => {
  test('injects lang when genuinely absent', () => {
    const result = injectHtmlLang('<html>\n<head></head>\n<body></body>\n</html>', 'en');
    assert.equal(result.ok, true);
    assert.match(result.newContent, /<html lang="en">/);
  });

  test('preserves other existing attributes on the tag', () => {
    const result = injectHtmlLang('<html class="no-js" data-theme="dark">', 'en');
    assert.equal(result.ok, true);
    assert.equal(result.newContent.startsWith('<html lang="en" class="no-js" data-theme="dark">'), true);
  });

  test('refuses to overwrite a literal existing lang attribute', () => {
    const result = injectHtmlLang('<html lang="fr">', 'en');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'lang-already-present');
  });

  test('refuses to overwrite a templated lang attribute', () => {
    const result = injectHtmlLang('<html lang="{{ locale }}">', 'en');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'lang-already-present');
  });

  test('fails honestly when there is no <html> tag at all', () => {
    const result = injectHtmlLang('<div>not a layout file</div>', 'en');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-html-tag');
  });

  test('only touches the tag, leaves the rest of the file byte-for-byte identical', () => {
    const file = '<!DOCTYPE html>\n<html>\n<head><title>Real Site</title></head>\n<body>content</body>\n</html>\n';
    const result = injectHtmlLang(file, 'en');
    assert.equal(result.newContent, '<!DOCTYPE html>\n<html lang="en">\n<head><title>Real Site</title></head>\n<body>content</body>\n</html>\n');
  });
});

describe('getHtmlTag', () => {
  test('reads the live tag verbatim', () => {
    assert.equal(getHtmlTag('<html lang="en" class="no-js">'), '<html lang="en" class="no-js">');
  });

  test('returns null when absent', () => {
    assert.equal(getHtmlTag('<div>no html tag</div>'), null);
  });
});

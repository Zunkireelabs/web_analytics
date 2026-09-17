import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildFrontMatterExcludeEdit } from './sitemap-frontmatter-exclude-inject.js';
import { applyExactMatchPatches } from './exact-match-patch.js';

describe('buildFrontMatterExcludeEdit', () => {
  test('inserts the field as a new line right before the closing ---', () => {
    const content = '---\ntitle: A page\ndate: 2026-01-01\n---\n\n# Body\n';
    const edit = buildFrontMatterExcludeEdit(content, 'excludeFromSitemap');
    assert.equal(edit.ok, true);
    assert.equal(edit.replacement, '---\ntitle: A page\ndate: 2026-01-01\nexcludeFromSitemap: true\n---\n');
  });

  test('the produced edit actually applies via applyExactMatchPatches, preserving the rest of the file verbatim', () => {
    const content = '---\ntitle: A page\ndate: 2026-01-01\n---\n\n# Body\nSome real content with its own --- horizontal rule below.\n\n---\n';
    const edit = buildFrontMatterExcludeEdit(content, 'excludeFromSitemap');
    assert.equal(edit.ok, true);
    const patched = applyExactMatchPatches(content, [{ anchor: edit.anchor, replacement: edit.replacement }]);
    assert.equal(patched.ok, true);
    assert.equal(
      patched.content,
      '---\ntitle: A page\ndate: 2026-01-01\nexcludeFromSitemap: true\n---\n\n# Body\nSome real content with its own --- horizontal rule below.\n\n---\n'
    );
  });

  test('preserves CRLF line endings when the file already uses them', () => {
    const content = '---\r\ntitle: A page\r\n---\r\n\r\nBody\r\n';
    const edit = buildFrontMatterExcludeEdit(content, 'excludeFromSitemap');
    assert.equal(edit.ok, true);
    assert.equal(edit.replacement, '---\r\ntitle: A page\r\nexcludeFromSitemap: true\r\n---\r\n');
  });

  test('refuses when the file has no leading front-matter block at all', () => {
    const content = '<html><body>No front matter here</body></html>';
    const edit = buildFrontMatterExcludeEdit(content, 'excludeFromSitemap');
    assert.equal(edit.ok, false);
    assert.equal(edit.reason, 'no-front-matter');
  });

  test('does not mistake a body horizontal rule for front matter — only a delimiter at the very start of the file counts', () => {
    const content = '# A page with no front matter\n\nSome text.\n\n---\n\nMore text after a horizontal rule.\n';
    const edit = buildFrontMatterExcludeEdit(content, 'excludeFromSitemap');
    assert.equal(edit.ok, false);
    assert.equal(edit.reason, 'no-front-matter');
  });

  test('refuses as already-resolved when the field is already set, rather than adding a second line', () => {
    const content = '---\ntitle: A page\nexcludeFromSitemap: true\n---\n\nBody\n';
    const edit = buildFrontMatterExcludeEdit(content, 'excludeFromSitemap');
    assert.equal(edit.ok, false);
    assert.equal(edit.reason, 'already-resolved');
  });

  test('a different field name in front matter does not false-positive as already-resolved', () => {
    const content = '---\ntitle: A page\nexcludeFromSearch: true\n---\n\nBody\n';
    const edit = buildFrontMatterExcludeEdit(content, 'excludeFromSitemap');
    assert.equal(edit.ok, true);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withAlt } from './alt-text-inject.js';
import { applyExactMatchPatches } from './exact-match-patch.js';

describe('withAlt', () => {
  test('inserts alt="" right after the tag name, before existing attributes', () => {
    assert.equal(withAlt('<img src="/a.jpg">', 'A real description'), '<img alt="A real description" src="/a.jpg">');
  });

  test('works on a self-closing tag', () => {
    assert.equal(withAlt('<img src="/a.jpg" />', 'A photo'), '<img alt="A photo" src="/a.jpg" />');
  });

  test('escapes double quotes in the alt text', () => {
    assert.equal(withAlt('<img src="/a.jpg">', 'A "quoted" caption'), '<img alt="A &quot;quoted&quot; caption" src="/a.jpg">');
  });

  test('is case-insensitive on the tag name', () => {
    assert.equal(withAlt('<IMG src="/a.jpg">', 'Photo'), '<IMG alt="Photo" src="/a.jpg">');
  });
});

// Integration-shaped check: a real alt-text draft's items array feeds
// exact-match-patch.js exactly like schema-repair-inject.js's edits do —
// pins that the two modules compose correctly for the all-or-nothing
// refusal behavior a multi-image draft depends on.
describe('alt-text patch batch (withAlt + applyExactMatchPatches)', () => {
  test('patches every image when every anchor is still exact and unique', () => {
    const source = '<div><img src="/a.jpg"></div><div><img src="/b.jpg"></div>';
    const items = [
      { originalTag: '<img src="/a.jpg">', alt: 'Caption A' },
      { originalTag: '<img src="/b.jpg">', alt: 'Caption B' },
    ];
    const edits = items.map((item) => ({ anchor: item.originalTag, replacement: withAlt(item.originalTag, item.alt) }));
    const result = applyExactMatchPatches(source, edits);
    assert.equal(result.ok, true);
    assert.match(result.content, /<img alt="Caption A" src="\/a\.jpg">/);
    assert.match(result.content, /<img alt="Caption B" src="\/b\.jpg">/);
  });

  test('refuses the WHOLE batch if even one image\'s anchor no longer matches (source drifted)', () => {
    const source = '<div><img src="/a.jpg"></div>'; // /b.jpg no longer present
    const items = [
      { originalTag: '<img src="/a.jpg">', alt: 'Caption A' },
      { originalTag: '<img src="/b.jpg">', alt: 'Caption B' },
    ];
    const edits = items.map((item) => ({ anchor: item.originalTag, replacement: withAlt(item.originalTag, item.alt) }));
    const result = applyExactMatchPatches(source, edits);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['<img src="/b.jpg">']);
  });
});

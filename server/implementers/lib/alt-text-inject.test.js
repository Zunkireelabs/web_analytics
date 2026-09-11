import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withAlt, applyAltTextDataSourceEdit } from './alt-text-inject.js';
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

describe('applyAltTextDataSourceEdit', () => {
  // Same shape as zunkireelabs-web's real servicesDetails.json (verified
  // live 2026-09-11) — a shared layout renders `src="{{ service.heroImage
  // }}"` with a hardcoded `alt=""`, so the fix belongs in this data file,
  // never in the page's own (front-matter-only) template file.
  const servicesDetails = JSON.stringify({
    'data-systems': { id: 'data-systems', title: 'Data Systems', heroImage: '/assets/images/data-systems-hero.webp' },
    'web-development': { id: 'web-development', title: 'Web Development', heroImage: '/assets/images/web-development-hero.webp', heroAlt: 'Existing alt text' },
  }, null, 2);

  const source = { dataFile: 'src/_data/servicesDetails.json', altField: 'heroAlt', format: 'json-array' };

  test('inserts a brand-new heroAlt field, leaves every other field untouched', () => {
    const result = applyAltTextDataSourceEdit(servicesDetails, 'https://example.com/services/data-systems/', 'Hero image for data systems section', source);
    assert.equal(result.ok, true);
    const reparsed = JSON.parse(result.newContent);
    assert.equal(reparsed['data-systems'].heroAlt, 'Hero image for data systems section');
    assert.equal(reparsed['data-systems'].heroImage, '/assets/images/data-systems-hero.webp');
    assert.equal(reparsed['web-development'].heroAlt, 'Existing alt text');
  });

  test('an entry that already has real alt text is reported already-resolved, never overwritten', () => {
    const result = applyAltTextDataSourceEdit(servicesDetails, 'https://example.com/services/web-development/', 'A different caption', source);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'already-resolved');
    assert.match(result.error, /nothing left to apply/);
    // The field must be byte-for-byte untouched, not silently replaced.
    const reparsed = JSON.parse(servicesDetails);
    assert.equal(reparsed['web-development'].heroAlt, 'Existing alt text');
  });

  test('an unknown page id is a clean no-match, not a crash', () => {
    const result = applyAltTextDataSourceEdit(servicesDetails, 'https://example.com/services/does-not-exist/', 'Alt text', source);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-match');
  });

  test('a page URL with no derivable id (e.g. the bare origin) refuses rather than crashing', () => {
    const result = applyAltTextDataSourceEdit(servicesDetails, 'https://example.com/', 'Alt text', source);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-file-mapping');
  });

  test('re-applying after a successful insert is idempotent (second call is already-resolved)', () => {
    const first = applyAltTextDataSourceEdit(servicesDetails, 'https://example.com/services/data-systems/', 'Hero image for data systems section', source);
    assert.equal(first.ok, true);
    const second = applyAltTextDataSourceEdit(first.newContent, 'https://example.com/services/data-systems/', 'A totally different caption', source);
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'already-resolved');
    assert.equal(JSON.parse(first.newContent)['data-systems'].heroAlt, 'Hero image for data systems section');
  });
});

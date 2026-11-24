import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hasDangerousReference, findIdScopesInOrder, classifyScopeCountMismatch, applyScopeRenames, classifyIdMentions, planOwnedIdRemoval } from './duplicate-id-inject.js';

const twoIdenticalIcons = `
<div class="icon-wrap">
  <svg viewBox="0 0 24 24"><linearGradient id="aiGradient" x1="3" y1="2" x2="21" y2="22"><stop offset="0%" stop-color="#4285F4"></stop></linearGradient><path fill="url(#aiGradient)" d="M1 1h1v1z"/></svg>
</div>
<div class="icon-wrap-2">
  <svg viewBox="0 0 24 24"><linearGradient id="aiGradient" x1="3" y1="2" x2="21" y2="22"><stop offset="0%" stop-color="#4285F4"></stop></linearGradient><path fill="url(#aiGradient)" d="M1 1h1v1z"/></svg>
</div>
`;

describe('classifyScopeCountMismatch', () => {
  test('1 live occurrence, down from a drafted duplicate, is resolved', () => {
    // Real incident, site 1 (2026-09-09 to 2026-09-11): a fix plan drafted
    // against 5 occurrences of id="service-icon-gradient" kept failing
    // "not provably safe" for days after another draft had already
    // deduplicated it down to 1 — the only occurrence a duplicate-id fix
    // could ever leave once it succeeds.
    assert.equal(classifyScopeCountMismatch([{ start: 0, end: 1 }], 5), 'resolved');
  });

  test('1 live occurrence is only resolved when the plan was drafted against MORE than 1', () => {
    // A plan can't have been drafted for a genuine duplicate at all if it
    // only ever recorded 1 occurrence — this shouldn't be reachable in
    // practice (draft generation requires 2+ to call it a duplicate), but
    // the function must not call a same-count non-mismatch "resolved".
    assert.equal(classifyScopeCountMismatch([{ start: 0, end: 1 }], 1), 'changed');
  });

  test('any other live count stays "changed", genuinely ambiguous', () => {
    assert.equal(classifyScopeCountMismatch([{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }], 5), 'changed');
  });

  test('null scopes (id not found at all) is "changed", never "resolved"', () => {
    // Zero occurrences isn't proof the duplicate was fixed — the id could
    // have been renamed or removed entirely, which is a different claim.
    assert.equal(classifyScopeCountMismatch(null, 5), 'changed');
  });
});

describe('hasDangerousReference', () => {
  test('false for a plain url(#id) paint reference', () => {
    const file = '<svg><linearGradient id="aiGradient"></linearGradient><path fill="url(#aiGradient)"/></svg>';
    assert.equal(hasDangerousReference(file, 'aiGradient'), false);
  });

  test('true when a CSS selector targets the id', () => {
    const file = '<svg><linearGradient id="aiGradient"></linearGradient></svg><style>#aiGradient{opacity:.5}</style>';
    assert.equal(hasDangerousReference(file, 'aiGradient'), true);
  });

  test('true when getElementById targets the id', () => {
    const file = '<svg><linearGradient id="aiGradient"></linearGradient></svg><script>document.getElementById("aiGradient")</script>';
    assert.equal(hasDangerousReference(file, 'aiGradient'), true);
  });

  test('true when querySelector targets the id', () => {
    const file = '<svg><linearGradient id="aiGradient"></linearGradient></svg><script>document.querySelector("#aiGradient")</script>';
    assert.equal(hasDangerousReference(file, 'aiGradient'), true);
  });

  test('true when an anchor links to the id', () => {
    const file = '<svg><linearGradient id="aiGradient"></linearGradient></svg><a href="#aiGradient">jump</a>';
    assert.equal(hasDangerousReference(file, 'aiGradient'), true);
  });
});

describe('findIdScopesInOrder + applyScopeRenames', () => {
  test('locates each occurrence\'s own <svg> block in document order', () => {
    const scopes = findIdScopesInOrder(twoIdenticalIcons, 'aiGradient');
    assert.equal(scopes.length, 2);
    assert.ok(scopes[0].start < scopes[1].start);
  });

  test('renames only the targeted occurrence, even when every occurrence is byte-identical', () => {
    const scopes = findIdScopesInOrder(twoIdenticalIcons, 'aiGradient');
    const newContent = applyScopeRenames(twoIdenticalIcons, [
      { start: scopes[1].start, end: scopes[1].end, oldId: 'aiGradient', newId: 'aiGradient-2' },
    ]);
    // first occurrence (kept) is untouched
    assert.match(newContent, /icon-wrap">\s*<svg viewBox="0 0 24 24"><linearGradient id="aiGradient" /);
    // second occurrence is renamed, id and its own fill reference stay in sync
    assert.match(newContent, /icon-wrap-2">\s*<svg viewBox="0 0 24 24"><linearGradient id="aiGradient-2" /);
    assert.match(newContent, /fill="url\(#aiGradient-2\)"/);
    // only one fill reference still points at the untouched original id
    assert.equal((newContent.match(/fill="url\(#aiGradient\)"/g) || []).length, 1);
  });

  test('renaming two different ids that share one <svg> block lands both edits', () => {
    const file = '<svg><linearGradient id="g1"></linearGradient><clipPath id="c1"></clipPath><path fill="url(#g1)" clip-path="url(#c1)"/></svg>';
    const gScopes = findIdScopesInOrder(file, 'g1');
    const cScopes = findIdScopesInOrder(file, 'c1');
    const newContent = applyScopeRenames(file, [
      { start: gScopes[0].start, end: gScopes[0].end, oldId: 'g1', newId: 'g1-2' },
      { start: cScopes[0].start, end: cScopes[0].end, oldId: 'c1', newId: 'c1-2' },
    ]);
    assert.match(newContent, /id="g1-2"/);
    assert.match(newContent, /id="c1-2"/);
    assert.match(newContent, /url\(#g1-2\)/);
    assert.match(newContent, /url\(#c1-2\)/);
  });

  test('returns null when an id occurrence lives outside any <svg> block', () => {
    const scopes = findIdScopesInOrder('<div id="aiGradient"></div>', 'aiGradient');
    assert.equal(scopes, null);
  });
});

import { isAutoFixableDuplicateId } from './duplicate-id-inject.js';
describe('isAutoFixableDuplicateId', () => {
  test('accepts ids only on SVG paint defs', () => {
    assert.equal(isAutoFixableDuplicateId({ id: 'g', occurrences: [{ tag: 'linearGradient' }, { tag: 'linearGradient' }] }), true);
  });
  test('refuses an id on a div (the id="start" case)', () => {
    assert.equal(isAutoFixableDuplicateId({ id: 'start', occurrences: [{ tag: 'div' }, { tag: 'div' }] }), false);
  });
  test('refuses a mixed or empty entry', () => {
    assert.equal(isAutoFixableDuplicateId({ occurrences: [{ tag: 'mask' }, { tag: 'div' }] }), false);
    assert.equal(isAutoFixableDuplicateId({ occurrences: [] }), false);
  });
});

// The real Superrank case (superrank-web, /use-cases/small-business), reduced: the page's own file repeats the id of the shared CTA section.
const PAGE = `---
const cards = [
  { name: 'Solo founders', text: 'One site.', href: '#start' },
  { name: 'Small businesses', text: 'Local shops.', href: '#start' },
];
---
<Layout>
  <div class="ref-wrap" id="start"><h2 class="sb-h2">One agent</h2>{cards.map((c) => <a class="sb-card" href={c.href}>{c.name}</a>)}</div>
  <CtaSection />
</Layout>
`;
const CTA = `<section class="cta-sec" id="start"><div class="container cta" id="demo"><h2>Get your website found</h2></div></section>`;
const INDEX = `<div class="side__cta"><a href="#start" class="btn btn--dark">Ship a fix like this</a></div>`;
const plan = (over = {}) => planOwnedIdRemoval({ id: 'start', occurrenceCount: 2, ownFilePath: 'src/pages/use-cases/small-business.astro', ownContent: PAGE, otherFiles: [{ path: 'src/components/CtaSection.astro', content: CTA }, { path: 'src/pages/index.astro', content: INDEX }], ...over });

describe('classifyIdMentions', () => {
  test('counts definitions and plain links, in HTML attributes and in data written as href: "#id"', () => {
    assert.deepEqual(classifyIdMentions(PAGE, 'start'), { definitions: 1, anchors: 2, dangerous: [] });
    assert.deepEqual(classifyIdMentions(CTA, 'start'), { definitions: 1, anchors: 0, dangerous: [] });
    assert.deepEqual(classifyIdMentions(INDEX, 'start'), { definitions: 0, anchors: 1, dangerous: [] });
  });
  test('an id that only shares a prefix is not this id', () => {
    assert.deepEqual(classifyIdMentions('<a href="#start-here" id="start-here">', 'start'), { definitions: 0, anchors: 0, dangerous: [] });
  });
  test('every other kind of use is dangerous: CSS, scripts, selectors, aria, labels', () => {
    for (const [what, text] of [
      ['css', '#start { color: red }'], ['getElementById', "document.getElementById('start')"], ['querySelector', 'document.querySelector("#start .x")'],
      ['attribute selector', '[id="start"] { x: y }'], ['aria', '<div aria-labelledby="a start b">'], ['label', '<label for="start">'],
    ]) assert.ok(classifyIdMentions(text, 'start').dangerous.length > 0, what);
  });
});

describe('planOwnedIdRemoval: an id the page\'s own file repeats from a shared component', () => {
  test('the real Superrank case: the id is dropped from the page\'s own element only, and the behaviour change is stated', () => {
    const r = plan();
    assert.equal(r.ok, true, r.error);
    assert.equal(r.newContent, PAGE.replace('<div class="ref-wrap" id="start">', '<div class="ref-wrap">'));
    assert.deepEqual(r.region, { before: '<div class="ref-wrap" id="start">', after: '<div class="ref-wrap">' });
    assert.deepEqual(r.sharedIn, ['src/components/CtaSection.astro']);
    assert.match(r.behaviourNote, /3 link\(s\) to #start currently scroll to the first element with that id, the one in src\/pages\/use-cases\/small-business\.astro/);
    assert.match(r.behaviourNote, /remaining one in src\/components\/CtaSection\.astro/);
  });
  test('only the id attribute changes: nothing else in the file, byte for byte', () => {
    const r = plan();
    assert.equal(PAGE.length - r.newContent.length, ' id="start"'.length);
  });
  test('no link to the id anywhere: no behaviour note', () => {
    const r = plan({ ownContent: PAGE.replace(/href: '#start'/g, "href: '/x'"), otherFiles: [{ path: 'src/components/CtaSection.astro', content: CTA }] });
    assert.equal(r.ok, true); assert.equal(r.behaviourNote, null);
  });
  test('refused when anything but a plain link refers to the id, in this file or any other', () => {
    for (const bad of ['#start { margin: 0 }', "document.getElementById('start')", '<div aria-labelledby="start">']) {
      assert.equal(plan({ otherFiles: [{ path: 'a.astro', content: CTA }, { path: 'x.css', content: bad }] }).ok, false, bad);
      assert.equal(plan({ ownContent: `${PAGE}\n<style>${bad}</style>` }).ok, false, `own: ${bad}`);
    }
  });
  test('refused when it cannot be proven which element to change or that the other one exists', () => {
    assert.match(plan({ occurrenceCount: 3 }).error, /exactly one repeated pair/);
    assert.match(plan({ ownContent: PAGE.replace('<CtaSection />', '<p id="start"></p>') }).error, /defined 2 times/);
    assert.match(plan({ ownContent: '<p>no id here</p>' }).error, /defined 0 times/);
    assert.match(plan({ otherFiles: [{ path: 'src/pages/index.astro', content: INDEX }] }).error, /No other file in the repo defines/);
    assert.equal(plan({ otherFiles: [] }).reason, 'not-provably-safe');
  });
});

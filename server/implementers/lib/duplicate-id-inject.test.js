import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hasDangerousReference, findIdScopesInOrder, applyScopeRenames } from './duplicate-id-inject.js';

const twoIdenticalIcons = `
<div class="icon-wrap">
  <svg viewBox="0 0 24 24"><linearGradient id="aiGradient" x1="3" y1="2" x2="21" y2="22"><stop offset="0%" stop-color="#4285F4"></stop></linearGradient><path fill="url(#aiGradient)" d="M1 1h1v1z"/></svg>
</div>
<div class="icon-wrap-2">
  <svg viewBox="0 0 24 24"><linearGradient id="aiGradient" x1="3" y1="2" x2="21" y2="22"><stop offset="0%" stop-color="#4285F4"></stop></linearGradient><path fill="url(#aiGradient)" d="M1 1h1v1z"/></svg>
</div>
`;

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

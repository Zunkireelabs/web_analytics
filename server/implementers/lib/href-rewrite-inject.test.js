import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteHref, stripLink, getAnchorsForHref } from './href-rewrite-inject.js';

describe('rewriteHref', () => {
  test('rewrites a single matching href', () => {
    const file = '<p>See <a href="/old-page">this</a> for details.</p>';
    const result = rewriteHref(file, '/old-page', '/new-page');
    assert.equal(result.ok, true);
    assert.equal(result.replaced, 1);
    assert.match(result.newContent, /href="\/new-page"/);
    assert.doesNotMatch(result.newContent, /\/old-page/);
  });

  test('rewrites every occurrence when the same href appears more than once', () => {
    const file = '<a href="/old">one</a> and again <a href="/old">two</a>';
    const result = rewriteHref(file, '/old', '/new');
    assert.equal(result.ok, true);
    assert.equal(result.replaced, 2);
    assert.equal((result.newContent.match(/href="\/new"/g) || []).length, 2);
  });

  test('matches both quote styles', () => {
    const file = "<a href='/old'>one</a>";
    const result = rewriteHref(file, '/old', '/new');
    assert.equal(result.ok, true);
    assert.match(result.newContent, /href='\/new'/);
  });

  test('never matches a similar-but-different href as a substring', () => {
    const file = '<a href="/foobar">x</a>';
    const result = rewriteHref(file, '/foo', '/new');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-match');
  });

  test('honest no-match when the href is genuinely absent', () => {
    const result = rewriteHref('<a href="/other">x</a>', '/old', '/new');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-match');
  });

  test('matches a site-relative anchor when given the absolute URL', () => {
    const file = '<a href="/solutions/human-resources/">HR</a>';
    const result = rewriteHref(file, 'https://www.zunkireelabs.com/solutions/human-resources/', '/new-page');
    assert.equal(result.ok, true);
    assert.match(result.newContent, /href="\/new-page"/);
  });

  test('rewrites a markdown link, keeping its text', () => {
    const file = 'See [old site](https://old.example.com) for details.';
    const result = rewriteHref(file, 'https://old.example.com', 'https://new.example.com');
    assert.equal(result.ok, true);
    assert.equal(result.newContent, 'See [old site](https://new.example.com) for details.');
  });

  test('rewrites a markdown link with a title, keeping the title', () => {
    const file = 'See [old site](https://old.example.com "Old Site") for details.';
    const result = rewriteHref(file, 'https://old.example.com', 'https://new.example.com');
    assert.equal(result.ok, true);
    assert.equal(result.newContent, 'See [old site](https://new.example.com "Old Site") for details.');
  });

  test('never matches a markdown image referencing the same URL', () => {
    const file = '![logo](https://old.example.com/logo.png)';
    const result = rewriteHref(file, 'https://old.example.com/logo.png', '/new-logo.png');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-match');
    assert.equal(file, '![logo](https://old.example.com/logo.png)');
  });
});

describe('stripLink', () => {
  test('replaces the whole anchor with its inner text', () => {
    const file = '<p>See <a href="/dead">this page</a> for details.</p>';
    const result = stripLink(file, '/dead');
    assert.equal(result.ok, true);
    assert.equal(result.newContent, '<p>See this page for details.</p>');
  });

  test('strips every occurrence', () => {
    const file = '<a href="/dead">one</a> and <a href="/dead">two</a>';
    const result = stripLink(file, '/dead');
    assert.equal(result.ok, true);
    assert.equal(result.replaced, 2);
    assert.equal(result.newContent, 'one and two');
  });

  test('refuses when a matched anchor contains a nested anchor', () => {
    const file = '<a href="/dead">outer <a href="/inner">inner</a></a>';
    const result = stripLink(file, '/dead');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'nested-anchor');
  });

  test('honest no-match when absent', () => {
    const result = stripLink('<a href="/other">x</a>', '/dead');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-match');
  });

  test('matches a site-relative anchor when given the absolute URL', () => {
    const file = '<a href="/solutions/human-resources/">HR</a>';
    const result = stripLink(file, 'https://www.zunkireelabs.com/solutions/human-resources/');
    assert.equal(result.ok, true);
    assert.equal(result.newContent, 'HR');
  });

  test('matches a relative anchor missing the trailing slash', () => {
    const file = '<a href="/solutions/human-resources">HR</a>';
    const result = stripLink(file, 'https://www.zunkireelabs.com/solutions/human-resources/');
    assert.equal(result.ok, true);
    assert.equal(result.newContent, 'HR');
  });

  test('strips a markdown link, keeping its text — blog posts are stored as .md, not HTML', () => {
    const file = '**Website**: [deerwalk.com](https://deerwalk.com)';
    const result = stripLink(file, 'https://deerwalk.com');
    assert.equal(result.ok, true);
    assert.equal(result.newContent, '**Website**: deerwalk.com');
  });

  test('strips every markdown link occurrence', () => {
    const file = '[dead](https://dead.example.com) and [dead](https://dead.example.com)';
    const result = stripLink(file, 'https://dead.example.com');
    assert.equal(result.ok, true);
    assert.equal(result.replaced, 2);
    assert.equal(result.newContent, 'dead and dead');
  });

  test('never matches a markdown image referencing the same URL', () => {
    const file = '![alt text](https://dead.example.com/img.png)';
    const result = stripLink(file, 'https://dead.example.com/img.png');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-match');
  });

  // Real shape found on Admizz's Footer.tsx 2026-09-17: an icon-only social
  // link with no visible text to preserve — the href lives on a `field:
  // "url"` property of one array element, not an <a> tag at all. The whole
  // object (icon JSX included) must go, not just the href field.
  test('data-array object shape: removes the WHOLE array element (icon JSX and all), not just the href field', () => {
    const file = 'const socialLinks = [\n' +
      '  { name: "Facebook", href: "https://facebook.com/x", icon: (<svg><path d="M1 1" /></svg>) },\n' +
      '  { name: "Instagram", href: "https://instagram.com/dead", icon: (<svg><path d="M2 2" /></svg>) },\n' +
      '  { name: "TikTok", href: "https://tiktok.com/x", icon: (<svg><path d="M3 3" /></svg>) },\n' +
      '];\n';
    const result = stripLink(file, 'https://instagram.com/dead');
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.newContent, /Instagram/);
    assert.match(result.newContent, /Facebook/);
    assert.match(result.newContent, /TikTok/);
  });

  test('data-array object shape: removing the LAST element leaves no dangling comma', () => {
    const file = 'const links = [\n  { href: "https://a.example.com" },\n  { href: "https://dead.example.com" },\n];\n';
    const result = stripLink(file, 'https://dead.example.com');
    assert.equal(result.ok, true);
    assert.equal(result.newContent, 'const links = [\n  { href: "https://a.example.com" },\n];\n');
  });

  test('data-array object shape: nested braces inside the object (a JSX expression in the icon) do not confuse the object boundary', () => {
    const file = 'const links = [\n' +
      '  { href: "https://dead.example.com", icon: (<Icon size={24} color={theme.primary} />) },\n' +
      '  { href: "https://a.example.com" },\n' +
      '];\n';
    const result = stripLink(file, 'https://dead.example.com');
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.newContent, /theme\.primary/);
    assert.match(result.newContent, /a\.example\.com/);
  });

  // Real shape found on Admizz's layout.tsx JSON-LD `sameAs` block
  // 2026-09-17: a bare quoted URL inside an array, no object at all.
  test('data-array string shape: removes one bare quoted URL from an array of strings', () => {
    const file = 'sameAs: [\n  "https://facebook.com/x",\n  "https://instagram.com/dead",\n  "https://tiktok.com/x",\n],\n';
    const result = stripLink(file, 'https://instagram.com/dead');
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.newContent, /instagram/);
    assert.match(result.newContent, /facebook/);
    assert.match(result.newContent, /tiktok/);
  });

  test('object-field shape is tried before the bare-string shape, so an unrelated field with the same text as a label never false-matches', () => {
    // Only the href field's value should ever be treated as the link — a
    // `name` field that happened to equal a URL-shaped string must never
    // be matched by the fallback string strategy once the object strategy
    // already found and handled the real href.
    const file = 'const links = [{ name: "https://dead.example.com", href: "https://dead.example.com" }];\n';
    const result = stripLink(file, 'https://dead.example.com');
    assert.equal(result.ok, true);
    // The whole object is gone (object strategy fired) — not just one
    // field's value replaced in place.
    assert.doesNotMatch(result.newContent, /https:\/\/dead\.example\.com/);
  });

  test('still an honest no-match when the href is genuinely absent from either data-array shape', () => {
    const file = 'const links = [{ href: "https://other.example.com" }];\nsameAs: ["https://other.example.com"],\n';
    const result = stripLink(file, 'https://dead.example.com');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-match');
  });
});

describe('getAnchorsForHref', () => {
  test('returns every matching anchor verbatim', () => {
    const file = '<a href="/x">one</a><a href="/x">two</a>';
    assert.deepEqual(getAnchorsForHref(file, '/x'), ['<a href="/x">one</a>', '<a href="/x">two</a>']);
  });

  test('returns an empty array when absent', () => {
    assert.deepEqual(getAnchorsForHref('<a href="/other">x</a>', '/x'), []);
  });
});

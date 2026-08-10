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

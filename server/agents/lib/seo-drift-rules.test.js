import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compareSnapshots, similarity, SEVERITY, RULE_COUNT, H1_SIMILARITY_FLOOR } from './seo-drift-rules.js';

// A healthy page. Each test changes ONE thing and expects exactly the rule(s) for it.
const base = () => ({
  statusCode: 200, title: 'Best Salon Software', metaDescription: 'Run your salon.', canonical: 'https://example.com/p/',
  robots: 'index, follow', h1: ['Salon software'], h2: ['Pricing', 'Features'], schemaTypes: ['Article'], schemaHash: 'hash-a',
  openGraph: { 'og:title': 'T' }, contentHash: 'c1', wordCount: 400,
});
const rules = (over) => compareSnapshots(base(), { ...base(), ...over }).map((f) => f.rule);
const find = (over, rule) => compareSnapshots(base(), { ...base(), ...over }).find((f) => f.rule === rule);

describe('no change', () => {
  test('an identical page reports nothing', () => assert.deepEqual(rules({}), []));
  test('missing input reports nothing, never throws', () => { assert.deepEqual(compareSnapshots(null, base()), []); assert.deepEqual(compareSnapshots(base(), undefined), []); });
});

describe('critical', () => {
  test('schema removed', () => {
    assert.deepEqual(rules({ schemaTypes: [], schemaHash: null }), ['schema-removed']);
    assert.equal(find({ schemaTypes: [], schemaHash: null }, 'schema-removed').severity, SEVERITY.CRITICAL);
  });
  test('canonical changed, and removed', () => {
    assert.deepEqual(rules({ canonical: 'https://example.com/other/' }), ['canonical-changed']);
    assert.deepEqual(rules({ canonical: null }), ['canonical-removed']);
  });
  test('noindex added, from the meta tag or the header; already-noindex is not "added"', () => {
    assert.deepEqual(rules({ robots: 'index, noindex' }), ['noindex-added']);
    assert.deepEqual(rules({ robots: 'noindex' }), ['noindex-added']);
    const was = { ...base(), robots: 'noindex' };
    assert.deepEqual(compareSnapshots(was, { ...was }).map((f) => f.rule), []);
  });
  test('H1 removed; H1 rewritten (not for a small edit)', () => {
    assert.deepEqual(rules({ h1: [] }), ['h1-removed']);
    assert.deepEqual(rules({ h1: ['Pricing plans for barbers'] }), ['h1-rewritten']);
    assert.deepEqual(rules({ h1: ['Salon software.'] }), [], 'a small edit is not a rewrite');
  });
  test('title removed', () => assert.deepEqual(rules({ title: null }), ['title-removed']));
  test('page now errors, only from a healthy state; other 2xx, redirects and recovery are not errors', () => {
    assert.deepEqual(rules({ statusCode: 404 }), ['page-error']);
    assert.deepEqual(rules({ statusCode: 503 }), ['page-error']);
    assert.deepEqual(rules({ statusCode: 204 }), []);
    assert.deepEqual(compareSnapshots({ ...base(), statusCode: 404 }, { ...base(), statusCode: 404 }).map((f) => f.rule), [], 'was already broken');
    assert.deepEqual(compareSnapshots({ ...base(), statusCode: 404 }, base()).map((f) => f.rule), [], 'recovered');
  });
});

describe('warning', () => {
  test('title changed (whitespace is not a change)', () => {
    assert.deepEqual(rules({ title: 'Salon Software, Priced Fairly' }), ['title-changed']);
    assert.deepEqual(rules({ title: '  Best   Salon  Software ' }), []);
  });
  test('meta description changed, and removed (worded differently)', () => {
    assert.match(find({ metaDescription: 'Different words.' }, 'description-changed').message, /changed/);
    assert.match(find({ metaDescription: null }, 'description-changed').message, /removed/);
  });
  test('social tags removed', () => assert.deepEqual(rules({ openGraph: {} }), ['social-tags-removed']));
  test('schema modified while still present', () => {
    assert.deepEqual(rules({ schemaHash: 'hash-b' }), ['schema-modified']);
    assert.deepEqual(rules({ schemaHash: null, schemaTypes: [] }), ['schema-removed'], 'removal is its own rule, not "modified"');
  });
});

describe('info', () => {
  test('schema added', () => {
    const b = { ...base(), schemaTypes: [], schemaHash: null };
    assert.deepEqual(compareSnapshots(b, base()).map((f) => f.rule), ['schema-added']);
  });
  test('subheadings and text changed', () => {
    assert.deepEqual(rules({ h2: ['Pricing'] }), ['subheadings-changed']);
    assert.deepEqual(rules({ contentHash: 'c2', wordCount: 450 }), ['content-changed']);
    assert.equal(find({ contentHash: 'c2' }, 'content-changed').severity, SEVERITY.INFO);
  });
});

describe('ordering and combination', () => {
  test('most severe first', () => {
    const out = compareSnapshots(base(), { ...base(), contentHash: 'c2', title: 'Another title', canonical: null }).map((f) => f.severity);
    assert.deepEqual(out, ['critical', 'warning', 'info']);
  });
  test('findings carry what changed, was and now', () => {
    const t = find({ title: 'New title' }, 'title-changed');
    assert.equal(t.what, 'Page title'); assert.equal(t.was, 'Best Salon Software'); assert.equal(t.now, 'New title');
  });
  test('15 rules are ported (claude-seo\'s two Core Web Vitals rules are not)', () => assert.equal(RULE_COUNT, 15));
});

describe('similarity', () => {
  test('identical is 1, unrelated is low, case and spacing are ignored', () => {
    assert.equal(similarity('Hello world', 'hello   WORLD'), 1);
    assert.ok(similarity('Salon software', 'Pricing plans for barbers') < H1_SIMILARITY_FLOOR);
    assert.ok(similarity('Salon software', 'Salon software.') > 0.9);
    assert.equal(similarity('a', 'b'), 0);
  });
});

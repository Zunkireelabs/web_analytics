import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { locateRecordEntry, writeRecordFields, verifyRecordEdit, renderObject } from './ts-record-fields.js';
import { parseDataLiteral, findNamedExport } from './ts-export-data.js';

// Shaped like admizz-web-dev's src/data/post-seo-overrides.ts (header comment, a type annotation, quoted slug keys, two-field objects with trailing commas).
const FILE = `// Search-result title and description for existing content posts, keyed by
// post slug. mentions export const postSeoOverrides = {} to confuse a naive locator.
export const postSeoOverrides: Record<string, { title: string; description: string }> = {
  "ielts-vs-pte": {
    title: "IELTS vs PTE: Differences in Format, Scoring & Acceptance",
    description: "IELTS or PTE? Compare exam format, scoring and acceptance.",
  },
  "international-education-consultants": {
    title: "International Education Consultants for Study Abroad",
    description: "Admizz Education helps students apply to universities abroad.",
  },
};

export const somethingElse = ["keep me"];
`;
const EXP = { exportName: 'postSeoOverrides' };

describe('locateRecordEntry', () => {
  test('finds an existing entry, ignoring the comment that mentions the export', () => {
    const r = locateRecordEntry(FILE, { ...EXP, key: 'ielts-vs-pte' });
    assert.equal(r.ok, true);
    assert.equal(r.entry.key, 'ielts-vs-pte');
    assert.equal(r.entries.length, 2);
  });
  test('an absent key is not an error: the caller decides whether to create it', () => {
    const r = locateRecordEntry(FILE, { ...EXP, key: 'new-post' });
    assert.equal(r.ok, true);
    assert.equal(r.entry, undefined);
  });
  test('refuses an array export, a missing export, a duplicated key, and a record built with a spread', () => {
    assert.equal(locateRecordEntry('export const postSeoOverrides = [];', { ...EXP, key: 'a' }).reason, 'invalid-config');
    assert.equal(locateRecordEntry('export const other = {};', { ...EXP, key: 'a' }).ok, false);
    assert.equal(locateRecordEntry('export const postSeoOverrides = { "a": { title: "x" }, "a": { title: "y" } };', { ...EXP, key: 'a' }).ok, false);
    assert.equal(locateRecordEntry('export const postSeoOverrides = { ...base, "a": { title: "x" } };', { ...EXP, key: 'a' }).ok, false);
  });
});

describe('writeRecordFields — an existing entry', () => {
  test('replaces the two fields in place, in the file\'s own style, and nothing else changes', () => {
    const located = locateRecordEntry(FILE, { ...EXP, key: 'ielts-vs-pte' });
    const w = writeRecordFields(FILE, located, { key: 'ielts-vs-pte', fields: { title: 'IELTS or PTE: Which Test Fits You', description: 'New description, with "quotes" and a \\ backslash.' }, create: false });
    assert.equal(w.ok, true);
    assert.equal(w.created, false);
    assert.match(w.content, /"ielts-vs-pte": \{\n    title: "IELTS or PTE: Which Test Fits You",\n    description: "New description, with \\"quotes\\" and a \\\\ backslash\.",\n  \},/);
    assert.ok(w.content.includes('"international-education-consultants"'));
    assert.ok(w.content.endsWith('export const somethingElse = ["keep me"];\n'));
    assert.equal(verifyRecordEdit(FILE, w.content, { ...EXP, key: 'ielts-vs-pte', expected: w.after }).ok, true);
  });
  test('a description of null keeps the one already there (only the title changes)', () => {
    const located = locateRecordEntry(FILE, { ...EXP, key: 'ielts-vs-pte' });
    const w = writeRecordFields(FILE, located, { key: 'ielts-vs-pte', fields: { title: 'Only the title', description: null }, create: false });
    assert.deepEqual(w.after, { title: 'Only the title', description: 'IELTS or PTE? Compare exam format, scoring and acceptance.' });
  });
  test('a field the entry already had and the draft does not touch is kept, in its place', () => {
    const f = 'export const postSeoOverrides = {\n  "a": {\n    title: "T",\n    description: "D",\n    noindex: true,\n  },\n};\n';
    const w = writeRecordFields(f, locateRecordEntry(f, { ...EXP, key: 'a' }), { key: 'a', fields: { title: 'T2', description: null }, create: false });
    assert.deepEqual(w.after, { title: 'T2', description: 'D', noindex: true });
  });
  test('an entry that is not a plain object (a reference, a call) is refused, never overwritten', () => {
    const f = 'export const postSeoOverrides = {\n  "a": makeSeo("a"),\n  "b": { title: sharedTitle, description: "D" },\n};\n';
    assert.equal(writeRecordFields(f, locateRecordEntry(f, { ...EXP, key: 'a' }), { key: 'a', fields: { title: 'x', description: 'y' }, create: false }).ok, false);
    const b = writeRecordFields(f, locateRecordEntry(f, { ...EXP, key: 'b' }), { key: 'b', fields: { title: 'x', description: 'y' }, create: false });
    assert.equal(b.ok, false);
    assert.equal(b.reason, 'non-literal-existing-value');
  });
});

describe('writeRecordFields — a new entry', () => {
  test('is created at the end, in the file\'s style, only when allowed and with every field', () => {
    const located = locateRecordEntry(FILE, { ...EXP, key: 'new-post' });
    const w = writeRecordFields(FILE, located, { key: 'new-post', fields: { title: 'A New Title', description: 'A new description.' }, create: true });
    assert.equal(w.ok, true);
    assert.equal(w.created, true);
    assert.match(w.content, /\},\n  "new-post": \{\n    title: "A New Title",\n    description: "A new description\.",\n  \},\n\};/);
    assert.equal(verifyRecordEdit(FILE, w.content, { ...EXP, key: 'new-post', expected: w.after }).ok, true);
    // every other entry is byte-for-byte what it was
    assert.ok(w.content.includes(FILE.slice(FILE.indexOf('"ielts-vs-pte"'), FILE.indexOf('\n};'))));
  });
  test('not allowed to create: refused; a draft without a description cannot create one (the type needs both)', () => {
    const located = locateRecordEntry(FILE, { ...EXP, key: 'new-post' });
    assert.equal(writeRecordFields(FILE, located, { key: 'new-post', fields: { title: 'T', description: 'D' }, create: false }).reason, 'target-not-identified');
    const w = writeRecordFields(FILE, located, { key: 'new-post', fields: { title: 'T', description: null }, create: true });
    assert.equal(w.reason, 'draft-not-ready');
    assert.match(w.error, /description/);
  });
  test('works on an empty record and on one with no trailing comma', () => {
    for (const f of ['export const postSeoOverrides = {};\n', 'export const postSeoOverrides = {\n  "a": { title: "T", description: "D" }\n};\n']) {
      const w = writeRecordFields(f, locateRecordEntry(f, { ...EXP, key: 'b' }), { key: 'b', fields: { title: 'T2', description: 'D2' }, create: true });
      assert.equal(w.ok, true, f);
      assert.equal(parseDataLiteral(w.content.slice(findNamedExport(w.content, 'postSeoOverrides').start - 1, findNamedExport(w.content, 'postSeoOverrides').end + 1)).ok, true);
      assert.equal(verifyRecordEdit(f, w.content, { ...EXP, key: 'b', expected: w.after }).ok, true);
    }
  });
});

describe('verifyRecordEdit — the proof catches a wrong edit', () => {
  const located = locateRecordEntry(FILE, { ...EXP, key: 'ielts-vs-pte' });
  const good = writeRecordFields(FILE, located, { key: 'ielts-vs-pte', fields: { title: 'T', description: 'D' }, create: false });
  test('a change to another entry, to the text outside the export, or to the target itself is rejected', () => {
    const v = (after, expected = good.after) => verifyRecordEdit(FILE, after, { ...EXP, key: 'ielts-vs-pte', expected });
    assert.equal(v(good.content).ok, true);
    assert.match(v(good.content.replace('Admizz Education helps students', 'Admizz helps students')).error, /Entry "international-education-consultants" was changed/);
    assert.match(v(good.content.replace('keep me', 'changed')).error, /after the target export changed/);
    assert.match(v(good.content.replace('// Search-result', '// Changed')).error, /before the target export changed/);
    assert.match(v(good.content, { title: 'something else', description: 'D' }).error, /not what was intended/);
  });
});

describe('renderObject', () => {
  test('one field per line, trailing commas, unquoted names; a name that is not an identifier is quoted', () => {
    assert.equal(renderObject({ title: 'T', 'meta-x': 'D' }, { indent: '  ' }), '{\n    title: "T",\n    "meta-x": "D",\n  }');
  });
});

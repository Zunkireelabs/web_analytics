import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findRootArrayBounds, findObjectRange, spliceScalarField, findScalarFieldRange } from './js-data-splice.js';
import { isDataReady } from '../data-array-content.js';

// A data file whose array is declared under a name and exported through a transform: the shape zunkireelabs-web's
// src/_data/locations.js moved to on 2 Oct 2026, after which every location-page fix was silently dropped. Synthetic content, same shape.
const NAMED = `import { helper } from "./helpers.js";

const cities = [
  {
    id: "kathmandu",
    title: "Software company in Kathmandu",
    expandedContent: ""
  },
  {
    id: "bhaktapur",
    title: "Software company in Bhaktapur",
    expandedContent: ""
  },
];

// Fill entries a city does not define itself.
export default cities.map((c) => {
  return { ...c, answer: c.answer || helper(c.id) };
});
`;
const DIRECT = `export default [\n  { id: "a", title: "A" },\n];\n`;

describe('finding the data array', () => {
  test('the long-standing `export default [ ... ]` shape is unchanged', () => {
    const b = findRootArrayBounds(DIRECT, 'js-export-array');
    assert.ok(b);
    assert.ok(findObjectRange(DIRECT, 'id', 'a'));
  });

  test('`const x = [ ... ]; export default x.map(...)`: the DECLARED array is found, and entries by id', () => {
    const b = findRootArrayBounds(NAMED, 'js-export-array');
    assert.ok(b, 'bounds found');
    assert.ok(NAMED.slice(b.start, b.end).includes('id: "bhaktapur"'));
    assert.ok(findObjectRange(NAMED, 'id', 'bhaktapur'));
    assert.equal(findObjectRange(NAMED, 'id', 'pokhara'), null, 'an id that is not there is still not found');
  });

  test('`export default x;` (no transform) works too', () => {
    const src = `const items = [\n  { id: "x", title: "X" },\n];\nexport default items;\n`;
    assert.ok(findObjectRange(src, 'id', 'x'));
  });

  test('a name declared twice is ambiguous: refused, never guessed', () => {
    const src = `let cities = [ { id: "a" } ];\nfunction f() { const cities = [ { id: "b" } ]; return cities; }\nexport default cities;\n`;
    assert.equal(findRootArrayBounds(src, 'js-export-array'), null);
  });

  test('a default export of something that is not a declared array is refused', () => {
    assert.equal(findRootArrayBounds(`const cities = load();\nexport default cities;\n`, 'js-export-array'), null);
    assert.equal(findRootArrayBounds(`export default function () { return []; }\n`, 'js-export-array'), null);
  });

  test('a write lands INSIDE the declared array, and the export transform is left exactly as it was', () => {
    const obj = findObjectRange(NAMED, 'id', 'bhaktapur');
    const out = spliceScalarField(NAMED, obj, 'expandedContent', '<p>New section</p>');
    const after = findObjectRange(out, 'id', 'bhaktapur');
    const field = findScalarFieldRange(out, after, 'expandedContent');
    assert.ok(field && out.slice(field.start, field.end).includes('New section'));
    assert.ok(out.includes('export default cities.map((c) => {'), 'the transform is untouched');
    assert.ok(out.indexOf('New section') < out.indexOf('export default'), 'written into the source array, before the export');
    assert.ok(out.includes('id: "kathmandu"') && out.includes('expandedContent: ""'), 'other entries untouched');
  });

  test('isDataReady is now true for a page whose entry exists in this shape (it was false before the fix)', async () => {
    const config = { id: 'data-array-content', dataFile: 'src/_data/locations.js', field: { expandedContent: 'expandedContent' }, key: 'id' };
    const site = { repo_owner: 'o', repo_name: 'r', repo_default_branch: 'main' };
    assert.equal(await isDataReady(site, 'https://x.example/locations/bhaktapur/', config, async () => ({ content: NAMED }), 'main'), true);
    assert.equal(await isDataReady(site, 'https://x.example/locations/pokhara/', config, async () => ({ content: NAMED }), 'main'), false);
  });
});

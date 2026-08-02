import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  scanBalanced, findObjectRange, findArrayFieldRange, findRootArrayBounds, spliceMarkedArray,
  insertNewArrayField, assertValidContent, dedupeAndValidateFaqItems,
  parseExistingFaqItems, parseManagedFaqItems, diffFaqItems,
} from './js-data-splice.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__');
// Real repo content snapshotted 2026-07-19 (zunkireelabs-web, stage branch)
// — not synthetic, so these tests exercise the same real-world structure
// (deep nesting, mixed hand-authored content) the adapter actually runs
// against, same discipline as the manual dry-run verification done while
// building this feature.
const locations = readFileSync(join(FIXTURES, 'locations.js'), 'utf8');
const comparisons = readFileSync(join(FIXTURES, 'comparisons.js'), 'utf8');
const glossary = readFileSync(join(FIXTURES, 'glossary.js'), 'utf8');

describe('findObjectRange — js-export-array format', () => {
  test('finds every real location entry', () => {
    for (const id of ['kathmandu', 'lalitpur', 'bhaktapur', 'pokhara']) {
      const r = findObjectRange(locations, 'id', id, 'js-export-array');
      assert.ok(r, `expected to find ${id}`);
      assert.equal(locations[r.start], '{');
      assert.equal(locations[r.end], '}');
    }
  });

  test('finds a comparison entry despite deep nesting (competitor{}, comparison[], bestFor{})', () => {
    const r = findObjectRange(comparisons, 'id', 'zunkiree-vs-algolia', 'js-export-array');
    assert.ok(r);
    assert.match(comparisons.slice(r.start, r.end + 1), /id: "zunkiree-vs-algolia"/);
  });

  test('finds every real glossary entry', () => {
    for (const id of ['agentic-commerce', 'rag', 'llm', 'vector-database']) {
      assert.ok(findObjectRange(glossary, 'id', id, 'js-export-array'), `expected to find ${id}`);
    }
  });

  test('returns null for a nonexistent id', () => {
    assert.equal(findObjectRange(locations, 'id', 'nonexistent-city', 'js-export-array'), null);
  });

  test('never mistakes a bracket character inside a string/comment for a structural bracket', () => {
    const content = `export default [
  {
    id: "alpha",
    // a comment with [brackets] and {braces} that must be ignored
    note: "Prices range [10-20] and config is {a: 1}",
    tags: ["x", "y"]
  },
  {
    id: "beta",
    note: "nothing special"
  }
];
`;
    const alpha = findObjectRange(content, 'id', 'alpha', 'js-export-array');
    const beta = findObjectRange(content, 'id', 'beta', 'js-export-array');
    assert.ok(alpha);
    assert.ok(beta);
    assert.match(content.slice(alpha.start, alpha.end + 1), /id: "alpha"/);
    assert.match(content.slice(beta.start, beta.end + 1), /id: "beta"/);
    assert.doesNotMatch(content.slice(alpha.start, alpha.end + 1), /id: "beta"/);
  });
});

describe('findObjectRange — json-array format', () => {
  const jsonContent = JSON.stringify([
    { id: 'widget-a', faqs: [] },
    { id: 'widget-b', faqs: [] },
  ]);

  test('matches quoted JSON keys, not the unquoted js-export-array shape', () => {
    const r = findObjectRange(jsonContent, 'id', 'widget-a', 'json-array');
    assert.ok(r);
    assert.match(jsonContent.slice(r.start, r.end + 1), /"id":"widget-a"/);
  });

  test('returns null for a nonexistent id', () => {
    assert.equal(findObjectRange(jsonContent, 'id', 'nonexistent', 'json-array'), null);
  });
});

describe('findArrayFieldRange', () => {
  test('finds the existing faqs array on a real location', () => {
    const objRange = findObjectRange(locations, 'id', 'kathmandu', 'js-export-array');
    const r = findArrayFieldRange(locations, objRange, 'faqs', 'js-export-array');
    assert.ok(r);
    assert.match(locations.slice(r.start, r.end), /question:/);
  });

  test('returns null when the field does not exist yet (real comparison entry)', () => {
    const objRange = findObjectRange(comparisons, 'id', 'zunkiree-vs-algolia', 'js-export-array');
    assert.equal(findArrayFieldRange(comparisons, objRange, 'faqs', 'js-export-array'), null);
  });
});

describe('insertNewArrayField + assertValidContent', () => {
  test('inserts a new faqs field into a real, deeply-nested comparison entry and stays valid JS', () => {
    const objRange = findObjectRange(comparisons, 'id', 'zunkiree-vs-algolia', 'js-export-array');
    const updated = insertNewArrayField(comparisons, objRange, 'faqs', [{ question: 'Q1?', answer: 'A1.' }], 'js-export-array');
    assert.equal(assertValidContent(updated, 'js-export-array').ok, true);
    assert.match(updated, /faqs: \[/);

    const otherId = 'zunkiree-vs-elasticsearch';
    const before = comparisons.slice(comparisons.indexOf(`id: "${otherId}"`) - 4, comparisons.indexOf(`id: "${otherId}"`) + 2000);
    const after = updated.slice(updated.indexOf(`id: "${otherId}"`) - 4, updated.indexOf(`id: "${otherId}"`) + 2000);
    assert.equal(before, after);
  });

  test('json-array: inserts a new faqs field as valid JSON', () => {
    const content = JSON.stringify([{ id: 'x', title: 'X' }]);
    const objRange = findObjectRange(content, 'id', 'x', 'json-array');
    const updated = insertNewArrayField(content, objRange, 'faqs', [{ question: 'Q?', answer: 'A.' }], 'json-array');
    assert.equal(assertValidContent(updated, 'json-array').ok, true);
    const parsed = JSON.parse(updated);
    assert.equal(parsed[0].faqs.length, 1);
    assert.equal(parsed[0].faqs[0]._aiManaged, true);
  });

  test('a broken edit is refused by assertValidContent, never silently applied', () => {
    assert.equal(assertValidContent('export default [ { id: "x" ', 'js-export-array').ok, false);
    assert.equal(assertValidContent('[ { "id": "x" ', 'json-array').ok, false);
  });
});

describe('spliceMarkedArray (append to an existing array) — js-export-array', () => {
  test('appends after a real location\'s last item with no trailing comma (the exact bug found while building this)', () => {
    const objRange = findObjectRange(locations, 'id', 'kathmandu', 'js-export-array');
    const arrayRange = findArrayFieldRange(locations, objRange, 'faqs', 'js-export-array');
    const updated = spliceMarkedArray(locations, arrayRange, [{ question: 'New?', answer: 'Yes.' }], 'js-export-array');
    assert.equal(assertValidContent(updated, 'js-export-array').ok, true);
    assert.match(updated, /New\?/);
  });

  test('is idempotent — re-applying updates the AI-managed block instead of duplicating it', () => {
    const objRange = findObjectRange(locations, 'id', 'kathmandu', 'js-export-array');
    const arrayRange = findArrayFieldRange(locations, objRange, 'faqs', 'js-export-array');
    const first = spliceMarkedArray(locations, arrayRange, [{ question: 'Old?', answer: 'Old answer.' }], 'js-export-array');

    const objRange2 = findObjectRange(first, 'id', 'kathmandu', 'js-export-array');
    const arrayRange2 = findArrayFieldRange(first, objRange2, 'faqs', 'js-export-array');
    const second = spliceMarkedArray(first, arrayRange2, [{ question: 'New?', answer: 'New answer.' }], 'js-export-array');

    assert.equal((second.match(/SEOAI:FAQ:START/g) || []).length, 1);
    assert.doesNotMatch(second, /Old\?/);
    assert.match(second, /New\?/);
    assert.equal(assertValidContent(second, 'js-export-array').ok, true);
  });

  test('never touches hand-authored items outside the marker', () => {
    const objRange = findObjectRange(locations, 'id', 'kathmandu', 'js-export-array');
    const arrayRange = findArrayFieldRange(locations, objRange, 'faqs', 'js-export-array');
    const before = (locations.match(/question:/g) || []).length;
    const updated = spliceMarkedArray(locations, arrayRange, [{ question: 'New?', answer: 'Yes.' }], 'js-export-array');
    const after = (updated.match(/question:/g) || []).length;
    assert.equal(after, before + 1);
  });
});

describe('spliceMarkedArray — json-array (sentinel-field based, no comments available)', () => {
  test('preserves hand-authored items, replaces AI-managed ones idempotently', () => {
    const content = JSON.stringify([{ id: 'k', faqs: [
      { question: 'Hand Q', answer: 'Hand A' },
      { question: 'Old AI Q', answer: 'Old AI A', _aiManaged: true },
    ] }]);
    const objRange = findObjectRange(content, 'id', 'k', 'json-array');
    const arrayRange = findArrayFieldRange(content, objRange, 'faqs', 'json-array');
    const updated = spliceMarkedArray(content, arrayRange, [{ question: 'New AI Q', answer: 'New AI A' }], 'json-array');
    const parsed = JSON.parse(updated)[0].faqs;
    assert.equal(parsed.length, 2);
    assert.ok(parsed.some((f) => f.question === 'Hand Q'));
    assert.ok(parsed.some((f) => f.question === 'New AI Q'));
    assert.ok(!parsed.some((f) => f.question === 'Old AI Q'));
  });
});

describe('dedupeAndValidateFaqItems', () => {
  test('rejects an empty list', () => {
    assert.equal(dedupeAndValidateFaqItems([]).ok, false);
  });

  test('rejects a malformed item', () => {
    assert.equal(dedupeAndValidateFaqItems([{ question: 'Q?' }]).ok, false);
  });

  test('dedupes case/whitespace-insensitively, last occurrence wins', () => {
    const r = dedupeAndValidateFaqItems([
      { question: 'What is X?', answer: 'A1' },
      { question: '  what is x? ', answer: 'A2 (should win)' },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].answer, 'A2 (should win)');
  });

  test('accepts valid, distinct items', () => {
    const r = dedupeAndValidateFaqItems([{ question: 'Q1?', answer: 'A1' }, { question: 'Q2?', answer: 'A2' }]);
    assert.equal(r.ok, true);
    assert.equal(r.items.length, 2);
  });
});

describe('parseExistingFaqItems / parseManagedFaqItems', () => {
  test('parses real hand-authored items back into objects (js-export-array)', () => {
    const objRange = findObjectRange(locations, 'id', 'kathmandu', 'js-export-array');
    const arrayRange = findArrayFieldRange(locations, objRange, 'faqs', 'js-export-array');
    const items = parseExistingFaqItems(locations.slice(arrayRange.start, arrayRange.end), 'js-export-array');
    assert.ok(items.length >= 5);
    assert.ok(items[0].question && items[0].answer);
  });

  test('parseManagedFaqItems excludes hand-authored content (js-export-array) — only what is inside the marker', () => {
    const arrayInterior = `
      { question: "Hand-authored Q", answer: "Hand-authored A" },
      /* SEOAI:FAQ:START */
      { question: "AI Q", answer: "AI A" },
      /* SEOAI:FAQ:END */
    `;
    const items = parseManagedFaqItems(arrayInterior, 'js-export-array');
    assert.equal(items.length, 1);
    assert.equal(items[0].question, 'AI Q');
  });

  test('parseManagedFaqItems returns [] when no marker exists yet (js-export-array)', () => {
    assert.deepEqual(parseManagedFaqItems('{ question: "Q", answer: "A" }', 'js-export-array'), []);
  });

  test('parseManagedFaqItems excludes hand-authored content (json-array) — only _aiManaged items', () => {
    const arrayInterior = JSON.stringify({ question: 'Hand Q', answer: 'Hand A' }) + ',' +
      JSON.stringify({ question: 'AI Q', answer: 'AI A', _aiManaged: true });
    const items = parseManagedFaqItems(arrayInterior, 'json-array');
    assert.equal(items.length, 1);
    assert.equal(items[0].question, 'AI Q');
  });
});

describe('diffFaqItems', () => {
  test('classifies added/modified/removed/unchanged correctly', () => {
    const existing = [{ question: 'Q1?', answer: 'A1' }, { question: 'Q2?', answer: 'A2' }];
    const updated = [{ question: 'Q1?', answer: 'A1' }, { question: 'Q2?', answer: 'A2-changed' }, { question: 'Q3?', answer: 'A3' }];
    const diff = diffFaqItems(existing, updated);
    assert.equal(diff.added.length, 1);
    assert.equal(diff.added[0].question, 'Q3?');
    assert.equal(diff.modified.length, 1);
    assert.equal(diff.modified[0].after.answer, 'A2-changed');
    assert.equal(diff.unchanged.length, 1);
    assert.equal(diff.removed.length, 0);
  });

  test('reports removed when a previously-managed question is dropped', () => {
    const diff = diffFaqItems([{ question: 'Old?', answer: 'A' }], [{ question: 'New?', answer: 'B' }]);
    assert.equal(diff.removed.length, 1);
    assert.equal(diff.added.length, 1);
  });
});

describe('findRootArrayBounds — flat-array shape (root array IS the item list, e.g. zunkireelabs-web faq.json)', () => {
  test('bounds a js-export-array root array', () => {
    const content = `export default [
  { question: "Q1?", answer: "A1." },
  { question: "Q2?", answer: "A2." }
];
`;
    const r = findRootArrayBounds(content, 'js-export-array');
    assert.ok(r);
    assert.match(content.slice(r.start, r.end), /Q1\?/);
    assert.match(content.slice(r.start, r.end), /Q2\?/);
  });

  test('bounds a bare json-array root array', () => {
    const content = JSON.stringify([{ question: 'Q1?', answer: 'A1.' }]);
    const r = findRootArrayBounds(content, 'json-array');
    assert.ok(r);
    assert.match(content.slice(r.start, r.end), /Q1\?/);
  });

  test('never mistakes a bracket inside a string/comment for the root array boundary', () => {
    const content = `export default [
  { question: "What about [brackets]?", answer: "Still one item." }
];
`;
    const r = findRootArrayBounds(content, 'js-export-array');
    assert.ok(r);
    assert.match(content.slice(r.start, r.end), /Still one item\./);
  });

  test('returns null for an unrecognized format rather than guessing', () => {
    assert.equal(findRootArrayBounds('[]', 'yaml-array'), null);
  });

  test('returns null when the file has no root array at all', () => {
    assert.equal(findRootArrayBounds('export default { foo: 1 };', 'js-export-array'), null);
  });
});

describe('scanBalanced', () => {
  test('treats string and comment content as opaque', () => {
    const content = '[ "a ] b" /* c ] d */ ]';
    const close = scanBalanced(content, 2, '[', ']');
    assert.equal(content[close], ']');
    assert.equal(close, content.length - 1);
  });

  test('returns -1 for unbalanced content', () => {
    assert.equal(scanBalanced('[ "no closing bracket"', 1, '[', ']'), -1);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  scanBalanced, findObjectRange, findArrayFieldRange, findRootArrayBounds, spliceMarkedArray,
  insertNewArrayField, assertValidContent, dedupeAndValidateFaqItems,
  parseExistingFaqItems, parseManagedFaqItems, diffFaqItems,
  findScalarFieldRange, spliceScalarField,
  findRootObjectBounds, findObjectFieldRange, removeArrayItemByField,
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
// Real productsDetails.json content (trimmed to 2 of 6 product entries),
// fetched 2026-08-10 while investigating a stuck broken-link-fix draft —
// see implementers/backend.js's resolveLinkDataSources-driven layer. Its
// nested `useCases[].id: "resources"` field is a deliberate stress case:
// the top-level `"resources": [...]` lookup must not be confused by it.
const productsDetails = readFileSync(join(FIXTURES, 'productsDetails.json'), 'utf8');

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

describe('findScalarFieldRange / spliceScalarField', () => {
  test('finds and replaces a real location\'s title, leaving everything else untouched', () => {
    const objRange = findObjectRange(locations, 'id', 'kathmandu', 'js-export-array');
    const range = findScalarFieldRange(locations, objRange, 'title', 'js-export-array');
    assert.ok(range);
    assert.equal(locations.slice(range.valueStart, range.valueEnd), '"AI Development Company in Kathmandu | Zunkiree Labs"');

    const updated = spliceScalarField(locations, objRange, 'title', 'New Kathmandu Title', 'js-export-array');
    assert.match(updated, /title: "New Kathmandu Title"/);
    // the sibling description field (and every other entry) must survive untouched
    assert.match(updated, /description: "Zunkiree Labs is Kathmandu's leading AI development company/);
    const otherObjRange = findObjectRange(updated, 'id', 'pokhara', 'js-export-array');
    assert.ok(otherObjRange, 'pokhara entry must still be findable after editing kathmandu');
  });

  test('does not false-match "title" inside an unrelated field name (no accidental "subtitle" collision)', () => {
    // Regression guard for the lookbehind added specifically for this: a
    // naive `title\s*:` regex would match inside a hypothetical
    // `subtitle: "..."` field. None of the real fixtures have one, so this
    // constructs a minimal case directly.
    const content = 'export default [\n  { id: "x", subtitle: "not the title field", title: "the real one" }\n]';
    const objRange = findObjectRange(content, 'id', 'x', 'js-export-array');
    const range = findScalarFieldRange(content, objRange, 'title', 'js-export-array');
    assert.equal(content.slice(range.valueStart, range.valueEnd), '"the real one"');
  });

  test('ignores a nested object\'s same-named field (real comparisons.js: top-level description vs competitor.description)', () => {
    const objRange = findObjectRange(comparisons, 'id', 'zunkiree-vs-algolia', 'js-export-array');
    const range = findScalarFieldRange(comparisons, objRange, 'description', 'js-export-array');
    assert.ok(range);
    assert.equal(
      comparisons.slice(range.valueStart, range.valueEnd),
      '"Compare Zunkiree Search and Algolia for your search needs. See how AI-native search differs from traditional search-as-a-service."'
    );
  });

  test('returns null (no guess) when the field genuinely does not exist — real glossary.js has term/shortDef, not title/description', () => {
    const objRange = findObjectRange(glossary, 'id', 'agentic-commerce', 'js-export-array');
    assert.equal(findScalarFieldRange(glossary, objRange, 'title', 'js-export-array'), null);
    assert.equal(spliceScalarField(glossary, objRange, 'title', 'anything', 'js-export-array'), null);
  });

  test('json-array format: quoted keys, no lookbehind needed', () => {
    const content = '[\n  { "id": "x", "title": "old" }\n]';
    const objRange = findObjectRange(content, 'id', 'x', 'json-array');
    const updated = spliceScalarField(content, objRange, 'title', 'new & "quoted"', 'json-array');
    assert.equal(JSON.parse(updated)[0].title, 'new & "quoted"');
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

describe('findRootObjectBounds', () => {
  test('finds the whole file for a root-object-keyed-by-id JSON file (productsDetails.json shape)', () => {
    const bounds = findRootObjectBounds(productsDetails);
    assert.ok(bounds);
    assert.equal(productsDetails[bounds.start], '{');
    assert.equal(productsDetails[bounds.end], '}');
  });

  test('returns null when the content has no object at all', () => {
    assert.equal(findRootObjectBounds('[1, 2, 3]'.slice(1, -1)), null);
  });
});

describe('findObjectFieldRange on root object bounds — locating a productsDetails.json entry by id', () => {
  test('finds each real product entry, not confused by the other', () => {
    const bounds = findRootObjectBounds(productsDetails);
    for (const id of ['ai-booking-engine', 'dental-ai']) {
      const entry = findObjectFieldRange(productsDetails, bounds, id, 'json-array');
      assert.ok(entry, `expected to find "${id}"`);
      assert.match(productsDetails.slice(entry.start, entry.end + 1), new RegExp(`"id":\\s*"${id}"`));
    }
  });

  test('finds the top-level "resources" array field, not the nested useCases[].id: "resources"', () => {
    const bounds = findRootObjectBounds(productsDetails);
    const entry = findObjectFieldRange(productsDetails, bounds, 'ai-booking-engine', 'json-array');
    const resources = findArrayFieldRange(productsDetails, entry, 'resources', 'json-array');
    assert.ok(resources);
    const items = JSON.parse(`[${productsDetails.slice(resources.start, resources.end)}]`);
    assert.ok(items.every((it) => typeof it.url === 'string'), 'every resources[] item should be a real resource with a url, not the nested useCases entry');
    assert.ok(items.some((it) => it.url === '/docs/booking/api/'));
  });
});

describe('removeArrayItemByField', () => {
  test('removes the one matching resources[] item by url (absolute-vs-relative variant), leaves the rest untouched', () => {
    const bounds = findRootObjectBounds(productsDetails);
    const entry = findObjectFieldRange(productsDetails, bounds, 'ai-booking-engine', 'json-array');
    const resources = findArrayFieldRange(productsDetails, entry, 'resources', 'json-array');
    const before = JSON.parse(`[${productsDetails.slice(resources.start, resources.end)}]`);

    const newContent = removeArrayItemByField(
      productsDetails, resources, 'url',
      ['https://zunkireelabs.com/docs/booking/api/', '/docs/booking/api/', '/docs/booking/api'],
      'json-array',
    );
    assert.ok(newContent);
    assert.ok(JSON.parse(newContent)); // still valid JSON

    const reparsedBounds = findRootObjectBounds(newContent);
    const reparsedEntry = findObjectFieldRange(newContent, reparsedBounds, 'ai-booking-engine', 'json-array');
    const reparsedResources = findArrayFieldRange(newContent, reparsedEntry, 'resources', 'json-array');
    const after = JSON.parse(`[${newContent.slice(reparsedResources.start, reparsedResources.end)}]`);

    assert.equal(after.length, before.length - 1);
    assert.ok(!after.some((it) => it.url === '/docs/booking/api/'));
    assert.ok(after.some((it) => it.url === '/docs/booking/quickstart/'), 'other resources must be untouched');

    // The other product entry (dental-ai) must be completely unaffected.
    const dentalEntryBefore = findObjectFieldRange(productsDetails, bounds, 'dental-ai', 'json-array');
    const dentalEntryAfter = findObjectFieldRange(newContent, reparsedBounds, 'dental-ai', 'json-array');
    assert.equal(
      productsDetails.slice(dentalEntryBefore.start, dentalEntryBefore.end + 1),
      newContent.slice(dentalEntryAfter.start, dentalEntryAfter.end + 1),
    );
  });

  test('returns null (honest no-match) when no item has that url', () => {
    const bounds = findRootObjectBounds(productsDetails);
    const entry = findObjectFieldRange(productsDetails, bounds, 'ai-booking-engine', 'json-array');
    const resources = findArrayFieldRange(productsDetails, entry, 'resources', 'json-array');
    assert.equal(removeArrayItemByField(productsDetails, resources, 'url', ['/docs/nonexistent/'], 'json-array'), null);
  });

  test('returns null for an unsupported format rather than guessing', () => {
    assert.equal(removeArrayItemByField('[]', { start: 0, end: 0 }, 'url', ['/x'], 'js-export-array'), null);
  });
});

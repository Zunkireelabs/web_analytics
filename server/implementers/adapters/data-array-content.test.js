import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeChange } from './data-array-content.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const locationsFixture = readFileSync(join(HERE, 'lib', '__fixtures__', 'locations.js'), 'utf8');
const comparisonsFixture = readFileSync(join(HERE, 'lib', '__fixtures__', 'comparisons.js'), 'utf8');

const fetchLocations = async () => ({ content: locationsFixture });
const fetchComparisons = async () => ({ content: comparisonsFixture });

// Three different tenants, three different configs, same adapter code —
// this is the whole point of the generic refactor.
const tenantA = {
  id: 1,
  url_file_map: {
    patterns: [
      { match: '^/locations/([^/]+)$', adapters: { faq: { id: 'data-array-content', format: 'js-export-array', dataFile: 'src/_data/locations.js', idField: 'id', itemsField: 'faqs' } } },
    ],
  },
};
const tenantB = {
  id: 2,
  url_file_map: {
    patterns: [
      { match: '^/compare/([^/]+)$', adapters: { faq: { id: 'data-array-content', format: 'js-export-array', dataFile: 'src/_data/comparisons.js', idField: 'id', itemsField: 'faqs' } } },
    ],
  },
};

describe('data-array-content computeChange — real zunkireelabs-web fixtures via generic config', () => {
  test('tenant A: resolves a real location purely from config, no hardcoded path', async () => {
    const r = await computeChange(tenantA, {
      action_type: 'faq',
      content: { page: 'https://zunkireelabs.com/locations/kathmandu/', items: [{ question: 'Q?', answer: 'A' }] },
    }, fetchLocations);
    assert.equal(r.ok, true);
    assert.equal(r.filePath, 'src/_data/locations.js');
    assert.equal(r.faqDiff.added.length, 1);
  });

  test('tenant B: resolves a real comparison from a DIFFERENT config, same adapter code', async () => {
    const r = await computeChange(tenantB, {
      action_type: 'faq',
      content: { page: 'https://zunkireelabs.com/compare/zunkiree-vs-algolia/', items: [{ question: 'Q?', answer: 'A' }] },
    }, fetchComparisons);
    assert.equal(r.ok, true);
    assert.equal(r.filePath, 'src/_data/comparisons.js');
  });

  test('no adapter config for this page -> honest no-file-mapping, not a crash', async () => {
    const r = await computeChange(tenantA, {
      action_type: 'faq',
      content: { page: 'https://zunkireelabs.com/compare/zunkiree-vs-algolia/', items: [{ question: 'Q?', answer: 'A' }] },
    }, fetchLocations);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-file-mapping');
  });

  test('id derived from last URL path segment matches a real entry', async () => {
    const r = await computeChange(tenantA, {
      action_type: 'faq',
      content: { page: 'https://zunkireelabs.com/locations/pokhara', items: [{ question: 'Q?', answer: 'A' }] },
    }, fetchLocations);
    assert.equal(r.ok, true);
  });

  test('nonexistent id -> honest no-insertion-marker', async () => {
    const r = await computeChange(tenantA, {
      action_type: 'faq',
      content: { page: 'https://zunkireelabs.com/locations/nowhere/', items: [{ question: 'Q?', answer: 'A' }] },
    }, fetchLocations);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-insertion-marker');
  });
});

// The `fields` config shape (meta-title, not faq) — this is what unblocks
// pages like /locations/kathmandu/ whose title/description live as plain
// data fields on an Eleventy pagination entry rather than in a per-page
// template file (the config gap that produced "No url_file_map entry
// matches..." for every non-faq generator on these pages until this config
// shape existed).
const tenantAWithMetaTitle = {
  id: 1,
  url_file_map: {
    patterns: [
      {
        match: '^/locations/([^/]+)$',
        adapters: {
          faq: { id: 'data-array-content', format: 'js-export-array', dataFile: 'src/_data/locations.js', idField: 'id', itemsField: 'faqs' },
          'meta-title': { id: 'data-array-content', format: 'js-export-array', dataFile: 'src/_data/locations.js', idField: 'id', fields: { title: 'title', metaDescription: 'description' } },
        },
      },
    ],
  },
};

describe('data-array-content computeChange — fields config (meta-title scalar writes)', () => {
  test('writes selected title + meta description into the real location entry, real fixture', async () => {
    const r = await computeChange(tenantAWithMetaTitle, {
      action_type: 'meta-title',
      content: {
        page: 'https://zunkireelabs.com/locations/kathmandu/',
        selectedTitle: 'AI Development in Kathmandu — Zunkiree Labs',
        metaDescription: 'A tightened, on-length meta description for the Kathmandu location page.',
      },
    }, fetchLocations);
    assert.equal(r.ok, true);
    assert.equal(r.filePath, 'src/_data/locations.js');
    assert.match(r.newContent, /title: "AI Development in Kathmandu — Zunkiree Labs"/);
    assert.match(r.newContent, /description: "A tightened, on-length meta description for the Kathmandu location page\."/);
    // sibling entries and unrelated fields on the same entry must be untouched
    assert.match(r.newContent, /id: "pokhara"/);
    assert.match(r.newContent, /phone: "\+977-9849839728"/);
  });

  test('title-only draft (no metaDescription yet) writes only the title field', async () => {
    const r = await computeChange(tenantAWithMetaTitle, {
      action_type: 'meta-title',
      content: { page: 'https://zunkireelabs.com/locations/pokhara/', selectedTitle: 'New Pokhara Title' },
    }, fetchLocations);
    assert.equal(r.ok, true);
    assert.match(r.newContent, /title: "New Pokhara Title"/);
  });

  test('no title selected yet -> honest draft-not-ready, not a crash', async () => {
    const r = await computeChange(tenantAWithMetaTitle, {
      action_type: 'meta-title',
      content: { page: 'https://zunkireelabs.com/locations/kathmandu/' },
    }, fetchLocations);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'draft-not-ready');
  });

  test('a page with no meta-title adapter configured (e.g. glossary) still falls through to the honest no-file-mapping failure', async () => {
    const tenantGlossaryOnlyFaq = {
      id: 3,
      url_file_map: {
        patterns: [
          { match: '^/glossary/([^/]+)$', adapters: { faq: { id: 'data-array-content', format: 'js-export-array', dataFile: 'src/_data/glossary.js', idField: 'id', itemsField: 'faqs' } } },
        ],
      },
    };
    const r = await computeChange(tenantGlossaryOnlyFaq, {
      action_type: 'meta-title',
      content: { page: 'https://zunkireelabs.com/glossary/agentic-commerce/', selectedTitle: 'x' },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-file-mapping');
  });
});

describe('data-array-content computeChange — json-array format, synthetic fixture', () => {
  const jsonFixture = JSON.stringify([
    { id: 'widget-a', name: 'Widget A', faqs: [{ question: 'Hand-authored', answer: 'Kept as-is' }] },
    { id: 'widget-b', name: 'Widget B' },
  ]);
  const tenantC = {
    id: 3,
    url_file_map: {
      patterns: [{ match: '^/products/([^/]+)$', adapters: { faq: { id: 'data-array-content', format: 'json-array', dataFile: 'data/products.json', idField: 'id', itemsField: 'faqs' } } }],
    },
  };
  const fetchJson = async () => ({ content: jsonFixture });

  test('appends to an existing faqs array, hand-authored item preserved', async () => {
    const r = await computeChange(tenantC, {
      action_type: 'faq',
      content: { page: 'https://example.com/products/widget-a/', items: [{ question: 'New?', answer: 'Yes.' }] },
    }, fetchJson);
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.newContent);
    assert.equal(parsed[0].faqs.length, 2);
    assert.ok(parsed[0].faqs.some((f) => f.question === 'Hand-authored'));
  });

  test('creates a brand-new faqs field when absent', async () => {
    const r = await computeChange(tenantC, {
      action_type: 'faq',
      content: { page: 'https://example.com/products/widget-b/', items: [{ question: 'Q?', answer: 'A.' }] },
    }, fetchJson);
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.newContent);
    assert.equal(parsed[1].faqs.length, 1);
  });
});

describe('data-array-content computeChange — flat-array shape (zunkireelabs-web homepage faq.json shape)', () => {
  const flatFixture = JSON.stringify([{ question: 'Existing?', answer: 'Kept as-is', _aiManaged: true }]);
  const tenantD = {
    id: 4,
    url_file_map: {
      pages: {
        '/': { adapters: { faq: { id: 'data-array-content', format: 'json-array', dataFile: 'src/_data/faq.json', shape: 'flat-array' } } },
      },
    },
  };
  const fetchFlat = async () => ({ content: flatFixture });
  const fetchEmptyFlat = async () => ({ content: '[]' });

  test('appends to an empty flat array', async () => {
    const r = await computeChange(tenantD, {
      action_type: 'faq',
      content: { page: 'https://zunkireelabs.com/', items: [{ question: 'New?', answer: 'Yes.' }] },
    }, fetchEmptyFlat);
    assert.equal(r.ok, true);
    assert.equal(r.filePath, 'src/_data/faq.json');
    const parsed = JSON.parse(r.newContent);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].question, 'New?');
  });

  test('idempotent re-apply updates the AI-managed region instead of duplicating', async () => {
    const r = await computeChange(tenantD, {
      action_type: 'faq',
      content: { page: 'https://zunkireelabs.com/', items: [{ question: 'Existing?', answer: 'Updated answer' }] },
    }, fetchFlat);
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.newContent);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].answer, 'Updated answer');
  });

  test('hand-authored items (no _aiManaged flag) are preserved alongside AI-managed ones', async () => {
    const mixedFixture = JSON.stringify([
      { question: 'Hand-authored', answer: 'Never touched' },
      { question: 'Existing?', answer: 'Kept as-is', _aiManaged: true },
    ]);
    const r = await computeChange(tenantD, {
      action_type: 'faq',
      content: { page: 'https://zunkireelabs.com/', items: [{ question: 'New?', answer: 'Yes.' }] },
    }, async () => ({ content: mixedFixture }));
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.newContent);
    assert.equal(parsed.length, 2);
    assert.ok(parsed.some((f) => f.question === 'Hand-authored'));
    assert.ok(parsed.some((f) => f.question === 'New?'));
    assert.ok(!parsed.some((f) => f.question === 'Existing?'));
  });

  test('"shape: flat-array" + "idField" together is an honest invalid-config, not a silent guess', async () => {
    const badTenant = {
      id: 5,
      url_file_map: {
        pages: {
          '/': { adapters: { faq: { id: 'data-array-content', format: 'json-array', dataFile: 'src/_data/faq.json', shape: 'flat-array', idField: 'id' } } },
        },
      },
    };
    const r = await computeChange(badTenant, {
      action_type: 'faq',
      content: { page: 'https://zunkireelabs.com/', items: [{ question: 'Q?', answer: 'A.' }] },
    }, fetchFlat);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid-config');
  });

  test('flat-array config needs no itemsField — only dataFile/shape', async () => {
    const r = await computeChange(tenantD, {
      action_type: 'faq',
      content: { page: 'https://zunkireelabs.com/', items: [{ question: 'New?', answer: 'Yes.' }] },
    }, fetchEmptyFlat);
    assert.equal(r.ok, true);
    assert.equal(r.changedRegions[0].field, '(root array)');
  });

  // renderMode is always 'visible' here — resolve.js's resolveImplementerForApply
  // only ever routes a 'faq' draft to this adapter once the real render-mode
  // decision (lib/faq-render-mode.js) has already come out 'visible', so this
  // adapter never has to (and never does) redecide it. Without this field,
  // store/drafts.js's countVisibleFaqDrafts/hasImplementedVisibleFaqForPage
  // can't see drafts this adapter wrote at all — see that function's comment.
  test('always stamps renderMode: visible on its result', async () => {
    const r = await computeChange(tenantD, {
      action_type: 'faq',
      content: { page: 'https://zunkireelabs.com/', items: [{ question: 'New?', answer: 'Yes.' }] },
    }, fetchEmptyFlat);
    assert.equal(r.ok, true);
    assert.equal(r.renderMode, 'visible');
  });
});

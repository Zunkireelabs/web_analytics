import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeChange, isDataReady } from './data-array-content.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const locationsFixture = readFileSync(join(HERE, 'lib', '__fixtures__', 'locations.js'), 'utf8');
const comparisonsFixture = readFileSync(join(HERE, 'lib', '__fixtures__', 'comparisons.js'), 'utf8');

const fetchLocations = async () => ({ content: locationsFixture });
const fetchComparisons = async () => ({ content: comparisonsFixture });

// Stub for the schemaField insert-path's live-page duplicate check — a page
// with no existing live schema of any type, so inserting is always allowed.
const analyzeNoExistingSchema = async () => ({ ok: true, analysis: { schemaTypes: [] } });

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

// Regression for the production incident (zunkireelabs.com's index page
// shipped a second, visually mismatched Q&A block): this adapter's
// scalarValuesFromDraft used to call marker-merge's buildMergeValues with
// only (actionType, content, mode, componentTemplates) — silently dropping
// the site's designProfile, the 5th argument buildMergeValues uses to
// project the site's REAL accordion/component markup when no explicit
// componentTemplates entry is configured. Losing that argument meant any
// site relying on the profile projection (rather than an explicit
// componentTemplates entry) got marker-merge.js's generic DEFAULT_* markup
// instead — a real, silent design mismatch with no gate catching it.
describe('data-array-content computeScalarFieldChange — designProfile plumbing', () => {
  const usableProfile = {
    version: 2,
    typography: { body: 'text-base text-gray-700', heading: { item: 'text-2xl font-semibold' } },
    layout: { container: 'container-custom' },
    components: {}, // no captured accordion — qa-content's projector doesn't need one
  };
  const tenantWithFieldsQa = (designProfile) => ({
    id: 1,
    url_file_map: {
      siteRoot: { designProfile },
      patterns: [
        { match: '^/locations/([^/]+)$', adapters: { 'qa-content': { id: 'data-array-content', format: 'js-export-array', dataFile: 'src/_data/locations.js', idField: 'id', fields: { qaContent: 'qaHtml' } } } },
      ],
    },
  });

  test('a designProfile on the site is actually used to render — not silently dropped in favor of the generic default', async () => {
    const r = await computeChange(tenantWithFieldsQa(usableProfile), {
      action_type: 'qa-content',
      content: { page: 'https://zunkireelabs.com/locations/kathmandu/', items: [{ question: 'Q?', answer: 'A' }] },
    }, fetchLocations);
    assert.equal(r.ok, true);
    const written = r.changedRegions.find((c) => c.field === 'qaContent');
    assert.ok(written, 'expected the qaContent field to be written');
    // The profile's own typography class must appear in the rendered HTML —
    // proof the projection ran — and the hardcoded generic wrapper class
    // marker-merge.js's DEFAULT_QA_TEMPLATE uses must NOT appear.
    assert.match(written.after, /text-2xl font-semibold/);
    assert.doesNotMatch(written.after, /class=\\"qa-content\\"/);
  });

  test('with no designProfile at all, still falls back to the generic default rather than crashing', async () => {
    const r = await computeChange(tenantWithFieldsQa(null), {
      action_type: 'qa-content',
      content: { page: 'https://zunkireelabs.com/locations/kathmandu/', items: [{ question: 'Q?', answer: 'A' }] },
    }, fetchLocations);
    assert.equal(r.ok, true);
    const written = r.changedRegions.find((c) => c.field === 'qaContent');
    assert.match(written.after, /class=\\"qa-content\\"/);
  });
});

// Regression for the 2026-09-10 incident (PR #92, 7 zunkireelabs.com blog
// posts): this adapter's scalarValuesFromDraft/computeScalarFieldChange
// computed `page` from the draft but never passed it into buildMergeValues,
// so marker-merge.js's blog-context sanitization (isBlogPage/
// sanitizeCapturedTemplate — added 2026-09-09 for exactly this class of
// defect) silently never ran for ANY page generated through this
// data-array adapter (i.e. every pagination-generated page, blog posts
// included) — only the marker-splice path (backend.js) ever threaded page
// through. A site's captured section-scale componentTemplates.faq (real
// homepage markup, container + section-headline heading) shipped verbatim
// into blog article body copy as a result.
describe('data-array-content computeScalarFieldChange — blog page context reaches buildMergeValues', () => {
  const sectionScaleFaqTemplate = {
    wrapper: '<dl class="container-custom py-12 md:py-20">\n{{ROWS}}\n</dl>',
    row: '  <dt class="text-2xl md:text-3xl font-normal text-gray-900">{{QUESTION}}</dt>\n  <dd class="text-lg text-gray-600">{{ANSWER}}</dd>',
  };
  const blogJsonFixture = JSON.stringify([
    { id: 'exploring-the-best-it-companies-in-nepal' },
    { id: 'some-guide' },
  ]);
  const fetchBlogPosts = async () => ({ content: blogJsonFixture });
  // `fields` (a plain string field holding rendered HTML), same shape as the
  // existing designProfile-plumbing test's `qaContent: 'qaHtml'` above —
  // this is the actual code path (computeScalarFieldChange ->
  // scalarValuesFromDraft -> buildMergeValues) the 2026-09-10 incident went
  // through. An `itemsField` config (raw question/answer items, no rendered
  // HTML/componentTemplates involved at all) never touches buildMergeValues
  // and isn't the shape that broke.
  const tenantBlogFaq = {
    id: 1,
    url_file_map: {
      siteRoot: { componentTemplates: { faq: sectionScaleFaqTemplate } },
      patterns: [
        { match: '^/blog/([^/]+)/?$', adapters: { faq: { id: 'data-array-content', format: 'json-array', dataFile: 'src/_data/blog.json', idField: 'id', fields: { faq: 'faqHtml' } } } },
      ],
    },
  };

  test('a blog-post draft strips the captured template\'s section-container/heading-scale classes', async () => {
    const r = await computeChange(tenantBlogFaq, {
      action_type: 'faq',
      content: { page: 'https://zunkireelabs.com/blog/exploring-the-best-it-companies-in-nepal/', items: [{ question: 'Q?', answer: 'A' }] },
    }, fetchBlogPosts);
    assert.equal(r.ok, true);
    const written = r.changedRegions.find((c) => c.field === 'faq');
    assert.ok(written, 'expected the faqHtml field to be written');
    assert.doesNotMatch(written.after, /container-custom/, 'blog post must not get the section-level container');
    assert.doesNotMatch(written.after, /md:text-3xl/, 'blog post must not get the section-headline-scale heading');
  });

  test('a page type this site conventionally builds AS its own section (a service page) keeps the site\'s real captured styling untouched', async () => {
    const tenantNonBlogFaq = {
      ...tenantBlogFaq,
      url_file_map: {
        ...tenantBlogFaq.url_file_map,
        // Same adapter/template/data file, but a /services/ route — per
        // classifyPageType this is a page type sites conventionally build
        // with their own dedicated, section-scale FAQ block (same
        // established behavior marker-merge.test.js's 2026-09-09 regression
        // coverage already locks in for /services/), so the real captured
        // styling should ship unmodified here.
        patterns: [
          { match: '^/services/([^/]+)/?$', adapters: { faq: { id: 'data-array-content', format: 'json-array', dataFile: 'src/_data/blog.json', idField: 'id', fields: { faq: 'faqHtml' } } } },
        ],
      },
    };
    const r = await computeChange(tenantNonBlogFaq, {
      action_type: 'faq',
      content: { page: 'https://zunkireelabs.com/services/some-guide/', items: [{ question: 'Q?', answer: 'A' }] },
    }, fetchBlogPosts);
    assert.equal(r.ok, true);
    const written = r.changedRegions.find((c) => c.field === 'faq');
    assert.match(written.after, /container-custom/);
    assert.match(written.after, /md:text-3xl/);
  });
});

// nestedField — location × service pages (e.g. /locations/kathmandu/aeo-seo/),
// where the real content lives at services.<serviceId> on the location
// object: a plain KEYED object, not another id-matched array entry. Real
// report this closes: these pages produced "No url_file_map entry matches"
// for every generator, since the old idFromPageUrl (last URL segment only)
// had no way to express "match the location by its OWN id, then reach one
// level deeper into a specific named property."
const tenantAWithNestedServices = {
  id: 1,
  url_file_map: {
    patterns: [
      {
        match: '^/locations/([^/]+)/([^/]+)/?$',
        adapters: {
          'meta-title': { id: 'data-array-content', format: 'js-export-array', dataFile: 'src/_data/locations.js', idField: 'id', nestedField: 'services', fields: { title: 'title', metaDescription: 'description' } },
        },
      },
    ],
  },
};

describe('data-array-content computeChange — nestedField (location × service pages)', () => {
  test('writes into the real nested services.<id> sub-object, sibling services and fields untouched', async () => {
    const r = await computeChange(tenantAWithNestedServices, {
      action_type: 'meta-title',
      content: {
        page: 'https://zunkireelabs.com/locations/kathmandu/aeo-seo/',
        selectedTitle: 'AEO & SEO in Kathmandu — Zunkiree Labs',
        metaDescription: 'Refreshed, on-length meta description for the Kathmandu AEO/SEO service page.',
      },
    }, fetchLocations);
    assert.equal(r.ok, true);
    assert.match(r.newContent, /title: "AEO & SEO in Kathmandu — Zunkiree Labs"/);
    assert.match(r.newContent, /description: "Refreshed, on-length meta description for the Kathmandu AEO\/SEO service page\."/);
    // a sibling service's own title on the SAME location must be untouched
    assert.match(r.newContent, /title: "AI Development Services in Kathmandu"/);
    // the location's own top-level title (a different field entirely) must be untouched
    assert.match(r.newContent, /title: "AI Development Company in Kathmandu \| Zunkiree Labs"/);
  });

  test('a location with no services object at all -> honest no-insertion-marker, not a guess', async () => {
    const r = await computeChange(tenantAWithNestedServices, {
      action_type: 'meta-title',
      content: { page: 'https://zunkireelabs.com/locations/pokhara/aeo-seo/', selectedTitle: 'x' },
    }, fetchLocations);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-insertion-marker');
    assert.match(r.error, /services\.aeo-seo/);
  });

  test('a real location but a service id that does not exist on it -> honest no-insertion-marker', async () => {
    const r = await computeChange(tenantAWithNestedServices, {
      action_type: 'meta-title',
      content: { page: 'https://zunkireelabs.com/locations/kathmandu/not-a-real-service/', selectedTitle: 'x' },
    }, fetchLocations);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-insertion-marker');
  });

  test('URL too short to have both a location and a service segment -> honest no-file-mapping', async () => {
    const r = await computeChange(tenantAWithNestedServices, {
      action_type: 'meta-title',
      content: { page: 'https://zunkireelabs.com/locations/kathmandu/', selectedTitle: 'x' },
    }, fetchLocations);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-file-mapping');
  });
});

// isDataReady is the pre-flight readiness check agents/lib/recommendations.js
// calls before ever surfacing a recommendation, so a page whose nested
// service data doesn't exist yet stops resurfacing as a dead-end
// recommendation every refresh (previously only discovered per-draft, at
// apply time, via the exact same no-insertion-marker error the tests above
// assert on). Same fixture/config, so "ready according to this check" and
// "computeChange actually succeeds" can never quietly disagree.
describe('data-array-content isDataReady — pre-flight check mirrors computeChange exactly', () => {
  const config = tenantAWithNestedServices.url_file_map.patterns[0].adapters['meta-title'];

  test('a real location + real service -> ready', async () => {
    const ready = await isDataReady(tenantAWithNestedServices, 'https://zunkireelabs.com/locations/kathmandu/aeo-seo/', config, fetchLocations);
    assert.equal(ready, true);
  });

  test('a location with no services object at all -> not ready', async () => {
    const ready = await isDataReady(tenantAWithNestedServices, 'https://zunkireelabs.com/locations/pokhara/aeo-seo/', config, fetchLocations);
    assert.equal(ready, false);
  });

  test('a real location but a service id that does not exist on it -> not ready', async () => {
    const ready = await isDataReady(tenantAWithNestedServices, 'https://zunkireelabs.com/locations/kathmandu/not-a-real-service/', config, fetchLocations);
    assert.equal(ready, false);
  });

  test('URL too short to have both segments -> not ready', async () => {
    const ready = await isDataReady(tenantAWithNestedServices, 'https://zunkireelabs.com/locations/kathmandu/', config, fetchLocations);
    assert.equal(ready, false);
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

// schemaField config — real report: "Add Review or AggregateRating JSON-LD
// schema" recommendations for /locations/<location>/<service>/ pages (e.g.
// /locations/kathmandu/web-development/) always failed with "No
// url_file_map entry matches", because these pages are rendered by ONE
// shared pagination template (location-service.njk) for every
// location×service combination — a marker splice there would apply one
// page's schema to every page using that template, so schema was never
// wired to `file`/marker-merge for this pattern (see url-file-map.js's
// isPageMapped/resolveAdapter). schemaField is the safe fix: it writes into
// this specific entry's own field in the data array (the same real
// per-page-uniqueness mechanism `fields` already proves out for
// meta-title), for the site's own template to render.
const tenantAWithSchema = {
  id: 1,
  url_file_map: {
    patterns: [
      {
        match: '^/locations/([^/]+)/([^/]+)/?$',
        adapters: {
          schema: { id: 'data-array-content', format: 'js-export-array', dataFile: 'src/_data/locations.js', idField: 'id', nestedField: 'services', schemaField: 'reviewSchema' },
        },
      },
    ],
  },
};

describe('data-array-content computeChange — schemaField (JSON-LD object writes)', () => {
  const jsonLd = { '@context': 'https://schema.org', '@type': 'Article', headline: 'Web Development in Kathmandu' };

  test('inserts a brand-new schema field into the real nested services.<id> sub-object', async () => {
    const r = await computeChange(tenantAWithSchema, {
      action_type: 'schema',
      content: { page: 'https://zunkireelabs.com/locations/kathmandu/web-development/', jsonLd, placeholderFields: [] },
    }, fetchLocations, undefined, analyzeNoExistingSchema);
    assert.equal(r.ok, true);
    assert.equal(r.filePath, 'src/_data/locations.js');
    assert.match(r.newContent, /reviewSchema:\s*\{/);
    assert.match(r.newContent, /"headline":\s*"Web Development in Kathmandu"/);
    // sibling service and the location's own top-level fields untouched
    assert.match(r.newContent, /title: "AI Development Services in Kathmandu"/);
    assert.match(r.newContent, /id: "pokhara"/);
  });

  test('splices an EXISTING schema field in place on a second draft, does not duplicate it', async () => {
    const first = await computeChange(tenantAWithSchema, {
      action_type: 'schema',
      content: { page: 'https://zunkireelabs.com/locations/kathmandu/web-development/', jsonLd, placeholderFields: [] },
    }, fetchLocations, undefined, analyzeNoExistingSchema);
    const fetchAfterFirst = async () => ({ content: first.newContent });
    const updatedJsonLd = { ...jsonLd, headline: 'Updated headline' };
    const second = await computeChange(tenantAWithSchema, {
      action_type: 'schema',
      content: { page: 'https://zunkireelabs.com/locations/kathmandu/web-development/', jsonLd: updatedJsonLd, placeholderFields: [] },
    }, fetchAfterFirst);
    assert.equal(second.ok, true);
    assert.match(second.newContent, /"headline":\s*"Updated headline"/);
    assert.doesNotMatch(second.newContent, /Web Development in Kathmandu/);
    assert.equal((second.newContent.match(/reviewSchema/g) || []).length, 1);
  });

  test('no jsonLd on the draft -> honest draft-not-ready, never a silent no-op', async () => {
    const r = await computeChange(tenantAWithSchema, {
      action_type: 'schema',
      content: { page: 'https://zunkireelabs.com/locations/kathmandu/web-development/' },
    }, fetchLocations);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'draft-not-ready');
  });

  test('unresolved placeholder fields refuse to auto-apply, same rule as the marker-merge schema path', async () => {
    const r = await computeChange(tenantAWithSchema, {
      action_type: 'schema',
      content: {
        page: 'https://zunkireelabs.com/locations/kathmandu/web-development/',
        jsonLd, placeholderFields: ['reviewRating.ratingValue'],
      },
    }, fetchLocations);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'draft-not-ready');
    assert.match(r.error, /unverified placeholder/);
  });

  test('a service id that does not exist on the location -> honest no-insertion-marker, never fabricated', async () => {
    const r = await computeChange(tenantAWithSchema, {
      action_type: 'schema',
      content: { page: 'https://zunkireelabs.com/locations/kathmandu/not-a-real-service/', jsonLd, placeholderFields: [] },
    }, fetchLocations);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-insertion-marker');
  });

  test('written content is valid JS — a fresh computeChange re-parse of the result succeeds', async () => {
    const r = await computeChange(tenantAWithSchema, {
      action_type: 'schema',
      content: { page: 'https://zunkireelabs.com/locations/kathmandu/web-development/', jsonLd, placeholderFields: [] },
    }, fetchLocations, undefined, analyzeNoExistingSchema);
    assert.equal(r.ok, true);
    const reparsed = await computeChange(tenantAWithSchema, {
      action_type: 'schema',
      content: { page: 'https://zunkireelabs.com/locations/kathmandu/aeo-seo/', jsonLd, placeholderFields: [] },
    }, async () => ({ content: r.newContent }), undefined, analyzeNoExistingSchema);
    assert.equal(reparsed.ok, true);
  });

  test('refuses to insert a NEW schema field when the live page already renders this @type (would create a duplicate)', async () => {
    const analyzeHasArticle = async () => ({ ok: true, analysis: { schemaTypes: ['Article'] } });
    const r = await computeChange(tenantAWithSchema, {
      action_type: 'schema',
      content: { page: 'https://zunkireelabs.com/locations/kathmandu/web-development/', jsonLd, placeholderFields: [] },
    }, fetchLocations, undefined, analyzeHasArticle);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'would-duplicate-schema');
    assert.match(r.error, /already has real "Article" schema/);
  });

  test('a failed live-page fetch does not block the insert — only a confirmed existing type refuses', async () => {
    const analyzeFailed = async () => ({ ok: false, error: 'timeout' });
    const r = await computeChange(tenantAWithSchema, {
      action_type: 'schema',
      content: { page: 'https://zunkireelabs.com/locations/kathmandu/web-development/', jsonLd, placeholderFields: [] },
    }, fetchLocations, undefined, analyzeFailed);
    assert.equal(r.ok, true);
  });
});

// Regression coverage for the file-scope-safety investigation: meta-title
// and faq/qa-content routinely share one dataFile (see tenantAWithMetaTitle
// above — both point at src/_data/locations.js), and github-ops.js's
// needsFamilyWriteMarker only flags that a batch's later commits touch an
// already-touched _data file — it relies on each draft's own computeChange
// being applied against the batch branch's CURRENT tip (not stale base
// content) to actually avoid clobbering an earlier draft's write. This was
// previously true only by inspection of the caller wiring (auto-remediation
// applies serially, preview/apply re-fetch off the batch branch); nothing
// exercised the actual two-draft splice sequence end-to-end.
describe('data-array-content computeChange — cross-generator batch sequencing (shared _data file safety)', () => {
  test('a meta-title draft applied after a faq draft on the same entry preserves both writes', async () => {
    const first = await computeChange(tenantAWithMetaTitle, {
      action_type: 'faq',
      content: { page: 'https://zunkireelabs.com/locations/kathmandu/', items: [{ question: 'New Q?', answer: 'New A' }] },
    }, fetchLocations);
    assert.equal(first.ok, true);

    const second = await computeChange(tenantAWithMetaTitle, {
      action_type: 'meta-title',
      content: {
        page: 'https://zunkireelabs.com/locations/kathmandu/',
        selectedTitle: 'AI Development in Kathmandu — Zunkiree Labs',
        metaDescription: 'A tightened, on-length meta description for the Kathmandu location page.',
      },
    }, async () => ({ content: first.newContent }));

    assert.equal(second.ok, true);
    // the faq draft's earlier write survives the meta-title draft's splice
    assert.match(second.newContent, /New Q\?/);
    // and the meta-title draft's own write is present
    assert.match(second.newContent, /title: "AI Development in Kathmandu — Zunkiree Labs"/);
    // an unrelated sibling entry is untouched by either draft
    assert.match(second.newContent, /id: "pokhara"/);
  });

  test('two faq drafts for different pages in the same dataFile both land, applied in sequence', async () => {
    const first = await computeChange(tenantAWithMetaTitle, {
      action_type: 'faq',
      content: { page: 'https://zunkireelabs.com/locations/kathmandu/', items: [{ question: 'Kathmandu Q?', answer: 'Kathmandu A' }] },
    }, fetchLocations);
    assert.equal(first.ok, true);

    const second = await computeChange(tenantAWithMetaTitle, {
      action_type: 'faq',
      content: { page: 'https://zunkireelabs.com/locations/pokhara/', items: [{ question: 'Pokhara Q?', answer: 'Pokhara A' }] },
    }, async () => ({ content: first.newContent }));

    assert.equal(second.ok, true);
    assert.match(second.newContent, /Kathmandu Q\?/);
    assert.match(second.newContent, /Pokhara Q\?/);
  });
});

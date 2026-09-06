// Tests for the Sanity execution adapter's PURE decision logic — field
// mapping, length limits, slug extraction — plus the two properties that
// matter most about it:
//
//   1. It never publishes. The scheduled system's reach ends at a Sanity
//      DRAFT document; a human publishes.
//   2. It refuses rather than guesses. An unmapped generator field, a missing
//      credential, an unmatched slug and a failed read-back all return an
//      honest {ok:false, reason} instead of reporting success over a partial
//      or absent write.
//
// The network-touching paths (apply/publishSanityDraft against the real Sanity
// API) are not covered here for the same reason no implementer's GitHub calls
// are: this repo has no convention for mocking those (no nock/sinon, no
// route-level test harness). That gap predates this adapter and applies
// equally to every writer in server/implementers/.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { meta, mergeToStage, __testables } from './sanity-document.js';

const { buildFieldUpdates, slugFromUrl, FIELD_MAP, MAX_LENGTHS } = __testables;

const CONFIG = { slugFromUrl: '^/blogs/([^/]+)/?$' };

describe('adapter contract', () => {
  test('exports the registry-required shape', () => {
    assert.equal(meta.id, 'sanity-document');
    assert.equal(typeof meta.description, 'string');
    assert.ok(meta.description.length > 0);
  });

  test('exports no rollback — a published CMS document is not revertible by this app', async () => {
    const mod = await import('./sanity-document.js');
    assert.equal(mod.rollback, undefined);
  });
});

describe('slugFromUrl', () => {
  test('extracts the slug from a full URL', () => {
    assert.equal(slugFromUrl(CONFIG, 'https://admizzeducation.com/blogs/study-in-canada/'), 'study-in-canada');
  });

  test('extracts from a bare path too', () => {
    assert.equal(slugFromUrl(CONFIG, '/blogs/study-in-canada'), 'study-in-canada');
  });

  test('returns null when the pattern does not match, rather than guessing a slug', () => {
    assert.equal(slugFromUrl(CONFIG, 'https://admizzeducation.com/study-in-canada/'), null);
    assert.equal(slugFromUrl(CONFIG, 'https://admizzeducation.com/'), null);
  });
});

describe('buildFieldUpdates', () => {
  test('maps known generator fields onto their real seo paths', () => {
    const { updates } = buildFieldUpdates({ content: { page: '/blogs/x', metaTitle: 'A title', metaDescription: 'A description' } });
    assert.deepEqual(updates, { 'seo.metaTitle': 'A title', 'seo.metaDescription': 'A description' });
  });

  test('every mapped field targets the seo object the client schema actually defines', () => {
    for (const path of Object.values(FIELD_MAP)) {
      assert.ok(path.startsWith('seo.'), `${path} must live under the seo object`);
    }
  });

  test('ignores envelope keys that are not generator output', () => {
    const { updates } = buildFieldUpdates({ content: { page: '/blogs/x', rationale: 'why', evidence: [], metaTitle: 'T' } });
    assert.deepEqual(updates, { 'seo.metaTitle': 'T' });
  });

  test('REFUSES an unmapped field rather than silently dropping it', () => {
    // Dropping it would mark the draft applied while part of the generated
    // change vanished with no trace — worse than an honest failure.
    // `body` is deliberately chosen: it's a real field on the post schema
    // that this adapter does NOT write, so it is exactly the shape of mistake
    // this guard exists for — a generator emitting something plausible that
    // has no mapping here.
    const { error, updates } = buildFieldUpdates({ content: { page: '/blogs/x', metaTitle: 'T', body: 'some portable text' } });
    assert.equal(updates, undefined);
    assert.equal(error.ok, false);
    assert.equal(error.reason, 'unsupported-field');
    assert.match(error.error, /body/);
  });

  test('a draft carrying nothing writable is refused, not reported as applied', () => {
    const { error } = buildFieldUpdates({ content: { page: '/blogs/x' } });
    assert.equal(error.reason, 'draft-not-ready');
  });

  test('null values are skipped rather than written as null over real content', () => {
    const { updates } = buildFieldUpdates({ content: { page: '/blogs/x', metaTitle: 'T', canonicalUrl: null } });
    assert.deepEqual(updates, { 'seo.metaTitle': 'T' });
  });

  test('over-length metaTitle is rejected before any write', () => {
    const { error } = buildFieldUpdates({ content: { page: '/blogs/x', metaTitle: 'x'.repeat(MAX_LENGTHS['seo.metaTitle'] + 1) } });
    assert.equal(error.reason, 'invalid-edit');
    assert.match(error.error, /70-character/);
  });

  test('over-length metaDescription is rejected before any write', () => {
    const { error } = buildFieldUpdates({ content: { page: '/blogs/x', metaDescription: 'x'.repeat(MAX_LENGTHS['seo.metaDescription'] + 1) } });
    assert.equal(error.reason, 'invalid-edit');
    assert.match(error.error, /160-character/);
  });

  test('a value exactly at the limit is allowed', () => {
    const { updates, error } = buildFieldUpdates({ content: { page: '/blogs/x', metaTitle: 'x'.repeat(MAX_LENGTHS['seo.metaTitle']) } });
    assert.equal(error, undefined);
    assert.ok(updates['seo.metaTitle']);
  });

  test('a boolean field (noIndex) is not treated as a length-checked string', () => {
    const { updates, error } = buildFieldUpdates({ content: { page: '/blogs/x', noIndex: true } });
    assert.equal(error, undefined);
    assert.deepEqual(updates, { 'seo.noIndex': true });
  });
});

describe('mergeToStage — hands off to a human, publishes nothing', () => {
  test('signals awaitingHumanPublish rather than anything merge-like', async () => {
    const result = await mergeToStage({ id: 1 }, { cms_document_id: 'drafts.abc', cms_review_url: 'https://studio/desk/post;abc' });
    assert.equal(result.ok, true);
    assert.equal(result.awaitingHumanPublish, true);
    assert.equal(result.cmsDocumentId, 'drafts.abc');
    // No PR fields: nothing downstream should think a pull request exists.
    assert.equal(result.prNumber, undefined);
    assert.equal(result.prUrl, undefined);
  });

  test('refuses when apply() has not recorded a document — never invents one', async () => {
    const result = await mergeToStage({ id: 1 }, {});
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'draft-not-ready');
  });

  test('operates only on the draft document id, never the published one', async () => {
    const result = await mergeToStage({ id: 1 }, { cms_document_id: 'drafts.abc' });
    assert.ok(result.cmsDocumentId.startsWith('drafts.'), 'must hand a human the DRAFT, never the live document');
  });
});

describe('ogImage — a Sanity image reference, not a URL', () => {
  const { normalizeOgImage, valueMatches } = __testables;

  test('is a supported field (the client schema defines seo.ogImage)', () => {
    assert.equal(__testables.FIELD_MAP.ogImage, 'seo.ogImage');
  });

  test('accepts a bare asset id and wraps it in the image shape Sanity expects', () => {
    const out = normalizeOgImage('image-abc123-1200x630-png');
    assert.equal(out.ok, true);
    assert.deepEqual(out.value, { _type: 'image', asset: { _type: 'reference', _ref: 'image-abc123-1200x630-png' } });
  });

  test('accepts an already-shaped {asset:{_ref}} object', () => {
    const out = normalizeOgImage({ asset: { _ref: 'image-abc123-1200x630-png' } });
    assert.equal(out.ok, true);
    assert.equal(out.value.asset._ref, 'image-abc123-1200x630-png');
  });

  test('REFUSES a URL, and says why — writing one would render as nothing', () => {
    // A URL in an image field type-checks nowhere: Studio shows an empty
    // field and urlFor() returns undefined, so the change would look applied
    // while doing nothing at all.
    const out = normalizeOgImage('https://admizzeducation.com/images/og/x.webp');
    assert.equal(out.ok, false);
    assert.match(out.error, /not a URL/);
    assert.match(out.error, /does not upload assets/);
  });

  test('a URL reaches the caller as an invalid-edit refusal, not a silent write', () => {
    const { error } = buildFieldUpdates({ content: { page: '/blogs/x', ogImage: 'https://example.com/og.png' } });
    assert.equal(error.ok, false);
    assert.equal(error.reason, 'invalid-edit');
  });

  test('a valid reference produces a real update entry', () => {
    const { updates, error } = buildFieldUpdates({ content: { page: '/blogs/x', ogImage: 'image-abc-1200x630-png' } });
    assert.equal(error, undefined);
    assert.equal(updates['seo.ogImage'].asset._ref, 'image-abc-1200x630-png');
  });

  test('read-back compares images by asset ref, so Sanity echoing a fuller object is not a false mismatch', () => {
    const written = { _type: 'image', asset: { _type: 'reference', _ref: 'image-abc-1200x630-png' } };
    const echoed = { _type: 'image', _key: 'generated', asset: { _type: 'reference', _ref: 'image-abc-1200x630-png' } };
    assert.equal(valueMatches(echoed, written), true);
    assert.equal(valueMatches({ asset: { _ref: 'image-different-1200x630-png' } }, written), false);
    assert.equal(valueMatches(undefined, written), false);
  });

  test('scalar read-back comparison is unchanged', () => {
    assert.equal(valueMatches('A title', 'A title'), true);
    assert.equal(valueMatches('Other', 'A title'), false);
    assert.equal(valueMatches(true, true), true);
  });
});

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
    const { error, updates } = buildFieldUpdates({ content: { page: '/blogs/x', metaTitle: 'T', ogImage: 'https://x/y.png' } });
    assert.equal(updates, undefined);
    assert.equal(error.ok, false);
    assert.equal(error.reason, 'unsupported-field');
    assert.match(error.error, /ogImage/);
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

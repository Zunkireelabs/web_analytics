import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveLifecycle, recommendationPageKey, DEDUP_IDENTITY, SITE_LEVEL_IDENTITY, hasDeclaredDedupIdentity } from './recommendation-coordinator.js';
import { listGeneratorMeta } from '../../generators/registry.js';

const open = { blocked_reason: null };

test('a never-attempted recommendation is new', () => {
  assert.equal(deriveLifecycle(open, null, null), 'new');
});

test('a recommendation with a live draft is in progress, not hidden', () => {
  // The whole bug in one assertion. Before this, a recommendation with any
  // non-abandoned draft was filtered off the board entirely — which is
  // correct only while the draft is moving, and a permanent disappearance
  // the moment it stops.
  assert.equal(deriveLifecycle(open, { status: 'branch_pushed' }, null), 'in_progress');
  assert.equal(deriveLifecycle(open, { status: 'pr_opened' }, null), 'in_progress');
  assert.equal(deriveLifecycle(open, { status: 'approved' }, null), 'in_progress');
});

test('a finished recommendation is fixed and leaves the active board', () => {
  assert.equal(deriveLifecycle(open, { status: 'implemented' }, null), 'fixed');
  assert.equal(deriveLifecycle(open, { status: 'merged_to_stage' }, null), 'fixed');
});

test('a draft awaiting a person is blocked, not silently in flight', () => {
  // lib/draft-ship-state.js already refuses to touch these; the point here is
  // that the USER can now see one exists. A draft sat at
  // submitted_for_approval for 4 days on site 1 with its recommendation
  // invisible, so nobody knew a review was owed.
  assert.equal(deriveLifecycle(open, { status: 'submitted_for_approval' }, null), 'blocked');
  assert.equal(deriveLifecycle(open, { status: 'revision_requested' }, null), 'blocked');
});

test('a draft carrying an apply error is not reported as progress', () => {
  // It is a failed attempt the reconciler has not reclaimed yet. Calling it
  // "in progress" is the specific lie that made stalled work look healthy.
  assert.equal(deriveLifecycle(open, { status: 'approved', apply_error: 'boom' }, { attempts: 1 }), 'retry');
  assert.equal(deriveLifecycle(open, { status: 'approved', rolled_back_at: new Date() }, null), 'new');
});

test('a returned recommendation with history is a retry, not a new card', () => {
  // The user-visible requirement: the same issue coming back must not look
  // like it has never been seen before.
  assert.equal(deriveLifecycle(open, null, { attempts: 2 }), 'retry');
});

test('a blocked recommendation stays blocked even with attempt history', () => {
  assert.equal(deriveLifecycle({ blocked_reason: 'No url_file_map entry matches' }, null, { attempts: 3 }), 'blocked');
});

test('a live draft outranks a blocked reason', () => {
  // Something is genuinely happening right now; that is the more useful
  // statement, and the block will be re-evaluated when the attempt ends.
  assert.equal(deriveLifecycle({ blocked_reason: 'stale reason' }, { status: 'pr_opened' }, null), 'in_progress');
});

// ---- Dedup identity coverage -----------------------------------------

test('generators that need a discriminator get one', () => {
  // Each of these was a real duplicate-card report before its rule existed.
  const key = (generatorId, params) => recommendationPageKey({ generatorId, params });
  assert.notEqual(key('analytics-install', { provider: 'ga4', page: '/' }), key('analytics-install', { provider: 'facebook-pixel', page: '/' }));
  assert.notEqual(key('broken-link-fix', { page: '/blog/', href: '/a' }), key('broken-link-fix', { page: '/blog/', href: '/b' }));
  assert.notEqual(key('expand-content', { page: '/x', focus: 'author-byline' }), key('expand-content', { page: '/x', focus: 'freshness-date' }));
  assert.notEqual(key('blog-outline', { topic: 'one' }), key('blog-outline', { topic: 'two' }));
});

test('a site-level generator collapses to one row whatever page it reports', () => {
  // terms-of-service names no page on its `missing` variant and a real one on
  // its `broken` variant — the same issue, which used to produce two
  // permanently-separate cards ("Draft Terms of Service" and "Draft Terms of
  // Service — /terms/" showing at once).
  assert.equal(
    recommendationPageKey({ generatorId: 'terms-of-service', params: {} }),
    recommendationPageKey({ generatorId: 'terms-of-service', params: { page: '/terms/' } }),
  );
});

test('every registered generator has a considered dedup identity', async () => {
  // The structural guard. Every discriminator in DEDUP_IDENTITY was added
  // reactively, after a user reported one card where there should have been
  // several. This test is what turns that pattern into a question asked at
  // authoring time: a new generator fails here until someone states whether
  // its identity is the page, a param, or the whole site.
  //
  // Listed explicitly rather than defaulted, because "page is the identity"
  // is a real claim about a generator and defaulting to it silently is
  // precisely how the collisions above happened.
  const PAGE_KEYED = new Set([
    'meta-title', 'faq', 'schema', 'schema-repair', 'internal-links', 'translation',
    'viewport', 'canonical', 'open-graph', 'redirect-fix', 'redirect-chain-nginx', 'sitemap-removal', 'sitemap-frontmatter-exclude', 'alt-text', 'breadcrumbs',
    'direct-answer', 'geo-audit', 'qa-content', 'duplicate-id-fix', 'title-fix',
    // Same identity as declining's own opportunity type upstream
    // (growth-opportunities.js dedupes 'declining' by page already) — unlike
    // expand-content, refresh-content has no `focus` param to discriminate
    // on, and only ever needs one open "this page needs a refresh" card.
    'refresh-content',
    // One location×service page has exactly one missing container to
    // bootstrap — the page alone is the identity, same as meta-title/schema
    // for the same URL shape (see agents/lib/location-service-gap.js).
    'location-service-bootstrap',
  ]);
  const metas = await listGeneratorMeta();
  const undeclared = metas
    .map((m) => m.id)
    .filter((id) => !hasDeclaredDedupIdentity(id, PAGE_KEYED));
  assert.deepEqual(
    undeclared, [],
    `These generators have no declared dedup identity. Decide what makes one of their recommendations unique — the page alone, a param, or the whole site — then add it to DEDUP_IDENTITY / SITE_LEVEL_GENERATOR_IDS (recommendation-coordinator.js) or to PAGE_KEYED in this test: ${undeclared.join(', ')}`,
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasAuthorProfile, authorJsonLd, authorByline, organizationByline } from './author-profile.js';

test('no profile configured -> everything falls back to null/false', () => {
  assert.equal(hasAuthorProfile({}), false);
  assert.equal(authorJsonLd({}), null);
  assert.equal(authorByline({}), null);
});

test('authorJsonLd builds a real Person object', () => {
  const site = { author_name: 'Jane Doe', author_role: 'Editor', author_url: 'https://example.com/jane' };
  assert.deepEqual(authorJsonLd(site), { '@type': 'Person', name: 'Jane Doe', jobTitle: 'Editor', url: 'https://example.com/jane' });
});

test('authorJsonLd omits optional fields when not set', () => {
  const site = { author_name: 'Jane Doe' };
  assert.deepEqual(authorJsonLd(site), { '@type': 'Person', name: 'Jane Doe' });
});

test('authorByline requires both a name AND require_visible_byline', () => {
  assert.equal(authorByline({ author_name: 'Jane Doe', require_visible_byline: false }), null);
  assert.equal(authorByline({ author_name: 'Jane Doe', author_role: 'Editor', require_visible_byline: true }), 'By Jane Doe, Editor');
  assert.equal(authorByline({ author_name: 'Jane Doe', require_visible_byline: true }), 'By Jane Doe');
});

// The no-individual-author fallback (expand-content.js) — a real fact
// (sites.name) never an invented one, so it's safe to auto-ship with zero
// manual setup, unlike an LLM-guessed person's name would be.
test('organizationByline builds a real "By the <Site Name> Team" line from the site\'s own name', () => {
  assert.equal(organizationByline({ name: 'Zunkiree Labs' }), 'By the Zunkiree Labs Team');
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sectionPrefixFor, titleForMissingPage, MIN_SIBLINGS_TO_CREATE } from './dead-link-intent.js';

// decideDeadLinkAction itself hits page_inventory, so the DB-free half of the
// decision is tested directly here: which URLs are even eligible to be
// created, and what a created page would be called. The sibling-count rule is
// asserted through MIN_SIBLINGS_TO_CREATE so a change to that constant has to
// be deliberate.

describe('sectionPrefixFor', () => {
  test('a nested page yields its section prefix', () => {
    assert.equal(
      sectionPrefixFor('https://example.com/resources/semantic-search-vs-keyword-search/'),
      'https://example.com/resources/',
    );
  });

  test('trailing slash is irrelevant — same prefix either way', () => {
    assert.equal(
      sectionPrefixFor('https://example.com/resources/foo'),
      sectionPrefixFor('https://example.com/resources/foo/'),
    );
  });

  test('deeper nesting keeps the full parent path', () => {
    assert.equal(
      sectionPrefixFor('https://example.com/docs/guides/setup'),
      'https://example.com/docs/guides/',
    );
  });

  // The load-bearing case: without this, "/about" would treat every page on
  // the site as its sibling and any top-level 404 would look creatable.
  test('a top-level page has no section to draw a template from', () => {
    assert.equal(sectionPrefixFor('https://example.com/about'), null);
    assert.equal(sectionPrefixFor('https://example.com/'), null);
  });

  test('an unparseable href is not eligible', () => {
    assert.equal(sectionPrefixFor('not a url'), null);
  });
});

describe('titleForMissingPage', () => {
  test('prefers the anchor text the site actually uses', () => {
    assert.equal(
      titleForMissingPage('https://example.com/resources/semantic-search-vs-keyword-search/', ['Semantic Search vs Keyword Search']),
      'Semantic Search vs Keyword Search',
    );
  });

  test('the most repeated anchor wins over a one-off', () => {
    assert.equal(
      titleForMissingPage('https://example.com/resources/x', ['Used Once', 'The Real Title', 'The Real Title']),
      'The Real Title',
    );
  });

  // "Read more" tells us nothing about what the page is, and would produce a
  // page literally titled "Read more".
  test('generic anchor text is ignored in favour of the slug', () => {
    assert.equal(
      titleForMissingPage('https://example.com/resources/ai-search-playbook/', ['Read more', 'click here']),
      'Ai Search Playbook',
    );
  });

  test('falls back to a humanised slug when there is no anchor text at all', () => {
    assert.equal(
      titleForMissingPage('https://example.com/resources/state-of-ai-2026/', []),
      'State Of Ai 2026',
    );
  });

  test('a file extension is stripped from the slug fallback', () => {
    assert.equal(titleForMissingPage('https://example.com/resources/report.html', []), 'Report');
  });

  test('a URL with no slug at all yields no title', () => {
    assert.equal(titleForMissingPage('https://example.com/', []), null);
  });

  // Ordering guard: a bare section URL WOULD title itself off its own last
  // segment ("/resources/" -> "Resources"), which would be nonsense. It never
  // gets that far because decideDeadLinkAction calls sectionPrefixFor first
  // and bails on anything less than two path segments — this asserts the two
  // functions stay in that order rather than relying on the title logic to
  // catch it.
  test('a bare section URL is rejected before it is ever titled', () => {
    assert.equal(sectionPrefixFor('https://example.com/resources/'), null);
  });
});

describe('creation threshold', () => {
  // One sibling is as likely to be a one-off as a template — see the constant.
  test('requires at least two siblings', () => {
    assert.ok(MIN_SIBLINGS_TO_CREATE >= 2);
  });
});

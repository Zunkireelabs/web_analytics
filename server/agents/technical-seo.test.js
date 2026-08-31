import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { missingSchemaFinding } from './technical-seo.js';

// Regression coverage for the auto-shippable wrong-@type bug. This finding
// used to build its action from `inferSchemaType(rep.page, [])` against a
// version of inferSchemaType that ended in `return 'Article'`, so a /pricing
// or /booking page — or every page on a non-English site — got an "Add
// schema" action asking for schema.org/Article markup. The `schema`
// generator is SAFE-tier (agents/lib/risk-tiers.js): that action can be
// drafted, approved and merged into a tenant's live site with no human
// review, and generators/schema.js only validates field VALUES, never the
// @type. Abstaining from the action while still reporting the real gap is
// the only honest outcome.

const noSchemaPage = (page, { impressions = 0, openGraphType = null } = {}) => ({
  page,
  impressions,
  technicalAudit: { ok: true, hasSchema: false },
  analysis: { schemaTypes: [], openGraphType },
});

describe('missingSchemaFinding', () => {
  test('still reports the real gap but offers no action when no page\'s type can be derived', () => {
    const finding = missingSchemaFinding([
      noSchemaPage('https://booking.example.com/pricing', { impressions: 900 }),
      noSchemaPage('https://booking.example.com/services/airport-transfer', { impressions: 400 }),
    ]);
    assert.match(finding.whyItMatters, /2 of 2 checked pages have no structured data/);
    assert.equal(finding.recommendedAction, null);
  });

  test('a non-English site gets no Article action for every one of its pages', () => {
    const finding = missingSchemaFinding([
      noSchemaPage('https://example.de/preise', { impressions: 500 }),
      noSchemaPage('https://example.de/ueber-uns', { impressions: 300 }),
    ]);
    assert.equal(finding.recommendedAction, null);
  });

  test('offers the action when the page\'s own og:type really declares its type', () => {
    const finding = missingSchemaFinding([
      noSchemaPage('https://example.de/beitrag/xyz', { impressions: 500, openGraphType: 'article' }),
    ]);
    assert.equal(finding.recommendedAction.generatorId, 'schema');
    assert.equal(finding.recommendedAction.params.schemaType, 'Article');
  });

  test('picks the highest-impression page whose type is derivable, not just the highest-impression page', () => {
    // Without pickRepresentative the untypeable 900-impression page would be
    // chosen and the whole finding would silently lose its one draftable
    // example, even though a real, honestly-typed page was available.
    const finding = missingSchemaFinding([
      noSchemaPage('https://example.com/pricing', { impressions: 900 }),
      noSchemaPage('https://example.com/blog/post', { impressions: 200 }),
      noSchemaPage('https://example.com/blog/older', { impressions: 100 }),
    ]);
    assert.equal(finding.recommendedAction.params.page, 'https://example.com/blog/post');
    assert.equal(finding.recommendedAction.params.schemaType, 'Article');
  });

  test('a real @type already on a page is used verbatim, never overridden by a path guess', () => {
    const page = noSchemaPage('https://example.com/blog/post', { impressions: 10 });
    page.analysis.schemaTypes = ['Course'];
    assert.equal(missingSchemaFinding([page]).recommendedAction.params.schemaType, 'Course');
  });

  test('no finding at all when every checked page already has schema', () => {
    assert.equal(missingSchemaFinding([
      { page: 'https://example.com/', impressions: 5, technicalAudit: { ok: true, hasSchema: true }, analysis: {} },
    ]), null);
  });
});

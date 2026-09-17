import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { missingSchemaFinding, compressionFinding } from './technical-seo.js';

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

// Regression coverage for the "server/CDN config, not draftable" abstention
// this finding used to hard-code regardless of whether the site actually
// tracks its own nginx config. Same real-capability gate as
// server/agents/redirect-chain.js's nginxConfigPath check.

const compressionPage = (page, { impressions = 0, compressed = false, ok = true } = {}) => ({
  page, impressions, compression: { ok, compressed },
});

describe('compressionFinding', () => {
  test('offers no action and stays reportOnly when the site has no tracked nginx config', () => {
    const finding = compressionFinding([
      compressionPage('https://example.com/a', { impressions: 500 }),
      compressionPage('https://example.com/b', { impressions: 100, compressed: true }),
    ], null);
    assert.match(finding.whyItMatters, /1 of 2 checked pages/);
    assert.equal(finding.recommendedAction, null);
    assert.equal(finding.reportOnly.kind, 'uncompressed-response');
    assert.match(finding.reportOnly.whyBlocked, /connect-repo/);
  });

  test('drafts a real compression-nginx action when the site tracks its own nginx config', () => {
    const finding = compressionFinding([
      compressionPage('https://example.com/a', { impressions: 500 }),
    ], 'src/config/nginx/static.conf');
    assert.equal(finding.recommendedAction.generatorId, 'compression-nginx');
    assert.equal(finding.reportOnly, null);
  });

  test('no finding at all when every checked page is already compressed', () => {
    assert.equal(compressionFinding([
      compressionPage('https://example.com/a', { compressed: true }),
    ], 'src/config/nginx/static.conf'), null);
  });

  test('pages whose compression check itself failed are excluded from both affected and checkedCount', () => {
    const finding = compressionFinding([
      compressionPage('https://example.com/a', { impressions: 10, compressed: false }),
      compressionPage('https://example.com/b', { ok: false }),
    ], null);
    assert.match(finding.whyItMatters, /1 of 1 checked pages/);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { seoDraftEligibility } from './analyst-seo-mapping.js';

// Regression coverage for the audit finding this module had NO test file at
// all — the one place a Node/Python drift in generator selection would
// surface silently (see app/investigations/drafts.py's own docstring:
// "MUST mirror server/agents/lib/analyst-seo-mapping.js::
// generatorForDecliningPage exactly ... If the two subsystems picked
// different generators for the same finding, whichever one drafts first
// would silently and permanently suppress the other, correct one").
// data-analyst-agent/tests/investigations/test_drafts.py already pins the
// Python side's mapping for the same four metrics; this is the Node-side
// counterpart, so an edit to either side without the other is caught by
// its own language's test suite, not just by reading the comment.
const site = { id: 1, website_domain: 'example.com' };

function decline({ metricKey = 'gsc_impressions', dimensionValue = 'https://example.com/page' } = {}) {
  return {
    metric_key: metricKey, insight_type: 'trend_shift', dimension_type: 'page',
    dimension_value: dimensionValue, period_start: '2026-08-18',
    evidence: { pct_change: -30 },
  };
}

describe('seoDraftEligibility — generator mapping (must stay in parity with drafts.py::_generator_for_declining_page)', () => {
  test('gsc_ctr decline -> meta-title, with query set to the page dimension value', () => {
    const action = seoDraftEligibility(site, decline({ metricKey: 'gsc_ctr' }));
    assert.equal(action.generatorId, 'meta-title');
    assert.deepEqual(action.params, { page: 'https://example.com/page', query: 'https://example.com/page' });
  });

  test('gsc_clicks decline -> meta-title, same as gsc_ctr', () => {
    const action = seoDraftEligibility(site, decline({ metricKey: 'gsc_clicks' }));
    assert.equal(action.generatorId, 'meta-title');
  });

  test('gsc_position decline -> qa-content', () => {
    const action = seoDraftEligibility(site, decline({ metricKey: 'gsc_position' }));
    assert.equal(action.generatorId, 'qa-content');
    assert.deepEqual(action.params, { page: 'https://example.com/page' });
  });

  test('gsc_impressions decline (and any other gsc_* metric) -> expand-content', () => {
    const action = seoDraftEligibility(site, decline({ metricKey: 'gsc_impressions' }));
    assert.equal(action.generatorId, 'expand-content');
    assert.deepEqual(action.params, { page: 'https://example.com/page' });
  });

  test('finding_id is deterministic and matches the exact template drafts.py::_eligibility builds', () => {
    const insight = decline({ metricKey: 'gsc_position' });
    const action = seoDraftEligibility(site, insight);
    assert.equal(action.findingId, 'analyst:gsc_position:trend_shift:2026-08-18:https://example.com/page');
  });

  test('a relative dimension_value is resolved against the site\'s own domain', () => {
    const action = seoDraftEligibility(site, decline({ dimensionValue: '/blog/post' }));
    assert.equal(action.page, 'https://example.com/blog/post');
  });
});

describe('seoDraftEligibility — eligibility gates', () => {
  test('non-gsc metric is not eligible', () => {
    assert.equal(seoDraftEligibility(site, decline({ metricKey: 'ga4_sessions' })), null);
  });

  test('site-dimension (not page-dimension) insight is not eligible', () => {
    const insight = { ...decline(), dimension_type: 'site' };
    assert.equal(seoDraftEligibility(site, insight), null);
  });

  test('an improvement (positive pct_change) is not eligible — only declines trigger', () => {
    const insight = { ...decline(), evidence: { pct_change: 20 } };
    assert.equal(seoDraftEligibility(site, insight), null);
  });

  test('a forecast_risk insight is eligible by definition, regardless of evidence', () => {
    const insight = { ...decline(), insight_type: 'forecast_risk', evidence: {} };
    assert.notEqual(seoDraftEligibility(site, insight), null);
  });
});

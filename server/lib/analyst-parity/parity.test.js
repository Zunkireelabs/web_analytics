import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildParityReport } from './report.js';

// stand-ins with the same shape as the app's own seoDraftEligibility and recommendationPageKey
const site = { id: 1, name: 'A' };
const eligibility = (_s, i) => (i.metric_key.startsWith('gsc_') && i.dimension_value.startsWith('http')
  ? { generatorId: i.metric_key === 'gsc_position' ? 'qa-content' : 'meta-title', params: { page: i.dimension_value }, page: i.dimension_value, findingId: `analyst:${i.metric_key}:${i.insight_type}:${i.period_start}:${i.dimension_value}` }
  : null);
const keyOf = ({ params }) => params.page;
const ins = (metric, page, period = '2026-11-02') => ({ metric_key: metric, insight_type: 'trend_shift', dimension_value: page, period_start: period });
const fid = (metric, page, period = '2026-11-02') => `analyst:${metric}:trend_shift:${period}:${page}`;
const rec = (id, type, page, extra = {}) => ({ id, recommendation_type: type, page, status: 'open', finding_ids: [], detecting_agents: [], supporting_agents: [], ...extra });
const run = (insights, recommendations) => buildParityReport({ site, insights, recommendations, eligibility, keyOf });

describe('analyst parity', () => {
  test('a finding that became a recommendation is created-from-analyst', () => {
    const r = run([ins('gsc_ctr', 'https://x.com/a')], [rec(1, 'meta-title', 'https://x.com/a', { finding_ids: [fid('gsc_ctr', 'https://x.com/a')], detecting_agents: ['analyst-insights'] })]);
    assert.equal(r.verdicts['created-from-analyst'], 1);
    assert.equal(r.safeToSwitchOffDraftStep, true);
  });
  test('a finding with no recommendation is MISSING and makes switching off unsafe', () => {
    const r = run([ins('gsc_ctr', 'https://x.com/a')], []);
    assert.equal(r.verdicts.missing, 1);
    assert.equal(r.safeToSwitchOffDraftStep, false);
    assert.match(r.reasonNotSafe, /lost/);
  });
  test('the same issue found first by an app detector is covered, but the analyst was never recorded: that is the merge gap', () => {
    const r = run([ins('gsc_ctr', 'https://x.com/a')], [rec(1, 'meta-title', 'https://x.com/a', { detecting_agents: ['meta-audit'], finding_ids: ['meta:/a'] })]);
    assert.equal(r.verdicts['same-issue-not-recorded'], 1);
    assert.equal(r.findings[0].recommendationId, 1);
    assert.equal(r.safeToSwitchOffDraftStep, true, 'the issue is covered, so nothing is lost; only evidence is');
  });
  test('the analyst recorded as supporter counts as merged correctly', () => {
    const r = run([ins('gsc_ctr', 'https://x.com/a')], [rec(1, 'meta-title', 'https://x.com/a', { detecting_agents: ['meta-audit'], supporting_agents: ['analyst-insights'] })]);
    assert.equal(r.verdicts['same-issue-recorded'], 1);
  });
  test('a different fix type on the same page does not count as the same issue', () => {
    const r = run([ins('gsc_ctr', 'https://x.com/a')], [rec(1, 'schema', 'https://x.com/a')]);
    assert.equal(r.verdicts.missing, 1);
  });
  test('only a closed match is "closed": nothing to ship, nothing lost', () => {
    const r = run([ins('gsc_ctr', 'https://x.com/a')], [rec(1, 'meta-title', 'https://x.com/a', { status: 'closed' })]);
    assert.equal(r.verdicts.closed, 1);
    assert.equal(r.safeToSwitchOffDraftStep, true);
  });
  test('insights the app would not fix are counted as not eligible and are not "missing"', () => {
    const r = run([ins('ga4_sessions', 'https://x.com/a'), ins('gsc_ctr', '/relative')], []);
    assert.equal(r.ineligible, 2);
    assert.equal(r.eligible, 0);
  });
  test('with NO eligible findings it refuses to call itself a pass', () => {
    const r = run([], []);
    assert.equal(r.safeToSwitchOffDraftStep, false);
    assert.match(r.reasonNotSafe, /nothing to compare/);
  });
});

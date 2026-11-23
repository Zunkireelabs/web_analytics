import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { acceptDriftChange } from './seo-drift-accept.js';

const PAGE = 'https://example.com/a/';
const rec = (over = {}) => ({ id: 5, status: 'open', recommendation_type: 'seo-drift', params: { page: PAGE }, ...over });
function deps({ recommendation = rec(), baseline = { capturedAt: '2026-11-23T00:00:00Z' } } = {}) {
  const calls = { lookups: [], accepted: [], dismissed: [] };
  return {
    calls,
    deps: {
      getRecommendationById: async (siteId, id) => { calls.lookups.push([siteId, id]); return recommendation; },
      acceptLatestAsBaseline: async (siteId, url) => { calls.accepted.push([siteId, url]); return baseline; },
      dismissRecommendation: async (id) => { calls.dismissed.push(id); },
    },
  };
}
const rejects = (p, status, re) => assert.rejects(p, (e) => e.status === status && re.test(e.message));

describe('acceptDriftChange', () => {
  test('moves the baseline to the page as it is now and dismisses the recommendation, scoped to the project', async () => {
    const t = deps();
    const r = await acceptDriftChange(7, 5, t.deps);
    assert.deepEqual(r, { status: 'dismissed', changed: true, page: PAGE, acceptedAt: '2026-11-23T00:00:00Z' });
    assert.deepEqual(t.calls.lookups, [[7, 5]]);
    assert.deepEqual(t.calls.accepted, [[7, PAGE]]);
    assert.deepEqual(t.calls.dismissed, [5]);
  });

  test('another project\'s recommendation is a 404 and nothing is touched', async () => {
    const t = deps({ recommendation: null });
    await rejects(acceptDriftChange(7, 99, t.deps), 404, /not found/i);
    assert.deepEqual(t.calls.accepted, []);
    assert.deepEqual(t.calls.dismissed, []);
  });

  test('only a drift recommendation can be accepted', async () => {
    const t = deps({ recommendation: rec({ recommendation_type: 'meta-title' }) });
    await rejects(acceptDriftChange(7, 5, t.deps), 400, /change to a live page/);
    assert.deepEqual(t.calls.accepted, []);
  });

  test('an already-closed recommendation is returned as is, nothing moves', async () => {
    const t = deps({ recommendation: rec({ status: 'dismissed' }) });
    assert.deepEqual(await acceptDriftChange(7, 5, t.deps), { status: 'dismissed', changed: false });
    assert.deepEqual(t.calls.accepted, []);
  });

  test('no saved copy of the page: a clear 409, and the recommendation stays open', async () => {
    const t = deps({ baseline: null });
    await rejects(acceptDriftChange(7, 5, t.deps), 409, /no saved copy/i);
    assert.deepEqual(t.calls.dismissed, []);
  });

  test('a recommendation with no page on record is a 409', async () => {
    const t = deps({ recommendation: rec({ params: {} }) });
    await rejects(acceptDriftChange(7, 5, t.deps), 409, /no page/i);
  });
});

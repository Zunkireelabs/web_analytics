import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// The Action Center drafts list is "changes waiting to ship". geo-audit
// produces a read-only markdown report with nothing to open a PR for: over
// its whole lifetime 70 of 71 geo-audit drafts ended 'abandoned' with reason
// 'sent_back_to_recommendations' and not one was ever implemented. Its
// findings were already excluded from recommendations back on 2026-08-10
// (see agents/lib/recommendations.js's own note) — this list was the one
// surface still showing it.
//
// The filter is deliberately in the ROUTE, not in store/drafts.js's
// listDrafts: agents/lib/agent-status.js reads the geo-audit draft to get
// the site's GEO score, so removing the row (or hiding it from every query)
// would blank that score on the dashboard.
const HIDDEN = new Set(['geo-audit']);

// Mirrors the route's own expression, kept as a pure function so the
// behavior is testable without standing up the router + auth + DB.
function visibleDrafts(drafts, actionType) {
  return actionType ? drafts : drafts.filter((d) => !HIDDEN.has(d.action_type));
}

const DRAFTS = [
  { id: 1, action_type: 'geo-audit', status: 'draft' },
  { id: 2, action_type: 'meta-title', status: 'draft' },
  { id: 3, action_type: 'blog-outline', status: 'implemented' },
];

describe('action-center drafts listing — geo-audit is report-only, not a shippable change', () => {
  test('an unfiltered listing hides geo-audit and keeps everything else', () => {
    const visible = visibleDrafts(DRAFTS, undefined);
    assert.deepEqual(visible.map((d) => d.id), [2, 3]);
  });

  test('asking for geo-audit BY NAME still returns it — nothing is made unreachable', () => {
    const onlyGeo = DRAFTS.filter((d) => d.action_type === 'geo-audit');
    assert.deepEqual(visibleDrafts(onlyGeo, 'geo-audit').map((d) => d.id), [1]);
  });

  test('an explicit filter for another type is unaffected', () => {
    const onlyMeta = DRAFTS.filter((d) => d.action_type === 'meta-title');
    assert.deepEqual(visibleDrafts(onlyMeta, 'meta-title').map((d) => d.id), [2]);
  });

  test('a listing with no geo-audit rows is returned unchanged', () => {
    const none = DRAFTS.filter((d) => d.action_type !== 'geo-audit');
    assert.deepEqual(visibleDrafts(none, undefined), none);
  });
});

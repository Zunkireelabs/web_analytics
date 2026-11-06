import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitByFreshness, maxInsightAgeDays, DEFAULT_MAX_AGE_DAYS } from './analyst-insight-freshness.js';

const now = new Date('2026-11-05T00:00:00Z');
const at = (daysAgo) => ({ generated_at: new Date(now.getTime() - daysAgo * 864e5).toISOString() });

test('insights from the last 3 days are fresh; two-month-old ones are stale (the nightly re-creation case)', () => {
  const { fresh, stale } = splitByFreshness([at(0.5), at(2.9), at(3.1), at(62)], { now });
  assert.equal(fresh.length, 2);
  assert.equal(stale.length, 2);
});
test('an insight with no or an unreadable generation time is stale: freshness cannot be shown', () => {
  const { fresh, stale } = splitByFreshness([{}, { generated_at: 'yesterday' }, at(1)], { now });
  assert.equal(fresh.length, 1);
  assert.equal(stale.length, 2);
});
test('the window is configurable and falls back to 3 days on nonsense', () => {
  assert.equal(maxInsightAgeDays({ ANALYST_INSIGHT_MAX_AGE_DAYS: '7' }), 7);
  assert.equal(maxInsightAgeDays({ ANALYST_INSIGHT_MAX_AGE_DAYS: '-1' }), DEFAULT_MAX_AGE_DAYS);
  assert.equal(maxInsightAgeDays({}), 3);
});
test('nothing given, nothing returned', () => {
  assert.deepEqual(splitByFreshness(null, { now }), { fresh: [], stale: [] });
});

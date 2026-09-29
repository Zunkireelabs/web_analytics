import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// getRecommendationByFindingId (Stage 2d of the Business Goals plan) — the
// lookup routes/action-center.js's finalizeImplemented uses to trace a
// merged draft back to the recommendation it came from, so the goal_id it
// aligned with at sync time can be carried onto the fix_impact row
// (migration 172). Searches finding_ids (the array side) rather than an
// equality match, because the recommendation a draft was drafted from may
// have since merged in more finding_ids than the one the draft itself used.

let rows;
let issued;

function fakeQuery(text, params = []) {
  const sql = text.replace(/\s+/g, ' ').trim();
  issued.push({ sql, params });
  if (sql.startsWith('SELECT * FROM recommendations WHERE site_id = $1 AND $2 = ANY(finding_ids)')) {
    return { rows };
  }
  throw new Error(`recommendations-goal-lookup.test.js fake query: unhandled SQL shape: ${sql}`);
}

const resolve = (p) => new URL(p, import.meta.url).href;
mock.module(resolve('../db.js'), { namedExports: { query: (text, params) => fakeQuery(text, params) } });
const { getRecommendationByFindingId } = await import('./recommendations.js');

beforeEach(() => { rows = []; issued = []; });

describe('getRecommendationByFindingId', () => {
  test('is scoped by site_id and searches finding_ids, not an equality match', async () => {
    rows = [{ id: 99, goal_id: 5, finding_ids: ['a:1', 'a:2'] }];
    const rec = await getRecommendationByFindingId(7, 'a:2');
    assert.equal(issued[0].params[0], 7);
    assert.equal(issued[0].params[1], 'a:2');
    assert.equal(rec.goal_id, 5);
  });

  test('returns null when no recommendation carries this finding_id', async () => {
    rows = [];
    const rec = await getRecommendationByFindingId(7, 'nowhere:1');
    assert.equal(rec, null);
  });
});

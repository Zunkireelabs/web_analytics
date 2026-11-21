import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countDesignDeferralsForFinding } from './drafts.js';
import { DESIGN_DEFERRAL_FRAGMENTS } from '../lib/attempt-classification.js';

test('counts earlier deferrals of THIS finding, using the same wording the approval stage throws', async () => {
  const calls = [];
  const queryFn = async (sql, params) => { calls.push([sql, params]); return { rows: [{ n: 2 }] }; };
  assert.equal(await countDesignDeferralsForFinding(7, 'f-1', { queryFn }), 2);
  const [sql, params] = calls[0];
  assert.match(sql, /finding_id = \$2/);
  assert.match(sql, /status = 'abandoned'/);
  assert.deepEqual(params.slice(0, 3), [7, 'f-1', 14]);
  assert.ok(params.includes(`%${DESIGN_DEFERRAL_FRAGMENTS.capture}%`));
  assert.ok(params.includes(`%${DESIGN_DEFERRAL_FRAGMENTS.shared}%`));
});

test('no finding or site means nothing to count, and no query is run', async () => {
  let ran = false;
  const queryFn = async () => { ran = true; return { rows: [{ n: 9 }] }; };
  assert.equal(await countDesignDeferralsForFinding(7, null, { queryFn }), 0);
  assert.equal(await countDesignDeferralsForFinding(null, 'f', { queryFn }), 0);
  assert.equal(ran, false);
});

test('an empty result is zero', async () => {
  assert.equal(await countDesignDeferralsForFinding(7, 'f', { queryFn: async () => ({ rows: [] }) }), 0);
});

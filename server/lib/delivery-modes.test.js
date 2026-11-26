import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryRecordMode, consolidationMode, alertsMode, conditionalGetsMode } from './delivery-modes.js';
import { recordRunIntoCycle, recordItemOutcome, closeDeliveryDay } from './delivery-cycle.js';
import { consolidateDay } from './delivery-consolidation.js';
import { batchBranchFor } from './delivery-cycle.js';

describe('the safe defaults, and a bad value never turns anything on', () => {
  test('unset: record on, consolidation and alerts log-only, conditional reads on', () => {
    assert.deepEqual([deliveryRecordMode({}), consolidationMode({}), alertsMode({}), conditionalGetsMode({})], ['on', 'log', 'log', 'on']);
  });
  test('valid values are honoured (case and spaces ignored); anything else falls back to the default', () => {
    assert.equal(consolidationMode({ DELIVERY_CONSOLIDATION_MODE: ' ON ' }), 'on');
    assert.equal(alertsMode({ DELIVERY_ALERTS_MODE: 'off' }), 'off');
    assert.equal(deliveryRecordMode({ DELIVERY_RECORD_MODE: 'off' }), 'off');
    assert.equal(consolidationMode({ DELIVERY_CONSOLIDATION_MODE: 'enforce' }), 'log', '"enforce" is not a value here, so it must not enable anything');
    assert.equal(alertsMode({ DELIVERY_ALERTS_MODE: 'true' }), 'log');
  });
});

describe('record mode off: nothing is written, nothing breaks', () => {
  test('with DELIVERY_RECORD_MODE=off no query is issued by the recorders or the close', async () => {
    const old = process.env.DELIVERY_RECORD_MODE; process.env.DELIVERY_RECORD_MODE = 'off';
    try {
      let calls = 0; const query = async () => { calls++; return { rows: [{ id: 1 }] }; };
      assert.equal(await recordRunIntoCycle(1, { attempted: 1 }, { query }), null);
      await recordItemOutcome(1, { recommendationId: 1, outcome: 'failed' }, { query });
      assert.deepEqual(await closeDeliveryDay({ sites: [{ id: 1 }], query }), []);
      assert.equal(calls, 0);
    } finally { if (old === undefined) delete process.env.DELIVERY_RECORD_MODE; else process.env.DELIVERY_RECORD_MODE = old; }
  });
});

describe('consolidation in log mode touches nothing', () => {
  test('dryRun reports what would be opened and neither recovers nor writes the day record', async () => {
    const NOW = new Date('2026-11-25T10:45:00Z'); const site = { id: 1, timezone: 'Asia/Kolkata', repo_owner: 'o', repo_name: 'r' };
    let recovered = 0; const writes = [];
    const query = async (sql) => { if (/FROM drafts/.test(sql)) return { rows: [{ id: 5 }, { id: 6 }] }; writes.push(sql); return { rows: [] }; };
    const [r] = await consolidateDay({ sites: [site], now: NOW, query, recover: async () => { recovered++; }, dryRun: true, log: () => {} });
    assert.deepEqual([r.outcome, r.pending, r.branch], ['would-open', 2, batchBranchFor(site, NOW)]);
    assert.equal(recovered, 0); assert.equal(writes.length, 0);
  });
});

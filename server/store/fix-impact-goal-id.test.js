import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// goal_id passthrough on scheduleImpactMeasurement (migration 172, Stage 2d
// of the Business Goals plan). Foundation-only: this just proves the value
// reaches the INSERT and the ON CONFLICT UPDATE, in the same "own column,
// never silently dropped" shape as page_url alongside it.

let issued;

function fakeQuery(text, params = []) {
  const sql = text.replace(/\s+/g, ' ').trim();
  issued.push({ sql, params });
  if (sql.startsWith('INSERT INTO fix_impact')) return { rows: [{ id: 1, goal_id: params[7] }] };
  throw new Error(`fix-impact-goal-id.test.js fake query: unhandled SQL shape: ${sql}`);
}

const resolve = (p) => new URL(p, import.meta.url).href;
mock.module(resolve('../db.js'), { namedExports: { query: (text, params) => fakeQuery(text, params) } });
const { scheduleImpactMeasurement } = await import('./fix-impact.js');

beforeEach(() => { issued = []; });

describe('scheduleImpactMeasurement — goal_id', () => {
  test('a real goalId is bound onto the INSERT', async () => {
    const row = await scheduleImpactMeasurement(1, {
      draftId: 42, pageUrl: '/pricing', generatorId: 'meta-title', mergedAt: new Date(), goalId: 5,
    });
    assert.equal(issued[0].sql.includes('goal_id'), true);
    assert.equal(issued[0].params[7], 5);
    assert.equal(row.goal_id, 5);
  });

  test('an omitted goalId is bound as null, not undefined', async () => {
    await scheduleImpactMeasurement(1, { draftId: 42, pageUrl: '/pricing', generatorId: 'meta-title', mergedAt: new Date() });
    assert.equal(issued[0].params[7], null);
  });
});

// deployment_id passthrough (migration 175, 2026-09 lifecycle-gap audit
// finding #2) — same "own column, never silently dropped" shape as goal_id
// above. measureOne (agents/lib/fix-impact.js) is what actually consults
// this; this just proves the value reaches the INSERT/UPDATE.
describe('scheduleImpactMeasurement — deployment_id', () => {
  test('a real deploymentId is bound onto the INSERT', async () => {
    await scheduleImpactMeasurement(1, {
      draftId: 42, pageUrl: '/pricing', generatorId: 'meta-title', mergedAt: new Date(), deploymentId: 77,
    });
    assert.equal(issued[0].sql.includes('deployment_id'), true);
    assert.equal(issued[0].params[8], 77);
  });

  test('an omitted deploymentId is bound as null, not undefined', async () => {
    await scheduleImpactMeasurement(1, { draftId: 42, pageUrl: '/pricing', generatorId: 'meta-title', mergedAt: new Date() });
    assert.equal(issued[0].params[8], null);
  });
});

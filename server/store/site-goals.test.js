import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let issued;
let rows;

function fakeQuery(text, params = []) {
  const sql = text.replace(/\s+/g, ' ').trim();
  issued.push({ sql, params });
  if (sql.startsWith('INSERT INTO site_goals')) return { rows: [{ id: 1, site_id: params[0], goal_type: params[1], objective: params[2], target_business_area: params[3], target_page_patterns: params[4], primary_metric: params[5], description: params[6], status: 'active', importance: params[7], created_at: new Date(), updated_at: new Date() }] };
  if (sql.startsWith('SELECT * FROM site_goals WHERE site_id = $1 ORDER BY')) return { rows };
  if (sql.startsWith("SELECT * FROM site_goals WHERE site_id = $1 AND status = 'active'")) return { rows };
  if (sql.startsWith('SELECT * FROM site_goals WHERE site_id = $1 AND id = $2')) return { rows };
  if (sql.startsWith('UPDATE site_goals SET goal_type')) return { rows };
  if (sql.startsWith('UPDATE site_goals SET status')) return { rows };
  throw new Error(`site-goals.test.js fake query: unhandled SQL shape: ${sql}`);
}

const resolve = (p) => new URL(p, import.meta.url).href;
mock.module(resolve('../db.js'), { namedExports: { query: (text, params) => fakeQuery(text, params) } });
const { createGoal, listGoals, listActiveGoals, getGoal, updateGoal, setGoalStatus, GOAL_TYPES } = await import('./site-goals.js');

beforeEach(() => { issued = []; rows = []; });

describe('createGoal', () => {
  test('inserts scoped to site_id, with defaults for optional fields', async () => {
    const goal = await createGoal(7, { goalType: 'generate_leads', objective: 'Generate leads for booking software' });
    assert.equal(issued[0].params[0], 7, 'site_id is the first bound param — every write is site-scoped');
    assert.equal(goal.objective, 'Generate leads for booking software');
    assert.equal(goal.siteId, 7);
  });

  test('rejects an unknown goal type before ever issuing a query', async () => {
    await assert.rejects(() => createGoal(1, { goalType: 'take_over_the_market', objective: 'x' }), /Unknown goal type/);
    assert.equal(issued.length, 0);
  });

  test('rejects a blank objective — the type alone is not specific enough to match findings against', async () => {
    await assert.rejects(() => createGoal(1, { goalType: 'custom', objective: '   ' }), /objective is required/);
    assert.equal(issued.length, 0);
  });

  test('every predefined GOAL_TYPES value is accepted', async () => {
    for (const goalType of GOAL_TYPES) {
      issued = [];
      await createGoal(1, { goalType, objective: 'x' });
      assert.equal(issued.length, 1);
    }
  });
});

describe('listGoals / listActiveGoals — per-site isolation', () => {
  test('listGoals scopes by site_id', async () => {
    rows = [{ id: 1, site_id: 7, goal_type: 'generate_leads', objective: 'x', target_page_patterns: [], status: 'active', importance: 1 }];
    const goals = await listGoals(7);
    assert.equal(issued[0].params[0], 7);
    assert.equal(goals[0].id, 1);
  });

  test('listActiveGoals issues a status-filtered query, scoped by site_id', async () => {
    await listActiveGoals(3);
    assert.match(issued[0].sql, /status = 'active'/);
    assert.equal(issued[0].params[0], 3);
  });

  test('two different sites never see each other\'s rows — a query for site A never carries site B\'s id', async () => {
    await listActiveGoals(1);
    await listActiveGoals(2);
    assert.equal(issued[0].params[0], 1);
    assert.equal(issued[1].params[0], 2);
    assert.notEqual(issued[0].params[0], issued[1].params[0]);
  });
});

describe('getGoal', () => {
  test('scoped by both site_id AND goal id — a goal id alone is never enough', async () => {
    rows = [{ id: 5, site_id: 7, goal_type: 'grow_sales', objective: 'x', target_page_patterns: [], status: 'active', importance: 1 }];
    const goal = await getGoal(7, 5);
    assert.deepEqual(issued[0].params, [7, 5]);
    assert.equal(goal.id, 5);
  });

  test('returns null, not a row from another site, when nothing matches this site+id pair', async () => {
    rows = [];
    const goal = await getGoal(7, 999);
    assert.equal(goal, null);
  });
});

describe('updateGoal — partial update, COALESCE semantics', () => {
  test('only the given fields are meant to change (COALESCE in the SQL)', async () => {
    await updateGoal(7, 5, { objective: 'New objective' });
    assert.match(issued[0].sql, /COALESCE/);
    assert.deepEqual(issued[0].params, [7, 5, null, 'New objective', null, null, null, null, null]);
  });

  test('rejects an unknown goal type on update too', async () => {
    await assert.rejects(() => updateGoal(1, 1, { goalType: 'nonsense' }), /Unknown goal type/);
  });

  test('rejects blanking the objective to empty', async () => {
    // updateGoal itself doesn't validate (routes/clients.js does, before
    // calling it) — this documents that an empty string still becomes NULL
    // via ?? null and is therefore never coalesced over the existing value.
    await updateGoal(1, 1, { objective: undefined });
    assert.equal(issued[0].params[3], null);
  });
});

describe('setGoalStatus', () => {
  test('accepts active/paused, scoped by site_id + goal id', async () => {
    await setGoalStatus(7, 5, 'paused');
    assert.deepEqual(issued[0].params, [7, 5, 'paused']);
  });

  test('rejects any other status value', async () => {
    await assert.rejects(() => setGoalStatus(1, 1, 'archived'), /Invalid goal status/);
  });
});

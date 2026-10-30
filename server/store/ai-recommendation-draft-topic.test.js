import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const resolve = (p) => fileURLToPath(new URL(p, import.meta.url));

let issued = []; let result = [];
mock.module(resolve('../db.js'), { namedExports: { query: async (sql, params) => { issued.push({ sql, params }); return { rows: result }; } } });
const { findDraftByTopic } = await import('./ai-recommendation.js');

test('only a live draft can be re-linked: abandoned and rolled-back drafts are excluded', async () => {
  issued = []; result = [{ id: 9 }];
  assert.equal(await findDraftByTopic(3, 'Best CRM'), 9);
  const { sql, params } = issued[0];
  assert.match(sql, /status <> 'abandoned'/);
  assert.match(sql, /rolled_back_at IS NULL/);
  assert.deepEqual(params, [3, 'Best CRM']);
});
test('nothing eligible is null, so a fresh draft is generated', async () => {
  issued = []; result = [];
  assert.equal(await findDraftByTopic(3, 'x'), null);
});

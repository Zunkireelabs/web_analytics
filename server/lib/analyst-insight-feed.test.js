import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllFreshInsights } from './analyst-insight-feed.js';

const mk = (n, start = 0) => Array.from({ length: n }, (_, k) => ({ id: start + k }));
const service = (total, filteredIds = new Set()) => async (path) => {
  const q = new URL(path, 'http://x').searchParams; const limit = +q.get('limit'); const offset = +q.get('offset');
  const raw = mk(Math.max(0, Math.min(limit, total - offset)), offset);
  return { insights: raw.filter((i) => !filteredIds.has(i.id)), has_more: raw.length === limit, next_offset: offset + raw.length };
};

test('reads every page, not just the first 200', async () => {
  const r = await fetchAllFreshInsights(1, { call: service(1234), sinceDays: 3, pageSize: 500 });
  assert.equal(r.insights.length, 1234); assert.equal(r.pages, 3); assert.equal(r.paged, true);
});
test('rows the service filters out (resolved/dismissed) do not end paging early', async () => {
  const r = await fetchAllFreshInsights(1, { call: service(1000, new Set(mk(500).map((i) => i.id))), sinceDays: 3, pageSize: 500 });
  assert.equal(r.insights.length, 500); assert.equal(r.pages, 3); // exactly full last page: one empty page confirms the end
});
test('asks for the freshness window and the project', async () => {
  const paths = []; await fetchAllFreshInsights(7, { call: async (p) => { paths.push(p); return { insights: [], has_more: false }; }, sinceDays: 3 });
  assert.match(paths[0], /^\/clients\/7\/insights\?limit=500&offset=0&since_days=3$/);
});
test('an older service that ignores paging gives a plain list: returned as is, flagged unpaged', async () => {
  const r = await fetchAllFreshInsights(1, { call: async () => ({ insights: mk(200) }), sinceDays: 3 });
  assert.equal(r.insights.length, 200); assert.equal(r.paged, false);
});
test('a failed page throws instead of returning a partial list', async () => {
  let n = 0;
  await assert.rejects(fetchAllFreshInsights(1, { call: async (p) => { if (n++ === 1) throw new Error('503'); return { insights: mk(500), has_more: true, next_offset: 500 }; }, sinceDays: 3, pageSize: 500 }), /503/);
});
test('a feed that never ends hits the ceiling and throws', async () => {
  await assert.rejects(fetchAllFreshInsights(1, { call: async () => ({ insights: mk(1), has_more: true, next_offset: 1 }), sinceDays: 3, maxPages: 3 }), /did not end/);
});
test('duplicates across pages are collapsed', async () => {
  let n = 0;
  const r = await fetchAllFreshInsights(1, { call: async () => ({ insights: mk(3), has_more: n++ < 1 }), sinceDays: 3 });
  assert.equal(r.insights.length, 3);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  requestCounts, filterRequests, daysLeft, ago, setupChips, requestStatus, bulkNote, runBulk, approvalRows, approvalCounts, filterApprovals,
  holdCounts, filterHold, visibleProjects, marketGroups, detailCounts, promptView, defaultRequestSort,
} from './requests-view.js';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const iso = (d) => new Date(NOW - d * 86400000).toISOString();
const rows = Array.from({ length: 112 }, (_, i) => ({
  siteId: i, name: `Brand ${i}`, owner: { email: `o${i}@x.com` }, requestedAt: iso(i % 30),
  state: ['pending', 'demo', 'client', 'ended', 'rejected'][i % 5], setup: { goals: ['geo'], markets: ['A', 'B'], prompts: 3 },
}));

test('counts and filters over many rows', () => {
  const n = requestCounts(rows);
  assert.equal(n.all, 112); assert.equal(n.waiting + n.trials + n.clients + n.ended + n.rejected, 112);
  assert.equal(filterRequests(rows, { filter: 'waiting' }).length, n.waiting);
  assert.equal(filterRequests(rows, { filter: 'all' }).length, 112);
});
test('waiting sorts oldest first, others newest first', () => {
  const w = filterRequests(rows, { filter: 'waiting' });
  assert.ok(Date.parse(w[0].requestedAt) <= Date.parse(w[1].requestedAt));
  const t = filterRequests(rows, { filter: 'trials' });
  assert.ok(Date.parse(t[0].requestedAt) >= Date.parse(t[1].requestedAt));
  assert.equal(defaultRequestSort('all'), 'newest');
});
test('search by brand or email', () => {
  assert.equal(filterRequests(rows, { filter: 'all', query: 'o7@' }).length, 1);
  assert.equal(filterRequests(rows, { filter: 'all', query: 'BRAND 11' }).length, 3);
});
test('days left, ago, chips, status', () => {
  assert.equal(daysLeft(new Date(NOW + 2.2 * 86400000).toISOString(), NOW), 3);
  assert.equal(daysLeft(new Date(NOW - 1000).toISOString(), NOW), 0);
  assert.equal(ago(iso(1), NOW), '1 day ago');
  assert.equal(ago(new Date(NOW - 19 * 3600000).toISOString(), NOW), '19 hours ago');
  assert.deepEqual(setupChips({ goals: ['a'], markets: [], prompts: 38 }), ['1 goal', '38 prompts']);
  assert.deepEqual(setupChips(null), []);
  assert.equal(requestStatus({ state: 'demo', endsAt: new Date(NOW + 86400000).toISOString() }, NOW).text, 'Trial, 1 day left');
  assert.equal(requestStatus({ state: 'ended' }).text, 'Trial ended');
});
test('bulk keeps going after a failure and writes one note', async () => {
  const note = await runBulk([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }], async (r) => { if (r.name === 'C') throw new Error('nope'); });
  assert.equal(note.text, '3 approved, 1 failed: C (nope)');
  // A raw upstream failure never reaches the staff note: the name stays, the technical text does not.
  const leaky = await runBulk([{ name: 'E' }], async () => { throw new Error('Request failed with HTTP 500'); });
  assert.equal(leaky.text, '0 approved, 1 failed: E'.replace('0 approved, ', ''));
  assert.equal(bulkNote(0, ['X'], 'approved').bad, true);
});
test('approvals merge the two lists', () => {
  const r = approvalRows([{ id: 1, companyName: 'A', contactEmail: 'a@x', createdAt: iso(3) }], [{ id: 2, companyName: 'B', contactEmail: 'b@x', approvedAt: iso(1), expired: false }, { id: 3, companyName: 'C', contactEmail: 'c@x', approvedAt: iso(9), expired: true }]);
  assert.deepEqual(approvalCounts(r), { waiting: 1, unconfirmed: 1, expired: 1, all: 3 });
  assert.equal(filterApprovals(r, { filter: 'all' })[0].company, 'C');
  assert.equal(filterApprovals(r, { filter: 'expired' }).length, 1);
  assert.equal(filterApprovals(r, { filter: 'all', query: 'b@' }).length, 1);
});
test('hold counts and filters', () => {
  const l = [
    { id: 1, email: 'a@x', status: 'pending', requestedAt: iso(1), removed: [{ workspace: 'W', projects: ['p1', 'p2'] }] },
    { id: 2, email: 'b@x', status: 'approved', requestedAt: iso(5), removed: [], lastProject: 'Zed' },
  ];
  assert.deepEqual(holdCounts(l), { pending: 1, approved: 1, all: 2, projects: 2 });
  assert.equal(filterHold(l, { filter: 'all', query: 'zed' }).length, 1);
  assert.equal(filterHold(l, { filter: 'pending', query: 'p2' }).length, 1);
  assert.equal(visibleProjects([1, 2, 3, 4, 5, 6], false).length, 4);
  assert.equal(visibleProjects([1, 2, 3, 4, 5, 6], true).length, 6);
});
test('details: markets, counts, prompts', () => {
  const m = { scope: 'country', items: ['Nepal'], levels: { continent: ['Asia'], country: ['Nepal'], state: [], city: ['Bagmati|Nepal'] } };
  assert.deepEqual(marketGroups(m).map((g) => g.key), ['continent', 'country', 'city']);
  assert.equal(marketGroups(m)[2].items[0], 'Nepal, Bagmati');
  assert.equal(marketGroups({ items: ['X'] })[0].items[0], 'X');
  assert.equal(marketGroups(null).length, 0);
  assert.equal(detailCounts({ goals: ['geo'], markets: m, topics: ['t'], prompts: [{}, {}], profile: { competitors: ['c'] } }).countries, 1);
  const prompts = [
    { text: 'best bulbs', topic: 'Lighting', intent: 'commercial' }, { text: 'bulbs vs switches', topic: 'Lighting', intent: 'informational' },
    { text: 'buy sensors', topic: 'Sensors', intent: 'transactional' },
  ];
  const v = promptView(prompts, { intent: 'all', topic: 'all' });
  assert.equal(v.shown, 3); assert.equal(v.groups.length, 2);
  const c = promptView(prompts, { intent: 'commercial' });
  assert.equal(c.shown, 1); assert.equal(c.topics.find((t) => t.key === 'Lighting').count, 1);
  assert.equal(promptView(prompts, { q: 'SENSORS' }).shown, 1);
});

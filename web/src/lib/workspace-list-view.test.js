import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, filterWorkspaces, filterCounts, flattenProjects, visibleProjects, stateMix, setupPercent, connectedCount, projectFilterCounts } from './workspace-list-view.js';

const conn = (n) => ({ searchConsole: n > 0, analytics: n > 1, github: n > 2, baseline: n > 3 });
const proj = (name, state, n, domain = `${name}.com`) => ({ id: name, name, domain, access: { state }, connections: conn(n), missing: ['a', 'b', 'c', 'd'].slice(0, 4 - n) });
const ws = (id, name, projects, over = {}) => ({ id, name, memberCount: 2, owners: [`${name.toLowerCase()}@x.test`], createdAt: `2026-0${id}-01T00:00:00Z`, projects, needsSetup: 0, ...over });
const data = [
  ws(1, 'Alpha', [proj('a1', 'client', 4), proj('a2', 'client', 4)]),
  ws(2, 'Bravo', [proj('b1', 'demo', 1), proj('b2', 'new', 0)]),
  ws(3, 'Charlie', [proj('c1', 'ended', 0)]),
  ws(4, 'Delta', []),
  ws(5, 'Echo', [proj('e1', 'client', 3), proj('e2', 'pending', 4)]),
];

test('summary counts', () => {
  assert.deepEqual(summarize(data), { workspaces: 5, projects: 7, people: 10, clients: 3, trials: 1, attention: 3 });
});
test('needs attention first, then name', () => {
  assert.deepEqual(filterWorkspaces(data, {}).map((w) => w.name), ['Bravo', 'Charlie', 'Echo', 'Alpha', 'Delta']);
});
test('filters and their counts', () => {
  assert.deepEqual(filterWorkspaces(data, { filter: 'trials' }).map((w) => w.name), ['Bravo']);
  assert.deepEqual(filterWorkspaces(data, { filter: 'ended' }).map((w) => w.name), ['Charlie']);
  assert.deepEqual(filterWorkspaces(data, { filter: 'clients', sort: 'name' }).map((w) => w.name), ['Alpha', 'Echo']);
  assert.deepEqual(filterCounts(data), { all: 5, attention: 3, trials: 1, ended: 1, clients: 2 });
});
test('search matches workspace, owner, project and domain; shows only matching projects unless the workspace matches', () => {
  assert.deepEqual(filterWorkspaces(data, { query: 'b2.com' }).map((w) => w.name), ['Bravo']);
  assert.deepEqual(visibleProjects(data[1], 'b2').map((p) => p.name), ['b2']);
  assert.equal(visibleProjects(data[1], 'bravo').length, 2);
  assert.deepEqual(filterWorkspaces(data, { query: 'delta@x' }).map((w) => w.name), ['Delta']);
  assert.deepEqual(filterWorkspaces(data, { query: 'nothing' }), []);
  assert.equal(filterCounts(data, 'bravo').all, 1);
});
test('sorts', () => {
  assert.deepEqual(filterWorkspaces(data, { sort: 'name' }).map((w) => w.name), ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);
  assert.equal(filterWorkspaces(data, { sort: 'newest' })[0].name, 'Echo');
  assert.equal(filterWorkspaces(data, { sort: 'projects' })[0].name, 'Alpha');
});
test('state mix, setup percent and connected count', () => {
  assert.deepEqual(stateMix(data[4]), { client: 1, trial: 0, ended: 0, fresh: 1, rejected: 0 });
  assert.equal(setupPercent(data[1]), 13);
  assert.equal(setupPercent(data[3]), 100);
  assert.equal(connectedCount(data[0].projects[0]), 4);
});
test('flat project table respects filter, query and sort', () => {
  const all = flattenProjects(data, {});
  assert.equal(all.length, 7);
  assert.equal(all[0].project.name, 'b2'); // fewest connected first
  assert.deepEqual(flattenProjects(data, { filter: 'clients', sort: 'name' }).map((r) => r.project.name), ['a1', 'a2', 'e1']);
  assert.equal(flattenProjects(data, { query: 'echo' }).length, 2);
  assert.equal(flattenProjects(data, { query: 'e1' })[0].owner, 'echo@x.test');
  assert.deepEqual(projectFilterCounts(data), { all: 7, attention: 5, trials: 1, ended: 1, clients: 3 });
});

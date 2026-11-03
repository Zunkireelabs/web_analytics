import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { platformProjectRow } from './workspaces.js';

// The Platform list's per-project fields. No database: the row is a plain object.
const site = (over = {}) => ({ id: 7, name: 'P', website_domain: 'p.com', gsc_property: null, ga4_property_id: null, repo_owner: null, repo_name: null, onboarded_at: null,
  access_state: 'client', access_ends_at: null, access_requested_at: null, ...over });
const NOW = new Date('2026-11-03T00:00:00Z');

describe('platformProjectRow', () => {
  test('connections and missing are derived together and cannot disagree', () => {
    const r = platformProjectRow(site({ gsc_property: 'sc-domain:p.com', repo_owner: 'o', repo_name: 'r' }), NOW);
    assert.deepEqual(r.connections, { searchConsole: true, analytics: false, github: true, baseline: false });
    assert.deepEqual(r.missing, ['Analytics', 'Baseline']);
    const all = platformProjectRow(site({ gsc_property: 'x', ga4_property_id: '1', repo_owner: 'o', repo_name: 'r', onboarded_at: NOW }), NOW);
    assert.deepEqual(all.missing, []);
    assert.ok(Object.values(all.connections).every(Boolean));
  });
  test('a repo needs both owner and name', () => {
    assert.equal(platformProjectRow(site({ repo_owner: 'o' }), NOW).connections.github, false);
  });
  test('access states: client, demo with end date, expired demo reads as ended, pending vs new, rejected', () => {
    assert.deepEqual(platformProjectRow(site(), NOW).access, { state: 'client', endsAt: null });
    const ends = new Date('2026-11-17T00:00:00Z');
    assert.deepEqual(platformProjectRow(site({ access_state: 'demo', access_ends_at: ends }), NOW).access, { state: 'demo', endsAt: ends });
    assert.equal(platformProjectRow(site({ access_state: 'demo', access_ends_at: new Date('2026-11-01T00:00:00Z') }), NOW).access.state, 'ended');
    assert.equal(platformProjectRow(site({ access_state: 'pending' }), NOW).access.state, 'new');
    assert.equal(platformProjectRow(site({ access_state: 'pending', access_requested_at: NOW }), NOW).access.state, 'pending');
    assert.equal(platformProjectRow(site({ access_state: 'rejected' }), NOW).access.state, 'rejected');
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { instanceState, connectionsOf, capacityFor, toListRow, summarize, STATE_LABEL } from './instance-view.js';

const DAY = 86400000;
const now = new Date('2026-12-10T10:00:00Z');
const site = (o = {}) => ({ id: 1, name: 'P', status: 'active', gsc_property: 'sc', ga4_property_id: 'g', onboarded_at: '2026-10-01', auto_remediation_daily_limit: 60, ...o });

describe('state', () => {
  test('each state, in the order they are decided', () => {
    assert.equal(instanceState(site({ status: 'soft_deleted' })), 'removed');
    assert.equal(instanceState(site({ status: 'suspended' })), 'paused');
    assert.equal(instanceState(site({ gsc_property: null })), 'waiting_to_connect');
    assert.equal(instanceState(site({ ga4_property_id: null })), 'waiting_to_connect');
    assert.equal(instanceState(site({ onboarded_at: null })), 'setting_up');
    assert.equal(instanceState(site()), 'running');
  });
  test('every state has a label', () => {
    for (const s of ['removed', 'paused', 'waiting_to_connect', 'setting_up', 'running']) assert.ok(STATE_LABEL[s]);
  });
  test('a site with no status column value is treated as active', () => assert.equal(instanceState(site({ status: undefined })), 'running'));
});

describe('connections and capacity', () => {
  test('the four tiles', () => {
    assert.deepEqual(connectionsOf(site({ repo_owner: 'o', repo_name: 'r' }), { hasAnalystClient: true }), { searchConsole: true, analytics: true, github: true, analyst: true });
    assert.deepEqual(connectionsOf(site({ gsc_property: null, ga4_property_id: null }), { hasAnalystClient: false }), { searchConsole: false, analytics: false, github: false, analyst: false });
  });
  test('capacity is the site limit, raised to 100 only during surge, never past the ceiling', () => {
    assert.equal(capacityFor(site(), now).dailyCapacity, 60);
    assert.equal(capacityFor(site({ surge_mode_until: new Date(now.getTime() + 5 * DAY) }), now).dailyCapacity, 100);
    assert.equal(capacityFor(site({ surge_mode_until: new Date(now.getTime() - DAY) }), now).dailyCapacity, 60);
    assert.equal(capacityFor(site({ auto_remediation_daily_limit: 30, surge_mode_until: new Date(now.getTime() + 5 * DAY) }), now).dailyCapacity, 30);
    assert.equal(capacityFor(site({ auto_remediation_daily_limit: 0 }), now).dailyCapacity, 0);
    assert.equal(capacityFor(site({ auto_remediation_daily_limit: 500 }), now).dailyCapacity, 100);
  });
});

describe('the list row', () => {
  test('a running project with a run today', () => {
    const r = toListRow(site({ growth_started_at: '2026-11-01T00:00:00Z' }), { runs24h: 18, failed24h: 0, lastRunAt: '2026-12-10T02:31:00Z' }, { hasAnalystClient: true, now });
    assert.equal(r.state, 'running');
    assert.equal(r.growth.stage, 'expansion');
    assert.equal(r.lastRun.agentsLast24h, 18);
    assert.equal(r.connectedCount, 3);
    assert.deepEqual(r.needs, ['GitHub']);
  });
  test('no activity yields zeros and null, never undefined', () => {
    const r = toListRow(site({ gsc_property: null }), undefined, { now });
    assert.deepEqual(r.lastRun, { at: null, agentsLast24h: 0, failedLast24h: 0 });
    assert.equal(r.growth, null, 'no growth clock on this database yet: not available, not a crash');
  });
  test('only named fields come back: a new column on sites cannot reach the browser', () => {
    const r = toListRow(site({ github_pat_env_var: 'SECRET_ENV', author_name: 'Someone', crm_webhook_token: 'tok', url_file_map: { pages: { '/secret': 'x' } } }), {}, { now });
    const text = JSON.stringify(r);
    for (const leak of ['SECRET_ENV', 'Someone', 'tok', '/secret']) assert.ok(!text.includes(leak), leak);
  });
});

describe('the summary strip', () => {
  test('counts running, waiting, paused, ran in 24h, and needs attention', () => {
    const rows = [
      toListRow(site({ id: 1 }), { runs24h: 18, failed24h: 0, lastRunAt: new Date(now.getTime() - 3600e3) }, { now }),
      toListRow(site({ id: 2 }), { runs24h: 5, failed24h: 2, lastRunAt: new Date(now.getTime() - 3600e3) }, { now }),
      toListRow(site({ id: 3 }), { runs24h: 0, failed24h: 0, lastRunAt: new Date(now.getTime() - 3 * DAY) }, { now }),
      toListRow(site({ id: 4, gsc_property: null }), {}, { now }),
      toListRow(site({ id: 5, status: 'suspended' }), {}, { now }),
    ];
    assert.deepEqual(summarize(rows, now), { running: 3, waiting: 1, paused: 1, ranLast24h: 2, runningTotal: 3, needAttention: 2 });
  });
});

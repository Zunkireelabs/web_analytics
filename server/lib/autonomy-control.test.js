import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { autonomyView, setAutonomy, autonomyKey, AutonomyError, NEEDS_GITHUB_REASON } from './autonomy-control.js';

const repoSite = { id: 5, name: 'Admizz', status: 'active', repo_owner: 'o', repo_name: 'r', auto_remediation_enabled: false, auto_remediation_daily_limit: 60 };
const bareSite = { ...repoSite, repo_owner: null, repo_name: null };

// The same rule the staff Controls dialog uses (routes/clients.js validateAutoRemediationRequest), reproduced faithfully: enabling
// needs a repository, disabling never does.
const validate = ({ enabled, dailyLimit, site }) => {
  if (typeof enabled !== 'boolean') return 'enabled must be true or false.';
  if (!Number.isInteger(dailyLimit) || dailyLimit < 0) return 'dailyLimit must be a non-negative integer.';
  if (enabled && !(site?.repo_owner && site?.repo_name)) return 'This site has no GitHub repository connected, so autonomous fixes would have nowhere to open a pull request.';
  return null;
};

function harness(site) {
  const h = { updates: [], changes: [] };
  h.query = async (sql, params) => {
    if (/FROM sites WHERE id/.test(sql)) return { rows: site ? [site] : [] };
    if (/INSERT INTO platform_setting_changes/.test(sql)) { h.changes.push({ key: params[0], from: JSON.parse(params[1]), to: JSON.parse(params[2]), by: params[3], email: params[4] }); return { rows: [{}] }; }
    throw new Error(`unexpected query ${sql.slice(0, 60)}`);
  };
  h.update = async (u) => { h.updates.push(u); return { ...site, auto_remediation_enabled: u.enabled }; };
  return h;
}

describe('autonomyView', () => {
  test('a project with a repository can be switched on; one without says why not', () => {
    assert.deepEqual([autonomyView(repoSite).canEnable, autonomyView(repoSite).blockedReason], [true, null]);
    assert.deepEqual([autonomyView(bareSite).canEnable, autonomyView(bareSite).blockedReason], [false, NEEDS_GITHUB_REASON]);
  });
  test('the last change and the 7-day counts are passed through, and an unknown count stays null (never invented)', () => {
    const v = autonomyView({ ...repoSite, auto_remediation_enabled: true }, { change: { at: '2026-11-06T09:20:00Z', by: 'a@b.test' }, drafts: { opened: 5, merged: 3, waiting: 2 } });
    assert.deepEqual(v, { enabled: true, canEnable: true, blockedReason: null, changedAt: '2026-11-06T09:20:00.000Z', changedBy: 'a@b.test', last7Days: { opened: 5, merged: 3, waiting: 2 } });
    const none = autonomyView(repoSite);
    assert.deepEqual([none.changedAt, none.changedBy, none.last7Days.merged, none.last7Days.waiting], [null, null, null, null]);
  });
});

describe('setAutonomy', () => {
  test('turning it on uses the same store function as the Controls dialog, keeps the existing daily limit, and records who did it', async () => {
    const h = harness(repoSite);
    const out = await setAutonomy(5, true, { by: 9, email: 'a@b.test', query: h.query, update: h.update, validate });
    assert.equal(out.changed, true);
    assert.deepEqual(h.updates, [{ siteId: 5, enabled: true, dailyLimit: 60 }]);
    assert.deepEqual(h.changes, [{ key: autonomyKey(5), from: false, to: true, by: 9, email: 'a@b.test' }]);
  });
  test('without a GitHub repository it is refused with NEEDS_GITHUB and nothing is written', async () => {
    const h = harness(bareSite);
    await assert.rejects(setAutonomy(5, true, { query: h.query, update: h.update, validate }), (e) => e instanceof AutonomyError && e.status === 400 && e.code === 'NEEDS_GITHUB' && /GitHub/.test(e.message));
    assert.equal(h.updates.length + h.changes.length, 0);
  });
  test('turning it OFF is always allowed, even with no repository', async () => {
    const h = harness({ ...bareSite, auto_remediation_enabled: true });
    const out = await setAutonomy(5, false, { query: h.query, update: h.update, validate });
    assert.deepEqual([out.changed, out.to], [true, false]);
  });
  test('a no-op writes nothing and records nothing', async () => {
    const h = harness(repoSite);
    const out = await setAutonomy(5, false, { query: h.query, update: h.update, validate });
    assert.equal(out.changed, false);
    assert.equal(h.updates.length + h.changes.length, 0);
  });
  test('not a boolean is 400; an unknown or removed project is 404', async () => {
    await assert.rejects(setAutonomy(5, 'yes', { query: harness(repoSite).query, validate }), (e) => e.status === 400);
    await assert.rejects(setAutonomy(5, true, { query: harness(null).query, validate }), (e) => e.status === 404);
    await assert.rejects(setAutonomy(5, true, { query: harness({ ...repoSite, status: 'soft_deleted' }).query, validate }), (e) => e.status === 404);
  });
});

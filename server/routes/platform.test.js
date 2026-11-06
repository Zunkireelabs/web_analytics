import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// The Platform view is the one place that lists every client's workspace, so
// what matters here is who can reach it: only the platform admin, and everyone
// else gets a 404 that does not confirm the route exists.

process.env.COMPANY_SITE_ID = '1';

const real = await import(resolve('../store/workspaces.js') + '?real');
const STAFF = 1; const CLIENT = 2; const MEMBER = 3;
let audit;

mock.module(resolve('../store/users.js'), {
  namedExports: {
    createUser: async () => { throw new Error('not used in this test'); },
    getUserById: async (id) => ({
      [STAFF]: { id: STAFF, role: 'platform_admin', site_id: 1 },
      [CLIENT]: { id: CLIENT, role: 'tenant_admin', site_id: 8862 },
      // A platform_admin role on a client's own site is NOT the platform admin.
      [MEMBER]: { id: MEMBER, role: 'platform_admin', site_id: 8862 },
    }[id] || null),
    getUserByEmail: async () => null, updateUserPassword: async () => null, getUserStatus: async () => 'active',
  },
});
mock.module(resolve('../store/read.js'), { namedExports: { getSiteById: async () => null, getSiteStatus: async () => 'active' } });
mock.module(resolve('../store/admin/audit-log.js'), { namedExports: { recordAuditEvent: async (req, e) => { audit.push(e); } } });
mock.module(resolve('../store/workspaces.js'), {
  namedExports: {
    ...real,
    listAllWorkspacesForPlatform: async () => [
      { id: 2, name: 'Zunkiree Labs', owners: ['a@z.test'], memberCount: 2, needsSetup: 1, projects: [{ id: 1, name: 'Z', domain: 'z.com', missing: [] }, { id: 8862, name: 'Admizz', domain: 'a.com', missing: ['GitHub'] }] },
      { id: 5, name: 'Acme', owners: [], memberCount: 1, needsSetup: 0, projects: [] },
    ],
    getProject: async (id) => (id === 8862 ? { id, name: 'Admizz', workspace_id: 2 } : null),
  },
});

mock.module(resolve('../lib/instance-view.js'), {
  namedExports: {
    loadInstanceList: async () => ({ instances: [{ id: 8862, name: 'Admizz' }], summary: { running: 1 } }),
    loadInstanceDetail: async (id) => (id === 8862 ? { id, name: 'Admizz', state: 'running' } : null),
  },
});

// The mode switch and the auto-fix switch have their own tests (lib/master-agent-control.test.js, lib/autonomy-control.test.js); here they
// are stood in for, so what is tested is the ROUTES: who may call them, how errors map to status codes, and what is written to the audit log.
class MasterControlError extends Error { constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; } }
class AutonomyError extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; } }
let masterState; let setCalls; let autoCalls; let setResult; let setError; let autoResult; let autoError;
mock.module(resolve('../lib/master-agent-control.js'), {
  namedExports: {
    MasterControlError,
    loadMasterControl: async () => ({ ...masterState }),
    shadowPlanDetail: async () => ({ projects: [{ siteId: 8862, name: 'Admizz', order: 1, plannedMs: 240000, legacyMs: 250000 }], days: [{ day: '2026-11-06', planned: 3, legacyRan: 3 }] }),
    setMasterMode: async (mode, o) => { setCalls.push({ mode, ...o }); if (setError) throw setError; masterState = { ...masterState, mode }; return setResult; },
  },
});
mock.module(resolve('../lib/autonomy-control.js'), {
  namedExports: {
    AutonomyError,
    setAutonomy: async (id, enabled, o) => { autoCalls.push({ id, enabled, ...o }); if (autoError) throw autoError; return autoResult; },
    loadAutonomy: async () => ({ enabled: true, canEnable: true, blockedReason: null, changedAt: '2026-11-06T09:20:00.000Z', changedBy: 'staff@z.test', last7Days: { opened: 5, merged: 3, waiting: 2 } }),
  },
});

mock.module(resolve('../lib/master-agent.js'), {
  namedExports: {
    health: async ({ mode }) => ({ mode, day: '2026-11-05', today: { queued: 0, succeeded: 2 }, stuckRunning: 0, recentFailures: [] }),
    shadowReport: async () => ({ planned: 3, legacyRan: 3, plannedButLegacyDidNot: [], legacyRanButNotPlanned: [] }),
  },
});

const router = (await import('./platform.js')).default;

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
async function call(method, path, { userId, body = {}, params = {} } = {}) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${path} not registered`);
  const req = { userId, body, params };
  const res = mockRes();
  for (const l of layer.route.stack.slice(1)) {
    let proceeded = false;
    await l.handle(req, res, (err) => { if (err) throw err; proceeded = true; });
    if (!proceeded) break;
  }
  return res;
}

beforeEach(() => {
  audit = []; setCalls = []; autoCalls = []; setError = null; autoError = null;
  masterState = { mode: 'shadow', ceiling: null, locked: false, canSwitch: { off: { ok: true }, shadow: { ok: true }, on: { ok: false, reason: 'On needs at least 3 days in Shadow with no failed plans (1 so far).' } },
    readiness: { shadowDays: 1, requiredShadowDays: 3, failedPlans: 0, migrationOk: true, checks: [] }, history: [] };
  setResult = { changed: true, from: 'off', to: 'shadow' };
  autoResult = { site: { id: 8862, name: 'Admizz', repo_owner: 'o', repo_name: 'r' }, changed: true, from: false, to: true, dailyLimit: 60 };
});

describe('GET /platform/workspaces', () => {
  test('the platform admin sees every workspace with totals', async () => {
    const res = await call('get', '/platform/workspaces', { userId: STAFF });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.workspaces.length, 2);
    assert.deepEqual(res.body.totals, { workspaces: 2, projects: 2, needsSetup: 1 });
  });
  test('anyone else gets a 404, including a platform_admin role on a client site', async () => {
    for (const userId of [CLIENT, MEMBER]) {
      const res = await call('get', '/platform/workspaces', { userId });
      assert.equal(res.statusCode, 404);
      assert.equal(res.body.workspaces, undefined);
    }
  });
});

describe('POST /platform/support-view', () => {
  test('is recorded in the audit log against the project', async () => {
    const res = await call('post', '/platform/support-view', { userId: STAFF, body: { siteId: 8862 } });
    assert.equal(res.statusCode, 200);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'platform.support_view');
    assert.equal(audit[0].tenantSiteId, 8862);
  });
  test('an unknown project is a 404 and nothing is logged; a non-admin cannot log one at all', async () => {
    assert.equal((await call('post', '/platform/support-view', { userId: STAFF, body: { siteId: 999 } })).statusCode, 404);
    assert.equal((await call('post', '/platform/support-view', { userId: STAFF, body: { siteId: 'x' } })).statusCode, 404);
    assert.equal((await call('post', '/platform/support-view', { userId: CLIENT, body: { siteId: 8862 } })).statusCode, 404);
    assert.equal(audit.length, 0);
  });
});

describe('GET /platform/instances (read only)', () => {
  test('the platform admin gets the list and one project\'s detail', async () => {
    const list = await call('get', '/platform/instances', { userId: STAFF });
    assert.equal(list.statusCode, 200);
    assert.equal(list.body.instances.length, 1);
    const one = await call('get', '/platform/instances/:siteId', { userId: STAFF, params: { siteId: '8862' } });
    assert.equal(one.statusCode, 200);
    assert.equal(one.body.state, 'running');
  });
  test('anyone else gets a 404 on both, including a platform_admin role on a client site', async () => {
    for (const userId of [CLIENT, MEMBER]) {
      assert.equal((await call('get', '/platform/instances', { userId })).statusCode, 404);
      const r = await call('get', '/platform/instances/:siteId', { userId, params: { siteId: '8862' } });
      assert.equal(r.statusCode, 404);
      assert.equal(r.body.state, undefined);
    }
  });
  test('an unknown or malformed project id is a 404', async () => {
    for (const siteId of ['999', 'abc', '-1', '0', '1.5']) {
      assert.equal((await call('get', '/platform/instances/:siteId', { userId: STAFF, params: { siteId } })).statusCode, 404, siteId);
    }
  });
  test('the view has no write route and writes no audit event', async () => {
    const writes = router.stack.filter((l) => l.route?.path?.startsWith('/platform/instances') && Object.keys(l.route.methods).some((m) => m !== 'get'));
    assert.deepEqual(writes, []);
    await call('get', '/platform/instances', { userId: STAFF });
    assert.equal(audit.length, 0);
  });
});

describe('GET /platform/master-agent', () => {
  test('the platform admin sees mode, control state, counts and the shadow comparison with its per-project detail', async () => {
    const res = await call('get', '/platform/master-agent', { userId: STAFF });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.mode, 'shadow');
    assert.equal(res.body.canSwitch.on.ok, false);
    assert.equal(res.body.readiness.requiredShadowDays, 3);
    assert.equal(res.body.shadow.planned, 3);                  // from shadowReport
    assert.equal(res.body.shadow.projects[0].name, 'Admizz');  // from shadowPlanDetail
    assert.equal(res.body.shadow.days[0].legacyRan, 3);
  });
  test('while the mode is off there is no shadow block (nothing is being planned)', async () => {
    masterState = { ...masterState, mode: 'off' };
    assert.equal((await call('get', '/platform/master-agent', { userId: STAFF })).body.shadow, null);
  });
  test('anyone else gets a 404', async () => {
    for (const userId of [CLIENT, MEMBER]) assert.equal((await call('get', '/platform/master-agent', { userId })).statusCode, 404);
  });
});

describe('PUT /platform/master-agent/mode', () => {
  test('the platform admin switches it; the audit log records who changed what, and the response is the fresh page payload', async () => {
    const res = await call('put', '/platform/master-agent/mode', { userId: STAFF, body: { mode: 'shadow' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual([setCalls[0].mode, setCalls[0].by], ['shadow', STAFF]);
    assert.equal(res.body.mode, 'shadow');
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0].action, audit[0].metadata], ['platform.master_agent_mode_changed', { from: 'off', to: 'shadow' }]);
  });
  test('a change that changes nothing is not audited', async () => {
    setResult = { changed: false, from: 'shadow', to: 'shadow' };
    assert.equal((await call('put', '/platform/master-agent/mode', { userId: STAFF, body: { mode: 'shadow' } })).statusCode, 200);
    assert.equal(audit.length, 0);
  });
  test('errors keep their status and code: 400 BAD_MODE, 409 CEILING, 409 NOT_READY; nothing is audited', async () => {
    for (const [e, status] of [[new MasterControlError('BAD_MODE', 'Mode must be off, shadow or on.', 400), 400], [new MasterControlError('CEILING', 'The server setting forbids it.'), 409], [new MasterControlError('NOT_READY', 'On needs at least 3 days in Shadow.'), 409]]) {
      setError = e;
      const res = await call('put', '/platform/master-agent/mode', { userId: STAFF, body: { mode: 'on' } });
      assert.deepEqual([res.statusCode, res.body.code], [status, e.code]);
      assert.ok(res.body.error);
    }
    assert.equal(audit.length, 0);
  });
  test('anyone else gets a 404 and nothing is attempted', async () => {
    for (const userId of [CLIENT, MEMBER]) assert.equal((await call('put', '/platform/master-agent/mode', { userId, body: { mode: 'on' } })).statusCode, 404);
    assert.equal(setCalls.length, 0);
  });
  test('this is the ONLY write route the platform admin has for the queue', () => {
    const writes = router.stack.filter((l) => l.route?.path?.startsWith('/platform/master-agent') && Object.keys(l.route.methods).some((m) => m !== 'get'));
    assert.deepEqual(writes.map((l) => [Object.keys(l.route.methods)[0], l.route.path]), [['put', '/platform/master-agent/mode']]);
  });
});

describe('PUT /platform/projects/:siteId/autonomy', () => {
  test('turning auto-fixes on is audited exactly like the staff Controls dialog does it, and returns the autonomy object', async () => {
    const res = await call('put', '/platform/projects/:siteId/autonomy', { userId: STAFF, params: { siteId: '8862' }, body: { enabled: true } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual([autoCalls[0].id, autoCalls[0].enabled, autoCalls[0].by], [8862, true, STAFF]);
    assert.equal(res.body.enabled, true); assert.equal(res.body.last7Days.merged, 3);
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0].action, audit[0].tenantSiteId, audit[0].metadata.via], ['tenant.auto_remediation_enabled', 8862, 'platform-instances']);
  });
  test('turning it off is audited as disabled; a no-op is not audited', async () => {
    autoResult = { ...autoResult, from: true, to: false };
    await call('put', '/platform/projects/:siteId/autonomy', { userId: STAFF, params: { siteId: '8862' }, body: { enabled: false } });
    assert.equal(audit[0].action, 'tenant.auto_remediation_disabled');
    audit = []; autoResult = { ...autoResult, changed: false };
    await call('put', '/platform/projects/:siteId/autonomy', { userId: STAFF, params: { siteId: '8862' }, body: { enabled: false } });
    assert.equal(audit.length, 0);
  });
  test('without a repository it is a 400 NEEDS_GITHUB with the plain message', async () => {
    autoError = new AutonomyError('NEEDS_GITHUB', 'This site has no GitHub repository connected.');
    const res = await call('put', '/platform/projects/:siteId/autonomy', { userId: STAFF, params: { siteId: '8862' }, body: { enabled: true } });
    assert.deepEqual([res.statusCode, res.body.code], [400, 'NEEDS_GITHUB']);
    assert.equal(audit.length, 0);
  });
  test('a malformed id is a 404 before anything runs; anyone else is a 404', async () => {
    for (const siteId of ['abc', '0', '-2', '1.5']) assert.equal((await call('put', '/platform/projects/:siteId/autonomy', { userId: STAFF, params: { siteId }, body: { enabled: true } })).statusCode, 404, siteId);
    for (const userId of [CLIENT, MEMBER]) assert.equal((await call('put', '/platform/projects/:siteId/autonomy', { userId, params: { siteId: '8862' }, body: { enabled: true } })).statusCode, 404);
    assert.equal(autoCalls.length, 0);
  });
});

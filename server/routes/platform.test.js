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

const router = (await import('./platform.js')).default;

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
async function call(method, path, { userId, body = {} } = {}) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${path} not registered`);
  const req = { userId, body, params: {} };
  const res = mockRes();
  for (const l of layer.route.stack.slice(1)) {
    let proceeded = false;
    await l.handle(req, res, (err) => { if (err) throw err; proceeded = true; });
    if (!proceeded) break;
  }
  return res;
}

beforeEach(() => { audit = []; });

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

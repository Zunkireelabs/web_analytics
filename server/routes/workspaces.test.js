import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// Route-level coverage for workspace management: who may add projects, invite,
// change roles and remove members, and that another workspace's id is never
// confirmed to exist. requireAuth (layer 0 of every route) is covered in
// workspaces-isolation.test.js; here each route's remaining layers run in
// order with req.userId already set.

process.env.COMPANY_SITE_ID = '1';

const real = await import(resolve('../store/workspaces.js') + '?real');

let users; // id -> user row
let roles; // `${userId}:${workspaceId}` -> membership role
let owners;
let calls;
const resetCalls = () => { calls = { addMember: [], updateRole: [], remove: [], invitations: [], projects: [] }; };

mock.module(resolve('../store/users.js'), {
  namedExports: {
    getUserById: async (id) => users[id] || null,
    getUserByEmail: async (email) => Object.values(users).find((u) => u.email === email) || null,
    updateUserPassword: async () => { throw new Error('not exercised'); },
    getUserStatus: async () => 'active',
  },
});
mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => null, getSiteStatus: async () => 'active' },
});
mock.module(resolve('../store/user-invitations.js'), {
  namedExports: {
    createInvitation: async (o) => { calls.invitations.push(o); return { id: 99, token: 't0ken', expires_at: 'soon' }; },
    acceptInvitation: async () => null,
  },
});
mock.module(resolve('../report/email.js'), {
  namedExports: {
    sendInvitationEmail: async () => true,
    // login.js (imported for requireAuth) pulls these in; not exercised here.
    sendContactLeadEmail: async () => true,
    sendPasswordResetEmail: async () => true,
  },
});
mock.module(resolve('../store/admin/audit-log.js'), {
  namedExports: { recordAuditEvent: async () => {} },
});
mock.module(resolve('../store/workspaces.js'), {
  namedExports: {
    WORKSPACE_ROLE_RANK: real.WORKSPACE_ROLE_RANK,
    tenantRoleForWorkspaceRole: real.tenantRoleForWorkspaceRole,
    effectiveWorkspaceRole: real.effectiveWorkspaceRole,
    roleAtLeast: real.roleAtLeast,
    decideMemberChange: real.decideMemberChange,
    decideSiteAccess: real.decideSiteAccess,
    isPlatformAdmin: real.isPlatformAdmin,
    getAccessContext: async () => null,
    listWorkspacesForUser: async () => [],
    pickLoginSite: async () => null,
    getWorkspaceById: async (id) => ({ id, name: `Workspace ${id}` }),
    getMembershipRole: async (userId, workspaceId) => roles[`${userId}:${workspaceId}`] ?? null,
    countOwners: async () => owners,
    listMembers: async () => [],
    listPendingInvitations: async () => [],
    addMember: async (w, u, r) => { calls.addMember.push([w, u, r]); return true; },
    updateMemberRole: async (w, u, r) => { calls.updateRole.push([w, u, r]); return { role: r }; },
    removeMember: async (w, u) => { calls.remove.push([w, u]); return true; },
    inviteHomeSiteId: async () => 5,
    createProject: async (o) => { calls.projects.push(o); return { id: 77, name: o.name, website_domain: o.websiteDomain }; },
  },
});

const router = (await import('./workspaces.js')).default;

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

// Runs every layer after requireAuth (index 0) in order, stopping when one
// responds instead of calling next.
async function call(method, path, { userId, params = {}, body = {}, siteId = 2 } = {}) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${path} not registered`);
  const req = {
    userId, siteId, params, body, protocol: 'https', get: () => 'app.example.com',
  };
  const res = mockRes();
  for (const l of layer.route.stack.slice(1)) {
    let proceeded = false;
    await l.handle(req, res, (err) => { if (err) throw err; proceeded = true; });
    if (!proceeded) break;
  }
  return res;
}

const OWNER = 10; const ADMIN = 11; const MEMBER = 12; const OUTSIDER = 13; const PLATFORM = 1;

beforeEach(() => {
  resetCalls();
  owners = 2;
  users = {
    [PLATFORM]: { id: PLATFORM, email: 'staff@zunkiree.test', role: 'platform_admin', site_id: 1 },
    [OWNER]: { id: OWNER, email: 'owner@acme.test', role: 'tenant_admin', site_id: 2 },
    [ADMIN]: { id: ADMIN, email: 'admin@acme.test', role: 'tenant_admin', site_id: 2 },
    [MEMBER]: { id: MEMBER, email: 'member@acme.test', role: 'tenant_member', site_id: 2 },
    [OUTSIDER]: { id: OUTSIDER, email: 'outsider@other.test', role: 'tenant_admin', site_id: 9 },
  };
  roles = {
    [`${OWNER}:7`]: 'owner', [`${ADMIN}:7`]: 'admin', [`${MEMBER}:7`]: 'member',
    [`${OUTSIDER}:8`]: 'owner',
  };
});

describe('workspace membership gate', () => {
  test('a user from another workspace gets 404 — the workspace is not confirmed to exist', async () => {
    for (const [method, path] of [['get', '/workspaces/:id/members'], ['post', '/workspaces/:id/projects'], ['post', '/workspaces/:id/members']]) {
      const res = await call(method, path, { userId: OUTSIDER, params: { id: '7' }, body: { name: 'x', email: 'a@b.co' } });
      assert.equal(res.statusCode, 404, `${method} ${path}`);
    }
    assert.equal(calls.projects.length, 0);
    assert.equal(calls.invitations.length, 0);
  });

  test('a plain member can read the team but not manage it', async () => {
    assert.equal((await call('get', '/workspaces/:id/members', { userId: MEMBER, params: { id: '7' } })).statusCode, 200);
    assert.equal((await call('post', '/workspaces/:id/projects', { userId: MEMBER, params: { id: '7' }, body: { name: 'New' } })).statusCode, 403);
    assert.equal((await call('post', '/workspaces/:id/members', { userId: MEMBER, params: { id: '7' }, body: { email: 'a@b.co' } })).statusCode, 403);
    assert.equal((await call('patch', '/workspaces/:id/members/:userId', { userId: MEMBER, params: { id: '7', userId: String(ADMIN) }, body: { role: 'member' } })).statusCode, 403);
    assert.equal((await call('delete', '/workspaces/:id/members/:userId', { userId: MEMBER, params: { id: '7', userId: String(ADMIN) } })).statusCode, 403);
    assert.deepEqual(calls.updateRole, []);
    assert.deepEqual(calls.remove, []);
  });

  test('a platform admin manages any workspace without a membership row', async () => {
    const res = await call('post', '/workspaces/:id/projects', { userId: PLATFORM, params: { id: '8' }, body: { name: 'Support project' } });
    assert.equal(res.statusCode, 201);
    assert.equal(calls.projects[0].workspaceId, 8);
  });

  test('a non-numeric workspace id is a 404', async () => {
    assert.equal((await call('get', '/workspaces/:id/members', { userId: OWNER, params: { id: 'abc' } })).statusCode, 404);
  });
});

describe('POST /workspaces/:id/projects', () => {
  test('an admin creates a project in THEIR workspace, never one named in the body', async () => {
    const res = await call('post', '/workspaces/:id/projects', {
      userId: ADMIN, params: { id: '7' }, body: { name: '  Acme Blog ', websiteDomain: 'https://Blog.Acme.com/path', workspaceId: 8 },
    });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(calls.projects[0], { workspaceId: 7, name: 'Acme Blog', websiteDomain: 'blog.acme.com', timezone: undefined });
  });

  test('requires a name', async () => {
    assert.equal((await call('post', '/workspaces/:id/projects', { userId: ADMIN, params: { id: '7' }, body: { name: '  ' } })).statusCode, 400);
  });
});

describe('POST /workspaces/:id/members (invite)', () => {
  test('invites a new email with the workspace and role attached', async () => {
    const res = await call('post', '/workspaces/:id/members', { userId: ADMIN, params: { id: '7' }, body: { email: ' New@Acme.test ', role: 'member' } });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.invited, true);
    assert.deepEqual(calls.invitations[0], {
      siteId: 5, email: 'new@acme.test', role: 'tenant_member', invitedBy: ADMIN, workspaceId: 7, workspaceRole: 'member',
    });
  });

  test('an existing account is added to the workspace directly', async () => {
    const res = await call('post', '/workspaces/:id/members', { userId: ADMIN, params: { id: '7' }, body: { email: 'outsider@other.test', role: 'member' } });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.added, true);
    assert.deepEqual(calls.addMember, [[7, OUTSIDER, 'member']]);
    assert.equal(calls.invitations.length, 0);
  });

  test('an admin cannot invite someone as owner; an owner can', async () => {
    const denied = await call('post', '/workspaces/:id/members', { userId: ADMIN, params: { id: '7' }, body: { email: 'n@acme.test', role: 'owner' } });
    assert.equal(denied.statusCode, 403);
    const ok = await call('post', '/workspaces/:id/members', { userId: OWNER, params: { id: '7' }, body: { email: 'n@acme.test', role: 'owner' } });
    assert.equal(ok.statusCode, 201);
  });

  test('rejects a bad email or an unknown role', async () => {
    assert.equal((await call('post', '/workspaces/:id/members', { userId: OWNER, params: { id: '7' }, body: { email: 'nope' } })).statusCode, 400);
    assert.equal((await call('post', '/workspaces/:id/members', { userId: OWNER, params: { id: '7' }, body: { email: 'a@b.co', role: 'root' } })).statusCode, 400);
  });
});

describe('role changes and removal', () => {
  test('an admin can change a member\'s role and remove them', async () => {
    const patch = await call('patch', '/workspaces/:id/members/:userId', { userId: ADMIN, params: { id: '7', userId: String(MEMBER) }, body: { role: 'admin' } });
    assert.equal(patch.statusCode, 200);
    assert.deepEqual(calls.updateRole, [[7, MEMBER, 'admin']]);
    const del = await call('delete', '/workspaces/:id/members/:userId', { userId: ADMIN, params: { id: '7', userId: String(MEMBER) } });
    assert.equal(del.statusCode, 200);
    assert.deepEqual(calls.remove, [[7, MEMBER]]);
  });

  test('an admin cannot demote or remove an owner', async () => {
    assert.equal((await call('patch', '/workspaces/:id/members/:userId', { userId: ADMIN, params: { id: '7', userId: String(OWNER) }, body: { role: 'member' } })).statusCode, 403);
    assert.equal((await call('delete', '/workspaces/:id/members/:userId', { userId: ADMIN, params: { id: '7', userId: String(OWNER) } })).statusCode, 403);
    assert.deepEqual(calls.updateRole, []);
    assert.deepEqual(calls.remove, []);
  });

  test('the last owner cannot be removed or demoted, even by themselves', async () => {
    owners = 1;
    assert.equal((await call('delete', '/workspaces/:id/members/:userId', { userId: OWNER, params: { id: '7', userId: String(OWNER) } })).statusCode, 403);
    assert.equal((await call('patch', '/workspaces/:id/members/:userId', { userId: OWNER, params: { id: '7', userId: String(OWNER) }, body: { role: 'admin' } })).statusCode, 403);
    assert.deepEqual(calls.remove, []);
  });

  test('a target who is not in THIS workspace is a 404, so another workspace\'s members are unreachable', async () => {
    const res = await call('delete', '/workspaces/:id/members/:userId', { userId: ADMIN, params: { id: '7', userId: String(OUTSIDER) } });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(calls.remove, []);
  });

  test('PATCH rejects an unknown role', async () => {
    assert.equal((await call('patch', '/workspaces/:id/members/:userId', { userId: OWNER, params: { id: '7', userId: String(MEMBER) }, body: { role: 'root' } })).statusCode, 400);
    assert.equal((await call('patch', '/workspaces/:id/members/:userId', { userId: OWNER, params: { id: '7', userId: String(MEMBER) }, body: {} })).statusCode, 400);
  });
});

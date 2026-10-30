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
const resetCalls = () => { calls = { homeClaims: [], addMember: [], updateRole: [], remove: [], invitations: [], projects: [], workspaces: [], renamed: [], goals: [], tokens: [], revoked: [], audit: [], projectMembers: [], discarded: [] }; };
let siteWorkspace; // siteId -> workspaceId (which project belongs to which workspace)
let tokenRows; // rows returned for the workspace token list

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
    sendSignupReceivedEmail: async () => true, sendLoginCodeEmail: async () => true,
    sendSignupStaffNotice: async () => true,
  },
});
mock.module(resolve('../store/admin/audit-log.js'), {
  namedExports: { recordAuditEvent: async (req, e) => { calls.audit.push(e.action); } },
});
mock.module(resolve('../store/workspaces.js'), {
  namedExports: {
    ...real,
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
    createProject: async (o) => { if (globalThis.__dupDomain) throw Object.assign(new Error('dup'), { code: '23505', constraint: 'sites_workspace_domain_unique' }); calls.projects.push(o); return { id: 77, name: o.name, website_domain: o.websiteDomain }; },
    createWorkspace: async ({ name }) => { calls.workspaces.push(name); return { id: 100, name }; },
    discardNewWorkspace: async (o) => { calls.discarded.push(o); },
    workspaceHasDomain: async () => Boolean(globalThis.__hasDomain),
    // A new account's first project becomes its home site (migration 198); recorded so the test can see it.
    claimHomeSiteIfNone: async (userId, siteId) => { calls.homeClaims.push([userId, siteId]); return true; },
    renameWorkspace: async (id, name) => { calls.renamed.push([id, name]); return { id, name }; },
    siteInWorkspace: async (siteId, workspaceId) => siteWorkspace[siteId] === workspaceId,
    setProjectGoal: async (o) => { if (globalThis.__failGoal) throw new Error('goal write failed'); calls.goals.push(o); return { site_id: o.siteId, goal: o.goal, growth: o.growth, months: o.months }; },
    listGoalsForSites: async () => ({ 5: { goal: 'google_visitors', growth: 'fast', months: 6 } }),
    listProjectMembersForWorkspace: async () => [{ id: 14, email: 'client@admizz.test', status: 'active', role: 'admin', project: { id: 6, name: 'Acme Shop' } }],
    addProjectMember: async (siteId, userId, role, by) => { calls.projectMembers.push([siteId, userId, role, by]); return true; },
    getProject: async (id) => ({ id, name: id === 5 ? 'Acme Blog' : 'Acme Shop', workspace_id: 7 }),
    listWorkspaceSites: async () => [
      { id: 5, name: 'Acme Blog', website_domain: 'blog.acme.com', gsc_property: 'sc-domain:acme.com', ga4_property_id: '123' },
      { id: 6, name: 'Acme Shop', website_domain: null, gsc_property: null, ga4_property_id: null },
    ],
    listWorkspaceActivity: async () => [
      { id: 1, action: 'project.created', actor_email: 'owner@acme.test', tenant_name: 'Acme Blog', metadata: { name: 'Acme Blog' }, created_at: 'now' },
      { id: 2, action: 'something.private', actor_email: 'x@y.z', tenant_name: null, metadata: null, created_at: 'now' },
    ],
  },
});
mock.module(resolve('../store/api-tokens.js'), {
  namedExports: {
    createApiToken: async (siteId, o) => { calls.tokens.push({ siteId, ...o }); return { id: 31, site_id: siteId, label: o.label, permission_level: o.permissionLevel, token: 'raw-secret' }; },
    listApiTokensForWorkspace: async (workspaceId) => { calls.listedTokensFor = workspaceId; return tokenRows; },
    revokeApiTokenInWorkspace: async (workspaceId, id) => { calls.revoked.push([workspaceId, id]); return id === 31 && workspaceId === 7 ? { id, site_id: 5 } : null; },
    listApiTokensForSite: async () => [], revokeApiToken: async () => false,
  },
});
mock.module(resolve('../store/data-freshness.js'), {
  namedExports: { gscDailyDataAsOf: async (siteId) => ({ as_of: siteId === 5 ? new Date().toISOString().slice(0, 10) : null }) },
});
mock.module(resolve('../store/admin/system-health.js'), {
  namedExports: { getRecentAgentRunFailureCounts: async () => [{ site_id: 6, agent_id: 'a', failure_count: 2 }] },
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
  siteWorkspace = { 5: 7, 6: 7, 40: 8 };
  tokenRows = [{ id: 31, site_id: 5, site_name: 'Acme Blog', permission_level: 'read_only' }];
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

describe('POST /workspaces (create) is all-or-nothing', () => {
  const body = { name: 'Brightpath', projectName: 'Site', websiteDomain: 'b.test', goal: { goal: 'google_visitors', growth: 'fast', months: 6 } };
  test('a failure after the workspace exists takes the workspace and project back and never claims a home project', async () => {
    globalThis.__failGoal = true;
    try {
      await assert.rejects(() => call('post', '/workspaces', { userId: MEMBER, body }), /goal write failed/);
    } finally { globalThis.__failGoal = false; }
    assert.deepEqual(calls.discarded, [{ workspaceId: 100, siteId: 77 }]);
    assert.deepEqual(calls.homeClaims, [], 'a home project is only claimed once everything succeeded');
    assert.equal(calls.audit.filter((a) => a === 'workspace.created').length, 0, 'nothing is audited as created');
  });
  test('success claims the home project and discards nothing', async () => {
    const res = await call('post', '/workspaces', { userId: MEMBER, body });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(calls.discarded, []);
    assert.deepEqual(calls.homeClaims, [[MEMBER, 77]]);
  });
});

describe('website address is validated and unique', () => {
  test('something that is not a website address is a 400 and creates nothing', async () => {
    for (const websiteDomain of ['asdf', 'a b.com', 'exa_mple.com']) {
      const res = await call('post', '/workspaces/:id/projects', { userId: ADMIN, params: { id: '7' }, body: { name: 'P', websiteDomain } });
      assert.equal(res.statusCode, 400, websiteDomain);
    }
    assert.equal(calls.projects.length, 0);
  });
  test('www, scheme, port and path are stripped so the same site is always stored the same way', async () => {
    await call('post', '/workspaces/:id/projects', { userId: ADMIN, params: { id: '7' }, body: { name: 'P', websiteDomain: 'https://WWW.Acme.com:8080/x?y=1' } });
    assert.equal(calls.projects[0].websiteDomain, 'acme.com');
  });
  test('the route checks first, so a duplicate is refused even where the database index is absent', async () => {
    globalThis.__hasDomain = true;
    try {
      const res = await call('post', '/workspaces/:id/projects', { userId: ADMIN, params: { id: '7' }, body: { name: 'P', websiteDomain: 'acme.com' } });
      assert.equal(res.statusCode, 409);
      assert.equal(calls.projects.length, 0);
    } finally { globalThis.__hasDomain = false; }
  });
  test('adding a website that is already a project there is a clear 409, not a 500', async () => {
    globalThis.__dupDomain = true;
    try {
      const res = await call('post', '/workspaces/:id/projects', { userId: ADMIN, params: { id: '7' }, body: { name: 'P', websiteDomain: 'acme.com' } });
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.code, 'DOMAIN_EXISTS');
    } finally { globalThis.__dupDomain = false; }
  });
});

describe('time zone is validated when a project is saved', () => {
  test('a made-up zone is a 400 on both create routes and creates nothing', async () => {
    const a = await call('post', '/workspaces', { userId: MEMBER, body: { name: 'W', projectName: 'P', timezone: 'Mars/Olympus' } });
    assert.equal(a.statusCode, 400);
    const b = await call('post', '/workspaces/:id/projects', { userId: ADMIN, params: { id: '7' }, body: { name: 'P', timezone: 'Not/AZone' } });
    assert.equal(b.statusCode, 400);
    assert.equal(calls.projects.length, 0);
    assert.equal(calls.workspaces.length, 0);
  });
  test('a real zone, or none at all, is accepted', async () => {
    assert.equal((await call('post', '/workspaces/:id/projects', { userId: ADMIN, params: { id: '7' }, body: { name: 'P', timezone: 'Europe/London' } })).statusCode, 201);
    assert.equal((await call('post', '/workspaces/:id/projects', { userId: ADMIN, params: { id: '7' }, body: { name: 'Q' } })).statusCode, 201);
  });
});

describe('POST /workspaces (create)', () => {
  test('anyone can create a workspace and becomes its owner; there is no cap', async () => {
    const a = await call('post', '/workspaces', { userId: MEMBER, body: { name: '  Brightpath  ' } });
    assert.equal(a.statusCode, 201);
    assert.deepEqual(calls.workspaces, ['Brightpath']);
    assert.deepEqual(calls.addMember, [[100, MEMBER, 'owner']]);
    const b = await call('post', '/workspaces', { userId: MEMBER, body: { name: 'Second one' } });
    assert.equal(b.statusCode, 201);
    assert.equal(calls.workspaces.length, 2);
    assert.ok(calls.audit.includes('workspace.created'));
  });

  test('requires a name', async () => {
    assert.equal((await call('post', '/workspaces', { userId: OWNER, body: { name: ' ' } })).statusCode, 400);
    assert.equal((await call('post', '/workspaces', { userId: OWNER, body: { name: 'x'.repeat(121) } })).statusCode, 400);
    assert.deepEqual(calls.workspaces, []);
  });

  test('creates the first project, its goal and invitations in one go', async () => {
    const res = await call('post', '/workspaces', {
      userId: OWNER,
      body: { name: 'Acme', projectName: 'Acme Blog', websiteDomain: 'HTTPS://Acme.com/x', goal: { goal: 'enquiries', growth: 'fast', months: 6 }, invites: [{ email: 'New@Acme.test', role: 'member' }] },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(calls.projects[0].workspaceId, 100);
    assert.equal(calls.projects[0].websiteDomain, 'acme.com');
    // customText is null for a preset goal — it only carries a value for the
    // "Something else" choice (migration 196).
    assert.deepEqual(calls.goals[0], { siteId: 77, goal: 'enquiries', goals: ['enquiries'], growth: 'fast', months: 6, customText: null, userId: OWNER });
    assert.deepEqual(calls.homeClaims, [[OWNER, 77]]); // the first project becomes a new account's home
    assert.equal(calls.invitations[0].workspaceId, 100);
    assert.equal(calls.invitations[0].workspaceRole, 'member');
  });

  test('a goal or invitations without a project are refused (nothing for them to belong to)', async () => {
    assert.equal((await call('post', '/workspaces', { userId: OWNER, body: { name: 'A', goal: { goal: 'enquiries', growth: 'fast', months: 6 } } })).statusCode, 400);
    assert.equal((await call('post', '/workspaces', { userId: OWNER, body: { name: 'A', invites: [{ email: 'a@b.co' }] } })).statusCode, 400);
  });

  test('a bad goal is a 400 before anything is created', async () => {
    const res = await call('post', '/workspaces', { userId: OWNER, body: { name: 'A', projectName: 'P', goal: { goal: 'world_domination', growth: 'fast', months: 6 } } });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(calls.workspaces, []);
  });

  test('only a platform admin can create a workspace for someone else; the admin is not added as a member', async () => {
    const denied = await call('post', '/workspaces', { userId: OWNER, body: { name: 'A', projectName: 'P', ownerEmail: 'client@x.test' } });
    assert.equal(denied.statusCode, 403);
    assert.deepEqual(calls.workspaces, []);

    const ok = await call('post', '/workspaces', { userId: PLATFORM, body: { name: 'Client Co', projectName: 'Client Site', ownerEmail: 'Client@X.test' } });
    assert.equal(ok.statusCode, 201);
    assert.deepEqual(calls.addMember, [], 'platform admin gets no membership row');
    assert.equal(calls.invitations[0].email, 'client@x.test');
    assert.equal(calls.invitations[0].workspaceRole, 'owner');
  });
});

describe('PATCH /workspaces/:id (rename)', () => {
  test('an admin renames their workspace; a member cannot; another workspace is a 404', async () => {
    assert.equal((await call('patch', '/workspaces/:id', { userId: ADMIN, params: { id: '7' }, body: { name: ' New name ' } })).statusCode, 200);
    assert.deepEqual(calls.renamed, [[7, 'New name']]);
    assert.equal((await call('patch', '/workspaces/:id', { userId: MEMBER, params: { id: '7' }, body: { name: 'x' } })).statusCode, 403);
    assert.equal((await call('patch', '/workspaces/:id', { userId: OUTSIDER, params: { id: '7' }, body: { name: 'x' } })).statusCode, 404);
    assert.equal((await call('patch', '/workspaces/:id', { userId: ADMIN, params: { id: '7' }, body: { name: ' ' } })).statusCode, 400);
  });
});

describe('PUT /workspaces/:id/projects/:siteId/goal', () => {
  const goal = { goal: 'google_visitors', growth: 'fast', months: 6 };

  test('an admin sets the goal for a project of THIS workspace', async () => {
    const res = await call('put', '/workspaces/:id/projects/:siteId/goal', { userId: ADMIN, params: { id: '7', siteId: '5' }, body: goal });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls.goals[0], { siteId: 5, ...goal, goals: ['google_visitors'], customText: null, userId: ADMIN });
  });

  test('a project that belongs to another workspace is a 404, whatever the caller owns', async () => {
    const res = await call('put', '/workspaces/:id/projects/:siteId/goal', { userId: OWNER, params: { id: '7', siteId: '40' }, body: goal });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(calls.goals, []);
  });

  test('a read-only member cannot set a goal; an invalid goal is a 400', async () => {
    assert.equal((await call('put', '/workspaces/:id/projects/:siteId/goal', { userId: MEMBER, params: { id: '7', siteId: '5' }, body: goal })).statusCode, 403);
    assert.equal((await call('put', '/workspaces/:id/projects/:siteId/goal', { userId: ADMIN, params: { id: '7', siteId: '5' }, body: { ...goal, months: 5 } })).statusCode, 400);
    assert.deepEqual(calls.goals, []);
  });
});

describe('workspace API tokens', () => {
  test('only an admin can list, create or revoke tokens', async () => {
    for (const [m, path, params, body] of [['get', '/workspaces/:id/tokens', { id: '7' }, {}], ['post', '/workspaces/:id/tokens', { id: '7' }, { siteId: 5 }], ['delete', '/workspaces/:id/tokens/:tokenId', { id: '7', tokenId: '31' }, {}]]) {
      assert.equal((await call(m, path, { userId: MEMBER, params, body })).statusCode, 403, `${m} ${path}`);
      assert.equal((await call(m, path, { userId: OUTSIDER, params, body })).statusCode, 404, `${m} ${path}`);
    }
    assert.deepEqual(calls.tokens, []);
    assert.deepEqual(calls.revoked, []);
  });

  test('lists the tokens of the workspace named in the URL', async () => {
    const res = await call('get', '/workspaces/:id/tokens', { userId: ADMIN, params: { id: '7' } });
    assert.equal(res.statusCode, 200);
    assert.equal(calls.listedTokensFor, 7);
    assert.equal(res.body[0].site_name, 'Acme Blog');
  });

  test('creates a token only for a project of this workspace', async () => {
    const ok = await call('post', '/workspaces/:id/tokens', { userId: ADMIN, params: { id: '7' }, body: { siteId: 5, label: ' Claude ', permissionLevel: 'ai_actions' } });
    assert.equal(ok.statusCode, 201);
    assert.equal(ok.body.token, 'raw-secret');
    assert.deepEqual(calls.tokens[0], { siteId: 5, label: 'Claude', createdBy: ADMIN, permissionLevel: 'ai_actions' });
    assert.ok(calls.audit.includes('mcp_token.created'));

    const foreign = await call('post', '/workspaces/:id/tokens', { userId: ADMIN, params: { id: '7' }, body: { siteId: 40, permissionLevel: 'admin' } });
    assert.equal(foreign.statusCode, 404);
    assert.equal(calls.tokens.length, 1);
  });

  test('defaults to read-only and rejects an unknown level', async () => {
    await call('post', '/workspaces/:id/tokens', { userId: ADMIN, params: { id: '7' }, body: { siteId: 5 } });
    assert.equal(calls.tokens[0].permissionLevel, 'read_only');
    assert.equal((await call('post', '/workspaces/:id/tokens', { userId: ADMIN, params: { id: '7' }, body: { siteId: 5, permissionLevel: 'root' } })).statusCode, 400);
  });

  test('revokes by workspace; another workspace\'s token is a 404', async () => {
    assert.equal((await call('delete', '/workspaces/:id/tokens/:tokenId', { userId: ADMIN, params: { id: '7', tokenId: '31' } })).statusCode, 200);
    assert.equal((await call('delete', '/workspaces/:id/tokens/:tokenId', { userId: ADMIN, params: { id: '7', tokenId: '999' } })).statusCode, 404);
    assert.ok(calls.audit.includes('mcp_token.revoked'));
  });
});

describe('POST /workspaces/:id/handover', () => {
  test('only an owner can hand a workspace over', async () => {
    assert.equal((await call('post', '/workspaces/:id/handover', { userId: ADMIN, params: { id: '7' }, body: { email: 'new@acme.test' } })).statusCode, 403);
    assert.equal((await call('post', '/workspaces/:id/handover', { userId: OWNER, params: { id: '7' }, body: { email: 'new@acme.test' } })).statusCode, 201);
    assert.equal(calls.invitations[0].workspaceRole, 'owner');
  });

  test('transfer steps the caller down only when the new owner already has an account', async () => {
    // existing account: added at once, so the caller can safely become admin
    const done = await call('post', '/workspaces/:id/handover', { userId: OWNER, params: { id: '7' }, body: { email: 'outsider@other.test', transfer: true } });
    assert.equal(done.body.steppedDown, true);
    assert.deepEqual(calls.updateRole, [[7, OWNER, 'admin']]);
  });

  test('an invitation does not step the caller down (the workspace must never be left without an owner)', async () => {
    const res = await call('post', '/workspaces/:id/handover', { userId: OWNER, params: { id: '7' }, body: { email: 'brand-new@acme.test', transfer: true } });
    assert.equal(res.body.invited, true);
    assert.equal(res.body.steppedDown, false);
    assert.deepEqual(calls.updateRole, []);
  });

  test('a platform admin helping out is never stepped down (no membership to change)', async () => {
    const res = await call('post', '/workspaces/:id/handover', { userId: PLATFORM, params: { id: '8' }, body: { email: 'outsider@other.test', transfer: true } });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.steppedDown, false);
    assert.deepEqual(calls.updateRole, []);
  });
});

describe('GET /workspaces/:id/overview', () => {
  test('any member can read it; projects carry goal, plain health checks and a needs-attention count', async () => {
    const res = await call('get', '/workspaces/:id/overview', { userId: MEMBER, params: { id: '7' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.yourRole, 'member');
    const [blog, shop] = res.body.projects;
    assert.equal(blog.goal.goal, 'google_visitors');
    assert.equal(blog.health.status, 'healthy');
    assert.equal(shop.goal, null);
    assert.equal(shop.health.status, 'attention');
    assert.equal(shop.health.checks.find((c) => c.key === 'search_console').text, 'Not connected');
    assert.equal(res.body.needsAttention, 1);
  });

  test('activity shows plain sentences and drops actions it does not know', async () => {
    const res = await call('get', '/workspaces/:id/overview', { userId: ADMIN, params: { id: '7' } });
    assert.equal(res.body.activity.length, 1);
    assert.equal(res.body.activity[0].text, 'added the project Acme Blog');
    assert.equal(res.body.activity[0].actorEmail, 'owner@acme.test');
  });

  test('another workspace is a 404', async () => {
    assert.equal((await call('get', '/workspaces/:id/overview', { userId: OUTSIDER, params: { id: '7' } })).statusCode, 404);
  });
});

describe('project-level access through the workspace invite route', () => {
  const invite = (userId, body, ws = '7') => call('post', '/workspaces/:id/members', { userId, params: { id: ws }, body });

  test('an existing account is given just the chosen projects, never workspace membership', async () => {
    const res = await invite(ADMIN, { email: 'outsider@other.test', role: 'member', projectIds: [5, 6] });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.added, true);
    assert.deepEqual(calls.projectMembers, [[5, OUTSIDER, 'member', ADMIN], [6, OUTSIDER, 'member', ADMIN]]);
    assert.deepEqual(calls.addMember, [], 'no workspace membership is created');
    assert.ok(calls.audit.includes('project.member_added'));
  });

  test('a new email gets a project invitation whose home project is the first one', async () => {
    const res = await invite(ADMIN, { email: ' New@Client.test ', role: 'admin', projectIds: [6, 5] });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.invited, true);
    assert.deepEqual(calls.invitations[0], {
      siteId: 6, email: 'new@client.test', role: 'tenant_admin', invitedBy: ADMIN, workspaceId: 7, projectSiteIds: [6, 5], projectRole: 'admin',
    });
    assert.deepEqual(calls.projectMembers, []);
  });

  test('ownership can never be limited to projects', async () => {
    const res = await invite(OWNER, { email: 'a@b.co', role: 'owner', projectIds: [5] });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(calls.invitations, []);
  });

  test('a project from ANOTHER workspace is refused, and nothing is granted', async () => {
    const res = await invite(OWNER, { email: 'outsider@other.test', role: 'member', projectIds: [5, 40] });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(calls.projectMembers, []);
    assert.deepEqual(calls.invitations, []);
  });

  test('someone who already belongs to the whole workspace is told so instead of getting a duplicate grant', async () => {
    users[MEMBER] = { ...users[MEMBER], email: 'member@acme.test' };
    const res = await invite(ADMIN, { email: 'member@acme.test', role: 'member', projectIds: [5] });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(calls.projectMembers, []);
  });

  test('a read-only member still cannot give access, scoped or not', async () => {
    assert.equal((await invite(MEMBER, { email: 'a@b.co', role: 'member', projectIds: [5] })).statusCode, 403);
  });

  test('the members list also reports project-only people', async () => {
    const res = await call('get', '/workspaces/:id/members', { userId: ADMIN, params: { id: '7' } });
    assert.equal(res.body.projectMembers[0].project.name, 'Acme Shop');
  });
});

import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// The link in the approval email. What matters: looking a link up never uses it up, using it creates
// the login exactly once, a bad or used or expired link creates nothing, and confirming an email never
// signs anyone in (they still need the password they chose).

let peeked; let consumed; let audit; let consumeCalls;
mock.module(resolve('../store/signup-requests.js'), {
  namedExports: {
    createSignupRequest: async () => { throw new Error('not exercised'); },
    peekVerificationToken: async (t) => peeked(t),
    consumeVerificationToken: async (t) => { consumeCalls.push(t); return consumed(t); },
  },
});
mock.module(resolve('../store/users.js'), { namedExports: { getUserByEmail: async () => null, getUserById: async () => null, updateUserPassword: async () => {}, getUserStatus: async () => 'active' } });
mock.module(resolve('../store/read.js'), { namedExports: { getSiteStatus: async () => 'active', getSiteById: async () => null } });
mock.module(resolve('../store/admin/audit-log.js'), { namedExports: { recordAuditEvent: async (req, e) => { audit.push({ actor: req.userId, ...e }); } } });
mock.module(resolve('../report/email.js'), { namedExports: { sendContactLeadEmail: async () => true, sendPasswordResetEmail: async () => true, sendSignupReceivedEmail: async () => true, sendSignupStaffNotice: async () => true } });
mock.module(resolve('../store/workspaces.js'), { namedExports: { getAccessContext: async () => null, decideSiteAccess: () => ({}), listWorkspacesForUser: async () => [], listSharedProjectsForUser: async () => [], pickLoginSite: async () => null, isBlockedForReadOnly: () => false, isAllowedWithoutProject: () => false } });

const router = (await import('./login.js')).default;

async function call(method, path, { query = {}, body = {} } = {}) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`route ${method} ${path} not registered`);
  const req = { query, body, session: {}, ip: '203.0.113.9', get: () => 'test' };
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await layer.route.stack[0].handle(req, res, (e) => { if (e) throw e; });
  return { req, res };
}

beforeEach(() => { peeked = async () => null; consumed = async () => ({ ok: false, reason: 'invalid' }); audit = []; consumeCalls = []; });

describe('GET /signup/verify (look the link up, change nothing)', () => {
  test('a good link says whose account it is', async () => {
    peeked = async () => ({ email: 'owner@acme.test', companyName: 'Acme Co', expired: false });
    const { res } = await call('get', '/signup/verify', { query: { token: 'good' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { email: 'owner@acme.test', companyName: 'Acme Co' });
    assert.deepEqual(consumeCalls, [], 'looking a link up must never use it up');
  });
  test('an unknown or used link is a 404, an expired one a 410 that says to ask for a new one', async () => {
    assert.equal((await call('get', '/signup/verify', { query: { token: 'nope' } })).res.statusCode, 404);
    assert.equal((await call('get', '/signup/verify', { query: {} })).res.statusCode, 404);
    peeked = async () => ({ email: 'a@b.test', companyName: 'X', expired: true });
    const { res } = await call('get', '/signup/verify', { query: { token: 'old' } });
    assert.equal(res.statusCode, 410);
    assert.match(res.body.error, /new one/);
  });
});

describe('POST /signup/verify (create the login, once)', () => {
  test('a good link creates the account, is audited, and signs nobody in', async () => {
    consumed = async () => ({ ok: true, user: { id: 41, email: 'owner@acme.test' }, companyName: 'Acme Co', requestId: 9 });
    const { req, res } = await call('post', '/signup/verify', { body: { token: 'good' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, email: 'owner@acme.test' });
    assert.deepEqual(req.session, {}, 'confirming an email must not create a session');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'signup_request.verified');
    assert.equal(audit[0].actor, 41);
  });
  test('a bad, used or expired link is a 400 and nothing is audited', async () => {
    const { res } = await call('post', '/signup/verify', { body: { token: 'bad' } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'invalid');
    assert.equal(audit.length, 0);
  });
  test('an address that already has an account is a 409 that says to sign in', async () => {
    consumed = async () => ({ ok: false, reason: 'exists' });
    const { res } = await call('post', '/signup/verify', { body: { token: 'dupe' } });
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /try signing in/i);
  });
  test('no token at all never reaches the store with anything but an empty string', async () => {
    await call('post', '/signup/verify', { body: {} });
    assert.deepEqual(consumeCalls, ['']);
  });
});

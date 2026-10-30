import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

const resolve = (p) => new URL(p, import.meta.url).href;

// Sign in with an emailed code, and the approval email's Sign in button. What matters: an address with no
// account looks exactly like one with an account, a wrong code or password signs nobody in, a mistyped
// password does not use up the approval link, and a good one creates the login and the session together.

let users; let issued; let sent; let checked; let activation; let consumed; let audit; let consumeCalls;
mock.module(resolve('../store/users.js'), { namedExports: {
  getUserByEmail: async (e) => users[e] || null, getUserById: async (id) => Object.values(users).find((u) => u.id === id) || { id, email: 'new@acme.test' },
  updateUserPassword: async () => {}, getUserStatus: async (id) => (Object.values(users).find((u) => u.id === id)?.status ?? 'active') } });
mock.module(resolve('../store/login-codes.js'), { namedExports: {
  CODE_MINUTES: 10,
  issueLoginCode: async (e) => issued(e),
  checkLoginCode: async (e, c) => checked(e, c) } });
mock.module(resolve('../store/signup-requests.js'), { namedExports: {
  hasOpenSignupRequest: async () => (globalThis.__openSignup ?? false),
  createSignupRequest: async () => { throw new Error('not exercised'); },
  peekVerificationToken: async () => null,
  getCompanyNameForEmail: async () => 'Acme Co',
  getActivationRequest: async (t) => activation(t),
  consumeVerificationToken: async (t, opts) => { consumeCalls.push(t); return consumed(t, opts); } } });
mock.module(resolve('../store/read.js'), { namedExports: { getSiteStatus: async () => 'active', getSiteById: async () => null } });
mock.module(resolve('../store/admin/audit-log.js'), { namedExports: { recordAuditEvent: async (req, e) => { audit.push(e); } } });
mock.module(resolve('../report/email.js'), { namedExports: { sendContactLeadEmail: async () => true, sendPasswordResetEmail: async () => true, sendSignupReceivedEmail: async () => true, sendSignupStaffNotice: async () => true, sendLoginCodeEmail: async (o) => { sent.push(o); return true; } } });
mock.module(resolve('../store/workspaces.js'), { namedExports: { getAccessContext: async () => (globalThis.__access ?? null), decideSiteAccess: () => (globalThis.__decision ?? {}), listWorkspacesForUser: async () => (globalThis.__workspaces ?? []), listSharedProjectsForUser: async () => [], pickLoginSite: async () => null, isBlockedForReadOnly: () => Boolean(globalThis.__blocked), isAllowedWithoutProject: () => false } });

const router = (await import('./login.js')).default;

async function call(method, path, { body = {} } = {}) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`route ${method} ${path} not registered`);
  const req = { query: {}, body, session: {}, ip: '203.0.113.9', get: () => 'test' };
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await layer.route.stack[0].handle(req, res, (e) => { if (e) throw e; });
  return { req, res };
}

beforeEach(() => {
  users = { 'owner@acme.test': { id: 7, email: 'owner@acme.test', site_id: null, status: 'active' }, 'off@acme.test': { id: 8, email: 'off@acme.test', site_id: null, status: 'disabled' } };
  issued = async () => ({ code: '482913' }); sent = []; checked = async () => ({ ok: false }); activation = async () => null;
  consumed = async () => ({ ok: false, reason: 'invalid' }); audit = []; consumeCalls = [];
});

describe('POST /login/code/send', () => {
  test('an address with an account is mailed a code', async () => {
    const { res } = await call('post', '/login/code/send', { body: { email: ' Owner@Acme.test ' } });
    assert.equal(res.statusCode, 200);
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0].email, sent[0].code], ['owner@acme.test', '482913']);
  });
  test('an unknown or disabled address gets the very same answer and no email', async () => {
    const known = (await call('post', '/login/code/send', { body: { email: 'owner@acme.test' } })).res.body;
    sent = [];
    const unknown = (await call('post', '/login/code/send', { body: { email: 'nobody@acme.test' } })).res;
    const disabled = (await call('post', '/login/code/send', { body: { email: 'off@acme.test' } })).res;
    assert.deepEqual(unknown.body, known);
    assert.deepEqual(disabled.body, known);
    assert.equal(sent.length, 0);
  });
  test('asking too soon is answered the same and sends nothing more', async () => {
    issued = async () => ({ tooSoon: true });
    const { res } = await call('post', '/login/code/send', { body: { email: 'owner@acme.test' } });
    assert.equal(res.statusCode, 200);
    assert.equal(sent.length, 0);
  });
  test('something that is not an email is a 400', async () => {
    assert.equal((await call('post', '/login/code/send', { body: { email: 'nope' } })).res.statusCode, 400);
  });
});

describe('an account whose home project is gone', () => {
  const signIn = async () => {
    users['owner@acme.test'] = { id: 7, email: 'owner@acme.test', site_id: 5, status: 'active' };
    checked = async () => ({ ok: true });
    return call('post', '/login/code/verify', { body: { email: 'owner@acme.test', code: '482913' } });
  };
  test('an owner who still belongs to a workspace signs in and can create another project', async () => {
    globalThis.__workspaces = [{ id: 2, name: 'Acme', role: 'owner' }];
    try {
      const { req, res } = await signIn();
      assert.equal(res.statusCode, 200);
      assert.equal(req.session.userId, 7);
      assert.equal(req.session.siteId, null);
    } finally { globalThis.__workspaces = []; }
  });
  test('someone who belongs to no workspace and shares no project is still refused', async () => {
    globalThis.__workspaces = [];
    const { res } = await signIn();
    assert.equal(res.statusCode, 403);
  });
});

describe('GET /me tells the screens when access is read-only', () => {
  const me = async (siteId = 5) => {
    const layer = router.stack.find((l) => l.route?.path === '/me' && l.route.methods.get);
    const req = { session: { userId: 7, siteId, homeSiteId: 5 } };
    const res = { body: null, json(b) { this.body = b; return this; } };
    await layer.route.stack[0].handle(req, res, (e) => { if (e) throw e; });
    return res.body;
  };
  test('a read-only member is flagged, an admin is not', async () => {
    globalThis.__access = { x: 1 }; globalThis.__decision = { allowed: true, via: 'member', role: 'member' }; globalThis.__blocked = true;
    try {
      assert.equal((await me()).readOnly, true);
      globalThis.__blocked = false;
      assert.equal((await me()).readOnly, false);
    } finally { globalThis.__access = null; globalThis.__decision = null; globalThis.__blocked = false; }
  });
  test('no active project means nothing to be read-only about', async () => {
    assert.equal((await me(null)).readOnly, false);
  });
});

describe('POST /login (password)', () => {
  test('a disabled account is refused even with the right password', async () => {
    users['off@acme.test'] = { ...users['off@acme.test'], password_hash: await bcrypt.hash('correct-horse', 4) };
    const { req, res } = await call('post', '/login', { body: { email: 'off@acme.test', password: 'correct-horse' } });
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /disabled/i);
    assert.equal(req.session.userId, undefined);
  });
  test('an unknown address and a wrong password get the very same answer', async () => {
    users['owner@acme.test'] = { ...users['owner@acme.test'], password_hash: await bcrypt.hash('right-password', 4) };
    const wrong = (await call('post', '/login', { body: { email: 'owner@acme.test', password: 'nope-nope' } })).res;
    const unknown = (await call('post', '/login', { body: { email: 'ghost@acme.test', password: 'nope-nope' } })).res;
    assert.deepEqual([wrong.statusCode, wrong.body], [unknown.statusCode, unknown.body]);
    assert.equal(wrong.statusCode, 401);
  });
});

describe('POST /login/code/verify', () => {
  test('a good code signs them in', async () => {
    checked = async () => ({ ok: true });
    const { req, res } = await call('post', '/login/code/verify', { body: { email: 'owner@acme.test', code: '482913' } });
    assert.equal(res.statusCode, 200);
    assert.equal(req.session.userId, 7);
  });
  test('a wrong or expired code is a 400 and no session', async () => {
    const { req, res } = await call('post', '/login/code/verify', { body: { email: 'owner@acme.test', code: '000000' } });
    assert.equal(res.statusCode, 400);
    assert.equal(req.session.userId, undefined);
  });
  test('a good code for a disabled account signs nobody in', async () => {
    checked = async () => ({ ok: true });
    const { req, res } = await call('post', '/login/code/verify', { body: { email: 'off@acme.test', code: '482913' } });
    assert.equal(res.statusCode, 400);
    assert.equal(req.session.userId, undefined);
  });
});

describe('POST /signup/activate (the approval email Sign in button)', () => {
  test('a wrong password is a 400 and the link is NOT used up', async () => {
    activation = async () => ({ passwordHash: await bcrypt.hash('right-password', 4), email: 'new@acme.test', companyName: 'Acme' });
    const { req, res } = await call('post', '/signup/activate', { body: { token: 't', password: 'wrong-password' } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'password');
    assert.deepEqual(consumeCalls, []);
    assert.equal(req.session.userId, undefined);
  });
  test('the right password uses the link, audits it, and signs them in', async () => {
    activation = async () => ({ passwordHash: await bcrypt.hash('right-password', 4), email: 'new@acme.test', companyName: 'Acme' });
    consumed = async () => ({ ok: true, user: { id: 41, email: 'new@acme.test' }, companyName: 'Acme', requestId: 9 });
    const { req, res } = await call('post', '/signup/activate', { body: { token: 't', password: 'right-password' } });
    assert.equal(res.statusCode, 200);
    assert.equal(req.session.userId, 41);
    assert.equal(req.session.siteId, null);
    assert.equal(audit[0].action, 'signup_request.verified');
  });
  test('Continue (oneClick) signs them in with the link alone, and the sign-up password is NOT carried over', async () => {
    activation = async () => ({ passwordHash: await bcrypt.hash('typed-on-the-form', 4), email: 'new@acme.test', companyName: 'Acme' });
    let handed;
    consumed = async (t, opts) => { handed = opts; return { ok: true, user: { id: 42, email: 'new@acme.test' }, companyName: 'Acme', requestId: 10 }; };
    const { req, res } = await call('post', '/signup/activate', { body: { token: 't', oneClick: true } });
    assert.equal(res.statusCode, 200);
    assert.equal(req.session.userId, 42);
    assert.ok(handed.passwordHash, 'an account is created with a password hash');
    assert.equal(await bcrypt.compare('typed-on-the-form', handed.passwordHash), false, 'the form password must not work');
  });
  test('a person who forgot the sign-up password sets a new one with the link, and it replaces the old one', async () => {
    activation = async () => ({ passwordHash: await bcrypt.hash('the-old-one-123', 4), email: 'new@acme.test', companyName: 'Acme' });
    let handed;
    consumed = async (t, opts) => { handed = opts; return { ok: true, user: { id: 43, email: 'new@acme.test' }, companyName: 'Acme', requestId: 11 }; };
    const { req, res } = await call('post', '/signup/activate', { body: { token: 't', newPassword: 'brand-new-pass-1' } });
    assert.equal(res.statusCode, 200);
    assert.equal(req.session.userId, 43);
    assert.equal(await bcrypt.compare('brand-new-pass-1', handed.passwordHash), true);
    assert.equal(await bcrypt.compare('the-old-one-123', handed.passwordHash), false);
  });
  test('a new password that is too short is refused and the link is NOT used up', async () => {
    activation = async () => ({ passwordHash: await bcrypt.hash('the-old-one-123', 4), email: 'new@acme.test', companyName: 'Acme' });
    const { res } = await call('post', '/signup/activate', { body: { token: 't', newPassword: 'short' } });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(consumeCalls, []);
  });
  test('oneClick still refuses a bad, used or expired link', async () => {
    const { res } = await call('post', '/signup/activate', { body: { token: 'old', oneClick: true } });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(consumeCalls, []);
  });
  test('a bad, used or expired link is a 400 before any password is looked at', async () => {
    const { res } = await call('post', '/signup/activate', { body: { token: 'old', password: 'whatever1' } });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(consumeCalls, []);
  });
});

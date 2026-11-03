import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// The app sign-in only sends a code when it is useful (SRANK-42), the reminder's resume link signs the person in, and the
// "we need to confirm you" email goes out once when a return request is opened.
const { decideCodeGate: realDecide } = await import('../store/signup-recovery.js');
let users; let sent; let facts; let returning; let opened; let waiting; let redeem; let draft; let platformAdmin;
mock.module(resolve('../store/users.js'), { namedExports: {
  getUserByEmail: async (e) => users[e] || null, getUserById: async (id) => Object.values(users).find((u) => u.id === id) || null,
  updateUserPassword: async () => {}, getUserStatus: async () => 'active', createUser: async () => { throw new Error('not exercised'); } } });
mock.module(resolve('../store/login-codes.js'), { namedExports: {
  CODE_MINUTES: 10, devFixedCode: () => '123456', issueLoginCode: async () => ({ code: '482913' }), checkLoginCode: async () => ({ ok: false }) } });
mock.module(resolve('../store/signup-requests.js'), { namedExports: {
  hasOpenSignupRequest: async () => false, createSignupRequest: async () => null, peekVerificationToken: async () => null,
  consumeVerificationToken: async () => ({ ok: false }), getActivationRequest: async () => null, getCompanyNameForEmail: async () => '' } });
mock.module(resolve('../store/read.js'), { namedExports: { getSiteStatus: async () => 'active', getSiteById: async () => null } });
mock.module(resolve('../store/admin/audit-log.js'), { namedExports: { recordAuditEvent: async () => {} } });
mock.module(resolve('../store/onboarding.js'), { namedExports: { noteGetStartedSignup: async () => {}, markGetStartedVerified: async () => {}, getDraft: async () => draft } });
mock.module(resolve('../store/contact-requests.js'), { namedExports: { createContactRequest: async () => null } });
mock.module(resolve('../store/password-resets.js'), { namedExports: { createPasswordReset: async () => null, consumePasswordReset: async () => null } });
mock.module(resolve('../integrations/google-connect.js'), { namedExports: {
  googleConnectConfigured: () => false, redirectUriFor: () => '', newConnectNonce: () => '', buildSignInUrl: () => '', exchangeSignInCode: async () => null } });
mock.module(resolve('../report/email.js'), { namedExports: {
  sendContactLeadEmail: async () => true, sendPasswordResetEmail: async () => true, sendSignupReceivedEmail: async () => true, sendSignupStaffNotice: async () => true,
  sendLoginCodeEmail: async (o) => { sent.push(o); return true; }, sendReturnRequestStaffNotice: async () => true, sendReturnWaitingEmail: async (o) => { waiting.push(o); return true; } } });
mock.module(resolve('../store/returning.js'), { namedExports: {
  RETURN_WAIT_MESSAGE: 'wait', markReturnUsed: async () => {}, needsReturnApproval: async () => returning, openReturnRequest: async () => opened } });
mock.module(resolve('../store/signup-recovery.js'), { namedExports: {
  getCodeGateFacts: async () => facts, redeemResumeLink: async () => redeem,
  decideCodeGate: realDecide } });
mock.module(resolve('../store/workspaces.js'), { namedExports: {
  isPlatformAdmin: () => platformAdmin, getAccessContext: async () => null, decideSiteAccess: () => ({}), listWorkspacesForUser: async () => [],
  listSharedProjectsForUser: async () => [], pickLoginSite: async () => 5, isBlockedForReadOnly: () => false, isAllowedWithoutProject: () => false } });

const router = (await import('./login.js')).default;

async function call(method, path, { body = {} } = {}) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`route ${method} ${path} not registered`);
  const req = { query: {}, body, session: {}, ip: '203.0.113.9', protocol: 'https', get: () => 'app.test' };
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await layer.route.stack[0].handle(req, res, (e) => { if (e) throw e; });
  return { req, res };
}

beforeEach(() => {
  users = { 'p@acme.test': { id: 7, email: 'p@acme.test', site_id: null, status: 'active', display_name: null } };
  sent = []; waiting = []; facts = { states: ['demo'], started: true }; returning = null; opened = { id: 1, created: true };
  redeem = { ok: false, reason: 'invalid' }; draft = null; platformAdmin = false;
});

describe('POST /login/code/send gates', () => {
  const send = () => call('post', '/login/code/send', { body: { email: 'p@acme.test' } });
  test('a running demo gets its code', async () => {
    const { res } = await send();
    assert.equal(res.statusCode, 200);
    assert.equal(sent.length, 1);
  });
  for (const [name, f, code] of [
    ['setup not finished', { states: [], started: true }, 'SETUP_NOT_FINISHED'],
    ['request pending', { states: ['pending'], started: true }, 'REQUEST_PENDING'],
    ['trial ended', { states: ['ended'], started: true }, 'TRIAL_ENDED'],
  ]) {
    test(`${name}: 403 with ${code} and no code sent`, async () => {
      facts = f;
      const { res } = await send();
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.code, code);
      assert.ok(res.body.error.length > 10);
      assert.equal(sent.length, 0);
    });
  }
  test('someone with no account is still told NO_ACCOUNT (404)', async () => {
    const { res } = await call('post', '/login/code/send', { body: { email: 'nobody@acme.test' } });
    assert.deepEqual([res.statusCode, res.body.code], [404, 'NO_ACCOUNT']);
  });
  test('staff are never held back', async () => {
    facts = { states: [], started: true }; platformAdmin = true;
    assert.equal((await send()).res.statusCode, 200);
  });
  test('a lost workspace is APPROVAL_NEEDED first, and the waiting email goes out once, when the request is opened', async () => {
    returning = { reason: 'gone' };
    const first = (await send()).res;
    assert.deepEqual([first.statusCode, first.body.code], [403, 'APPROVAL_NEEDED']);
    assert.deepEqual(waiting, [{ email: 'p@acme.test' }]);
    opened = { id: 1, created: false };
    await send();
    assert.equal(waiting.length, 1);
    assert.equal(sent.length, 0);
  });
});

describe('POST /get-started/resume-link/redeem', () => {
  const go = (token = 'x'.repeat(43)) => call('post', '/get-started/resume-link/redeem', { body: { token } });
  test('a good link signs the person in and names the step', async () => {
    redeem = { ok: true, userId: 7 }; draft = { step: 'goals', data: {} };
    const { req, res } = await go();
    assert.deepEqual(res.body, { ok: true, step: 'goals', email: 'p@acme.test' });
    assert.equal(req.session.userId, 7);
  });
  test('no saved draft opens the first step', async () => {
    redeem = { ok: true, userId: 7 };
    assert.equal((await go()).res.body.step, 'site');
  });
  test('expired is 410 LINK_EXPIRED, anything else is 400 LINK_INVALID, and neither signs in', async () => {
    redeem = { ok: false, reason: 'expired' };
    const a = await go();
    assert.deepEqual([a.res.statusCode, a.res.body.code, a.req.session.userId], [410, 'LINK_EXPIRED', undefined]);
    redeem = { ok: false, reason: 'invalid' };
    const b = await go();
    assert.deepEqual([b.res.statusCode, b.res.body.code], [400, 'LINK_INVALID']);
  });
});

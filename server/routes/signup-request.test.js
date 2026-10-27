import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// The public sign-up form (POST /signup-requests). What matters: the person's name, role and the
// Terms box are required, the optional fields stay optional, everything is stored on the request
// for staff to read, a bot's hidden field writes nothing, and no account exists until approval.

let created; let notices; let existing;
mock.module(resolve('../store/signup-requests.js'), {
  namedExports: {
    hasOpenSignupRequest: async () => (globalThis.__openSignup ?? false),
  createSignupRequest: async (o) => { created.push(o); return { id: 7, status: 'pending', company_name: o.companyName, website_domain: o.websiteDomain, message: o.message, full_name: o.fullName, role: o.role, heard_from: o.heardFrom }; },
    getActivationRequest: async () => null, getCompanyNameForEmail: async () => null, peekVerificationToken: async () => null,
    consumeVerificationToken: async () => ({ ok: false, reason: 'invalid' }),
  },
});
mock.module(resolve('../store/users.js'), { namedExports: { getUserByEmail: async () => existing, getUserById: async () => null, updateUserPassword: async () => {}, getUserStatus: async () => 'active' } });
mock.module(resolve('../store/read.js'), { namedExports: { getSiteStatus: async () => 'active', getSiteById: async () => null } });
mock.module(resolve('../store/admin/audit-log.js'), { namedExports: { recordAuditEvent: async () => {} } });
mock.module(resolve('../report/email.js'), { namedExports: { sendContactLeadEmail: async () => true, sendPasswordResetEmail: async () => true, sendSignupReceivedEmail: async () => true, sendLoginCodeEmail: async () => true, sendSignupStaffNotice: async (o) => { notices.push(o); return true; } } });
mock.module(resolve('../store/workspaces.js'), { namedExports: { getAccessContext: async () => null, decideSiteAccess: () => ({}), listWorkspacesForUser: async () => [], listSharedProjectsForUser: async () => [], pickLoginSite: async () => null, isBlockedForReadOnly: () => false, isAllowedWithoutProject: () => false } });

const router = (await import('./login.js')).default;

async function submit(body) {
  const layer = router.stack.find((l) => l.route?.path === '/signup-requests' && l.route.methods.post);
  const req = { body, session: {}, ip: '203.0.113.9', protocol: 'https', get: () => 'app.example.test' };
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await layer.route.stack[0].handle(req, res, (e) => { if (e) throw e; });
  return res;
}

const GOOD = { fullName: ' Jane Doe ', companyName: 'Acme Co', contactEmail: 'Jane@Acme.test', password: 'long-enough-1', role: 'SEO', termsAccepted: true };

beforeEach(() => { created = []; notices = []; existing = null; });

describe('POST /signup-requests', () => {
  test('a complete request is saved with the person, their role and the Terms, and staff are told', async () => {
    const res = await submit({ ...GOOD, websiteDomain: 'acme.test', heardFrom: 'Google search' });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.approvalRequired, true);
    assert.equal(created.length, 1);
    assert.equal(created[0].fullName, 'Jane Doe');
    assert.equal(created[0].contactEmail, 'jane@acme.test');
    assert.equal(created[0].role, 'SEO');
    assert.equal(created[0].heardFrom, 'Google search');
    assert.equal(created[0].termsAccepted, true);
    assert.notEqual(created[0].passwordHash, GOOD.password, 'the password is stored hashed');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].fullName, 'Jane Doe');
    assert.match(notices[0].reviewUrl, /\/account\?scope=platform$/, 'the staff email points at Approval requests');
  });
  test('website and how-they-heard stay optional', async () => {
    const res = await submit(GOOD);
    assert.equal(res.statusCode, 201);
    assert.equal(created[0].websiteDomain, null);
    assert.equal(created[0].heardFrom, null);
  });
  test('name, company, role and the Terms box are each required', async () => {
    for (const [field, value] of [['fullName', ' '], ['companyName', ''], ['role', ''], ['termsAccepted', false], ['termsAccepted', 'true'], ['termsAccepted', undefined]]) {
      const res = await submit({ ...GOOD, [field]: value });
      assert.equal(res.statusCode, 400, `${field}=${String(value)} should be refused`);
    }
    assert.equal(created.length, 0, 'nothing is saved for a refused request');
  });
  test('email and an 8 character password are still required', async () => {
    assert.equal((await submit({ ...GOOD, contactEmail: '' })).statusCode, 400);
    assert.equal((await submit({ ...GOOD, password: 'short' })).statusCode, 400);
    assert.equal(created.length, 0);
  });
  test('an address that already has an account gets the same answer as a new one, and nothing is created', async () => {
    const fresh = await submit(GOOD);
    created.length = 0; notices.length = 0;
    existing = { id: 3, email: 'jane@acme.test' };
    const dupe = await submit(GOOD);
    assert.equal(dupe.statusCode, 201);
    assert.equal(dupe.body.message, fresh.body.message, 'nothing reveals that an account exists');
    assert.equal(created.length, 0);
    assert.equal(notices.length, 0);
  });
  test('a repeat request for an address already waiting is accepted but makes no second request', async () => {
    globalThis.__openSignup = true;
    try {
      const res = await submit({ ...GOOD, contactEmail: '  JANE@acme.test ' });
      assert.equal(res.statusCode, 201);
      assert.equal(created.length, 0);
      assert.equal(notices.length, 0);
    } finally { globalThis.__openSignup = false; }
  });
  test('a bot that fills the hidden field is told it worked and nothing is written', async () => {
    const res = await submit({ ...GOOD, honeypot: 'http://spam.test' });
    assert.equal(res.statusCode, 200);
    assert.equal(created.length, 0);
    assert.equal(notices.length, 0);
  });
  test('over-long values are cut, not stored whole', async () => {
    await submit({ ...GOOD, fullName: 'x'.repeat(500), role: 'y'.repeat(500), heardFrom: 'z'.repeat(500) });
    assert.equal(created[0].fullName.length, 120);
    assert.equal(created[0].role.length, 80);
    assert.equal(created[0].heardFrom.length, 120);
  });
});

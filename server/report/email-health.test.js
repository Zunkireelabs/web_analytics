import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const resolve = (p) => fileURLToPath(new URL(p, import.meta.url));

// Mail that cannot go out must leave a trace beyond a log line: the person waiting for a sign-in code or an
// approval link would otherwise just wait. Every sender goes through one transporter, so one check covers all.
let checks; let sendBehaviour;
mock.module('nodemailer', { defaultExport: { createTransport: () => ({ sendMail: async (m) => sendBehaviour(m) }) } });
mock.module(resolve('../store/upsert.js'), { namedExports: { recordIntegrationCheck: async (id, siteId, c) => { checks.push({ id, siteId, ...c }); } } });
const { sendLoginCodeEmail, sendSignupApprovedEmail } = await import('./email.js');

const saved = { ...process.env };
beforeEach(() => {
  checks = []; sendBehaviour = async () => ({ messageId: 'x' });
  delete process.env.EMAIL_REDIRECT_TO; delete process.env.DEV_MAIL_ALL_TO; delete process.env.DEV_MAIL_OUTBOX;
});
afterEach(() => { process.env = { ...saved }; });
const tick = () => new Promise((r) => setTimeout(r, 20));

test('with no SMTP configured the send is skipped AND recorded as not configured', async () => {
  delete process.env.SMTP_HOST; delete process.env.SMTP_USER; delete process.env.SMTP_PASS;
  // a distinct state each time, since identical consecutive states are written at most every 10 minutes
  assert.equal(await sendLoginCodeEmail({ email: 'a@b.test', code: '123456', minutes: 10 }), false);
  await tick();
  assert.equal(checks.at(-1).ok, false);
  assert.equal(checks.at(-1).authStatus, 'not_configured');
  assert.equal(checks.at(-1).id, 'email');
});

test("the provider's own error is recorded and still thrown to the caller", async () => {
  Object.assign(process.env, { SMTP_HOST: 'smtp.test', SMTP_USER: 'u', SMTP_PASS: 'p' });
  sendBehaviour = async () => { throw new Error('535 authentication failed'); };
  await assert.rejects(() => sendSignupApprovedEmail({ contactEmail: 'a@b.test', companyName: 'Acme', signInUrl: 'https://x.test' }), /535/);
  await tick();
  assert.equal(checks.at(-1).ok, false);
  assert.match(checks.at(-1).errorMessage, /535 authentication failed/);
});

test('a send that works records healthy again', async () => {
  Object.assign(process.env, { SMTP_HOST: 'smtp.test', SMTP_USER: 'u', SMTP_PASS: 'p' });
  assert.equal(await sendLoginCodeEmail({ email: 'a@b.test', code: '123456', minutes: 10 }), true);
  await tick();
  assert.equal(checks.at(-1).ok, true);
});

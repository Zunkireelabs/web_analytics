import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  staffNoticeRecipients, DEFAULT_STAFF_NOTICE_RECIPIENTS,
  sendSignupStaffNotice, sendAccessRequestStaffNotice, sendReturnRequestStaffNotice, sendContactLeadEmail,
} from './email.js';

// A request waiting for staff used to be mailed to ONE shared inbox. These tests send through the dev outbox — the same
// path real mail takes, writing a page instead of sending — so what is asserted is what would land in the inboxes.

describe('who is told', () => {
  test('both company inboxes by default', () => {
    assert.deepEqual(staffNoticeRecipients({}), ['info@zunkireelabs.com', 'yukta@zunkireelabs.com']);
    assert.deepEqual([...DEFAULT_STAFF_NOTICE_RECIPIENTS], ['info@zunkireelabs.com', 'yukta@zunkireelabs.com']);
  });

  test('STAFF_NOTICE_EMAILS overrides it, comma or semicolon separated', () => {
    assert.deepEqual(staffNoticeRecipients({ STAFF_NOTICE_EMAILS: 'a@x.test, b@y.test' }), ['a@x.test', 'b@y.test']);
    assert.deepEqual(staffNoticeRecipients({ STAFF_NOTICE_EMAILS: 'a@x.test;b@y.test' }), ['a@x.test', 'b@y.test']);
  });

  test('addresses are lowercased, trimmed and de-duplicated', () => {
    assert.deepEqual(staffNoticeRecipients({ STAFF_NOTICE_EMAILS: ' A@X.test , a@x.test ' }), ['a@x.test']);
  });

  test('an override with no valid address falls back to the default, never to nobody', () => {
    for (const junk of ['', '   ', 'not-an-email', ',,;;', 'a@b', '@x.test']) {
      assert.deepEqual(staffNoticeRecipients({ STAFF_NOTICE_EMAILS: junk }), [...DEFAULT_STAFF_NOTICE_RECIPIENTS], JSON.stringify(junk));
    }
  });

  test('invalid entries are dropped but valid ones in the same list are kept', () => {
    assert.deepEqual(staffNoticeRecipients({ STAFF_NOTICE_EMAILS: 'junk, ok@x.test, also bad' }), ['ok@x.test']);
  });

  test('the default list cannot be mutated by a caller', () => {
    const a = staffNoticeRecipients({});
    a.push('someone@else.test');
    assert.deepEqual(staffNoticeRecipients({}), ['info@zunkireelabs.com', 'yukta@zunkireelabs.com']);
    assert.throws(() => { DEFAULT_STAFF_NOTICE_RECIPIENTS.push('x@y.test'); }, TypeError);
  });
});

describe('what actually lands, sent through the real mail path', () => {
  let outbox; let saved;
  beforeEach(() => {
    outbox = mkdtempSync(join(tmpdir(), 'staff-notice-'));
    saved = { ...process.env };
    for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_REDIRECT_TO', 'DEV_MAIL_ALL_TO', 'STAFF_NOTICE_EMAILS']) delete process.env[k];
    process.env.DEV_MAIL_OUTBOX = outbox;
    process.env.NODE_ENV = 'test';
  });
  afterEach(() => {
    process.env = saved;
    rmSync(outbox, { recursive: true, force: true });
  });

  const lastMail = () => {
    const files = readdirSync(outbox);
    assert.equal(files.length, 1, 'exactly one message per request, not one per recipient');
    return readFileSync(join(outbox, files[0]), 'utf8');
  };

  test('a Get Started sign-up reaches both inboxes in ONE message', async () => {
    await sendSignupStaffNotice({ companyName: 'Acme Co', contactEmail: 'owner@acme.test', reviewUrl: 'https://app.test/account?scope=platform' });
    const mail = lastMail();
    assert.match(mail, /To:<\/b> info@zunkireelabs\.com, yukta@zunkireelabs\.com/);
    assert.match(mail, /New sign-up request: Acme Co|New sign-up request/);
    assert.match(mail, /Review the request/);
  });

  test('a free-trial access request says what it is, and reaches both', async () => {
    await sendAccessRequestStaffNotice({ companyName: 'Acme Co', contactEmail: 'owner@acme.test', summary: { goals: ['grow'] }, reviewUrl: 'https://app.test/x' });
    const mail = lastMail();
    assert.match(mail, /To:<\/b> info@zunkireelabs\.com, yukta@zunkireelabs\.com/);
    assert.match(mail, /Free-trial request/);
    assert.match(mail, /finished Get Started/);
  });

  test('a returning account that needs approval reaches both', async () => {
    await sendReturnRequestStaffNotice({ email: 'back@acme.test', name: 'Back', reason: 'everything was deleted', reviewUrl: 'https://app.test/y' });
    const mail = lastMail();
    assert.match(mail, /To:<\/b> info@zunkireelabs\.com, yukta@zunkireelabs\.com/);
    assert.match(mail, /Returning account needs approval/);
  });

  test('a Contact Us lead reaches both', async () => {
    await sendContactLeadEmail({ companyName: 'Acme Co', websiteDomain: 'acme.test', contactEmail: 'owner@acme.test', message: 'Hello' });
    assert.match(lastMail(), /To:<\/b> info@zunkireelabs\.com, yukta@zunkireelabs\.com/);
  });

  test('an override changes who receives it, at send time', async () => {
    process.env.STAFF_NOTICE_EMAILS = 'ops@company.test';
    await sendSignupStaffNotice({ companyName: 'Acme Co', contactEmail: 'owner@acme.test', reviewUrl: 'https://app.test/z' });
    const mail = lastMail();
    assert.match(mail, /To:<\/b> ops@company\.test/);
    assert.ok(!/info@zunkireelabs/.test(mail.split('<div')[0] || ''));
  });

  test('what the stranger typed never reaches the page as markup', async () => {
    await sendSignupStaffNotice({ companyName: '<img src=x onerror=alert(1)>', contactEmail: 'o@a.test', message: '<script>x</script>', reviewUrl: 'https://app.test/z' });
    const mail = lastMail();
    assert.ok(!mail.includes('<img src=x'));
    assert.ok(!mail.includes('<script>x'));
  });
});

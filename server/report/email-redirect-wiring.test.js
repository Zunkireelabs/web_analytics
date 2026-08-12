import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// email-redirect.test.js covers the redirect's pure pieces. This one covers
// the part that can silently break without them noticing: whether
// getTransporter's WRAPPER is actually in the path a real sender takes. The
// wrapper rebuilds the transporter object, so a mistake there fails open —
// mail goes to the real client and every pure-function test still passes.
// That is the failure mode worth a test.

let sent; // every message nodemailer was actually asked to send

mock.module('nodemailer', {
  defaultExport: {
    createTransport: () => ({
      sendMail: async (message) => { sent.push(message); return { messageId: 'test' }; },
    }),
  },
});

const { sendDailyEmail, sendInvitationEmail, sendPasswordResetEmail, sendNotificationEmail, sendContactLeadEmail } = await import('./email.js');

const SITE = { name: 'LifeLinkNepal', report_email_to: 'client@lifelinknepal.com' };
const DAY = { clicks: 10, impressions: 100, users: 5, sessions: 7 };

const SAVED = { ...process.env };
beforeEach(() => {
  sent = [];
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_USER = 'bot@example.com';
  process.env.SMTP_PASS = 'secret';
});
afterEach(() => {
  for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_REDIRECT_TO']) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe('sendDailyEmail — redirect wiring', () => {
  test('with EMAIL_REDIRECT_TO set, a real client report never reaches the client', () => {
    process.env.EMAIL_REDIRECT_TO = 'yukta@zunkireelabs.com';
    return sendDailyEmail(SITE, '2026-08-12', DAY, 'narrative').then(() => {
      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, 'yukta@zunkireelabs.com');
      assert.equal(sent[0].headers['X-Original-To'], 'client@lifelinknepal.com');
      assert.match(sent[0].subject, /^\[REDIRECTED → client@lifelinknepal\.com\]/);
      // The report itself must still be intact — this is a redirect, not a drop.
      assert.match(sent[0].html, /LifeLinkNepal/);
    });
  });

  test('with EMAIL_REDIRECT_TO unset, the real recipient is used unchanged', () => {
    delete process.env.EMAIL_REDIRECT_TO;
    return sendDailyEmail(SITE, '2026-08-12', DAY, 'narrative').then(() => {
      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, 'client@lifelinknepal.com');
      assert.doesNotMatch(sent[0].subject, /REDIRECTED/);
      assert.equal(sent[0].headers, undefined);
    });
  });
});

// The redirect exists to stop BULK, SYSTEM-INITIATED reporting reaching real
// clients from an environment that changes daily. Invitations and password
// resets are neither: each is addressed to one person who just asked for that
// exact link, and redirecting it doesn't protect them — it silently breaks
// the thing they requested.
//
// The tests that matter most here are the ones proving the exemption did NOT
// widen: everything else must still be redirected.
describe('transactional exemption', () => {
  const REAL = 'someone@client.example';

  test('an invitation reaches its real recipient', () => {
    process.env.EMAIL_REDIRECT_TO = 'yukta@zunkireelabs.com';
    return sendInvitationEmail({ to: REAL, siteName: 'LifeLinkNepal', role: 'tenant_admin', acceptUrl: 'https://app.example/accept?t=1' })
      .then(() => {
        assert.equal(sent[0].to, REAL);
        assert.doesNotMatch(sent[0].subject, /REDIRECTED/);
      });
  });

  test('a password reset reaches its real recipient', () => {
    process.env.EMAIL_REDIRECT_TO = 'yukta@zunkireelabs.com';
    return sendPasswordResetEmail({ to: REAL, resetUrl: 'https://app.example/reset?t=1' })
      .then(() => {
        assert.equal(sent[0].to, REAL);
        assert.doesNotMatch(sent[0].subject, /REDIRECTED/);
      });
  });

  test('the exemption marker never reaches the SMTP envelope', () => {
    // A Symbol key would not serialise anyway, but an exemption flag leaking
    // into a real message is the kind of thing worth pinning.
    process.env.EMAIL_REDIRECT_TO = 'yukta@zunkireelabs.com';
    return sendPasswordResetEmail({ to: REAL, resetUrl: 'https://app.example/reset' })
      .then(() => {
        assert.equal(Object.getOwnPropertySymbols(sent[0]).length, 0);
      });
  });

  test('EXEMPTION DID NOT WIDEN: a client report is still redirected', () => {
    process.env.EMAIL_REDIRECT_TO = 'yukta@zunkireelabs.com';
    return sendDailyEmail(SITE, '2026-08-12', DAY, 'narrative').then(() => {
      assert.equal(sent[0].to, 'yukta@zunkireelabs.com');
      assert.match(sent[0].subject, /^\[REDIRECTED/);
    });
  });

  test('EXEMPTION DID NOT WIDEN: a notification email is still redirected', () => {
    process.env.EMAIL_REDIRECT_TO = 'yukta@zunkireelabs.com';
    return sendNotificationEmail(SITE, [{ title: 'Something changed', body: 'Detail.' }]).then(() => {
      if (!sent.length) return; // no events -> no send, which is also fine
      assert.equal(sent[0].to, 'yukta@zunkireelabs.com');
    });
  });

  test('EXEMPTION DID NOT WIDEN: a sales lead is still redirected', () => {
    process.env.EMAIL_REDIRECT_TO = 'yukta@zunkireelabs.com';
    return sendContactLeadEmail({ companyName: 'Acme', websiteDomain: 'acme.com', contactEmail: 'a@acme.com', message: 'hi' })
      .then(() => {
        if (!sent.length) return;
        assert.equal(sent[0].to, 'yukta@zunkireelabs.com');
      });
  });

  test('with the redirect OFF, transactional mail is unchanged', () => {
    delete process.env.EMAIL_REDIRECT_TO;
    return sendInvitationEmail({ to: REAL, siteName: 'S', role: 'tenant_member', acceptUrl: 'https://app.example/a' })
      .then(() => {
        assert.equal(sent[0].to, REAL);
        assert.equal(sent[0].headers, undefined);
      });
  });
});

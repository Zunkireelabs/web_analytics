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

const { sendDailyEmail } = await import('./email.js');

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

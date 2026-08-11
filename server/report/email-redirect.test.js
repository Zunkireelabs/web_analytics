import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyRedirect, redirectTarget } from './email.js';

// The staging VPS is currently the live automation host (production/main has
// never been deployed), its 07:00/Thursday cron is deliberately live, and real
// client sites share its database. EMAIL_REDIRECT_TO is what stops the daily
// pipeline emailing those clients from an environment that still changes
// daily. It is a safety mechanism, so it gets tested like one.

const ORIGINAL = process.env.EMAIL_REDIRECT_TO;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.EMAIL_REDIRECT_TO;
  else process.env.EMAIL_REDIRECT_TO = ORIGINAL;
});

describe('redirectTarget', () => {
  test('is off by default — production must reach real recipients', () => {
    delete process.env.EMAIL_REDIRECT_TO;
    assert.equal(redirectTarget(), null);
  });

  test('an empty or whitespace-only value is off, not a redirect to ""', () => {
    // An unset GitHub Actions var interpolates to an empty string, so this is
    // the real shape of "not configured", not a theoretical one. Treating it
    // as a target would send every email to nobody and look like success.
    process.env.EMAIL_REDIRECT_TO = '';
    assert.equal(redirectTarget(), null);
    process.env.EMAIL_REDIRECT_TO = '   ';
    assert.equal(redirectTarget(), null);
  });

  test('a configured address is returned trimmed', () => {
    process.env.EMAIL_REDIRECT_TO = '  yukta@zunkireelabs.com  ';
    assert.equal(redirectTarget(), 'yukta@zunkireelabs.com');
  });
});

describe('applyRedirect', () => {
  const target = 'yukta@zunkireelabs.com';

  test('replaces the real recipient', () => {
    const out = applyRedirect({ to: 'client@lifelinknepal.com', subject: 'Daily report' }, target);
    assert.equal(out.to, target);
  });

  test('strips cc and bcc — a redirect that left cc intact would still reach the client', () => {
    const out = applyRedirect(
      { to: 'a@client.com', cc: 'b@client.com', bcc: 'c@client.com', subject: 'S' },
      target,
    );
    assert.equal(out.to, target);
    assert.equal(out.cc, undefined);
    assert.equal(out.bcc, undefined);
  });

  test('preserves every original recipient in the subject and X-Original-To', () => {
    // Without this a morning of redirected client reports is indistinguishable
    // from a morning of one's own mail.
    const out = applyRedirect(
      { to: 'a@client.com', cc: 'b@client.com', subject: 'Daily report' },
      target,
    );
    assert.equal(out.headers['X-Original-To'], 'a@client.com, b@client.com');
    assert.match(out.subject, /^\[REDIRECTED → a@client\.com, b@client\.com\] Daily report$/);
  });

  test('records "(none)" rather than an empty label when a message had no recipient', () => {
    const out = applyRedirect({ subject: 'S' }, target);
    assert.equal(out.headers['X-Original-To'], '(none)');
  });

  test('keeps the body and other fields untouched', () => {
    const out = applyRedirect({ to: 'a@client.com', subject: 'S', html: '<p>hi</p>', from: 'bot@x.com' }, target);
    assert.equal(out.html, '<p>hi</p>');
    assert.equal(out.from, 'bot@x.com');
  });

  test('does not clobber pre-existing headers', () => {
    const out = applyRedirect({ to: 'a@client.com', subject: 'S', headers: { 'X-Thing': '1' } }, target);
    assert.equal(out.headers['X-Thing'], '1');
    assert.equal(out.headers['X-Original-To'], 'a@client.com');
  });

  test('handles a missing subject without producing "undefined"', () => {
    const out = applyRedirect({ to: 'a@client.com' }, target);
    assert.equal(out.subject, '[REDIRECTED → a@client.com]');
  });
});

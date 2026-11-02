import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildAccessClientEmail, buildAccessDemoEmail, buildAccessRequestStaffNotice, buildAccessReceivedEmail } from './email.js';

const o = { companyName: 'Zunkireelabs', contactEmail: 'yukta@zunkireelabs.com', signInUrl: 'https://app.superrank.si/login?email=yukta%40zunkireelabs.com' };

describe('access emails', () => {
  test('a real client is told to sign in, and that Google and GitHub can be connected from the dashboard', () => {
    const { subject, html } = buildAccessClientEmail(o);
    assert.equal(subject, 'Your SuperRank request is approved');
    assert.match(html, /Sign in/);
    assert.match(html, /login\?email=yukta%40zunkireelabs\.com/);
    assert.match(html, /Connect Google Search Console, Analytics and GitHub from your dashboard/);
    assert.doesNotMatch(html, /demo/i);
  });
  test('an upgrade says so', () => {
    assert.equal(buildAccessClientEmail({ ...o, upgraded: true }).subject, 'You are now a SuperRank client');
  });
  test('a demo says how long, when it ends, and what stays after', () => {
    const { subject, html } = buildAccessDemoEmail({ ...o, endsAt: '2026-11-17T09:00:00Z' });
    assert.equal(subject, 'Your SuperRank request is approved: enjoy your demo');
    assert.match(html, /17 November 2026/);
    assert.match(html, />Sign in</);
    assert.match(html, /Overview stays/);
    assert.match(html, /Want to keep going\? Talk to us/);
  });
  test('the request-received email says what happens next', () => {
    const { subject, html } = buildAccessReceivedEmail(o);
    assert.equal(subject, 'We received your SuperRank request');
    assert.match(html, /We have it/);
    assert.match(html, /We review it/);
    assert.match(html, /With a button to sign in/);
  });
  test('an extension says so', () => {
    assert.equal(buildAccessDemoEmail({ ...o, endsAt: '2026-12-01T00:00:00Z', renewed: true }).subject, 'Your SuperRank demo has been extended');
  });
  test('text from a person is escaped', () => {
    const { html } = buildAccessClientEmail({ ...o, companyName: '<script>alert(1)</script>' });
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
  });
  test('the staff notice carries what they set up and a way to decide', () => {
    const { subject, html } = buildAccessRequestStaffNotice({
      companyName: 'Zunkireelabs', websiteDomain: 'zunkireelabs.com', contactEmail: 'yukta@zunkireelabs.com',
      summary: { goals: ['geo'], markets: ['Africa'], topics: ['a', 'b', 'c', 'd', 'e', 'f'], prompts: 36, competitors: ['Acme AI'] },
      reviewUrl: 'https://app.superrank.si/account?scope=platform',
    });
    assert.equal(subject, 'Free-trial request: Zunkireelabs');
    assert.match(html, /36/);
    assert.match(html, /6: a, b, c, d, e…/);
    assert.match(html, /Review the request/);
  });
});

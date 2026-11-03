import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignupReminderEmail, buildReturnWaitingEmail, plainTextOf } from './email.js';

const evil = '<img src=x onerror=alert(1)>"\'&';

describe('sign-up reminder (to the person)', () => {
  const m = buildSignupReminderEmail({
    brand: 'Lumen Homes', step: 8, resumeUrl: 'https://superrank.si/get-started?resume=abc', linkDays: 2, keepDays: 30,
    unsubscribeUrl: 'https://app.superrank.si/api/get-started/unsubscribe?token=1.x', lastAnswered: '2026-10-28T10:00:00Z',
    lines: { 'Website and brand': 'lumenhomes.co · Lumen Homes', 'Brand profile': 'Smart lighting, 2 competitors' },
  });
  test('says how far they got, in the subject and the bar', () => {
    assert.equal(m.subject, 'Lumen Homes is 3 steps from its first AI search results');
    assert.match(m.html, /8 of 11 steps/);
    assert.match(m.html, /73% done/);
    assert.match(m.html, /28 October 2026/);
  });
  test('has one button to the resume link and says how long it works', () => {
    assert.match(m.html, /href="https:\/\/superrank\.si\/get-started\?resume=abc"[^>]*>Finish my setup<\/a>/);
    assert.match(m.html, /works for 2 days/);
  });
  test('lists where they left off: done rows with details, the current row, and what is still ahead', () => {
    assert.match(m.html, /lumenhomes\.co/);
    assert.match(m.html, /Smart lighting, 2 competitors/);
    assert.match(m.html, /Pick what matters most/);
    assert.match(m.html, /Markets, topics and prompts/);
  });
  test('says answers stay saved and has an unsubscribe link', () => {
    assert.match(m.html, /answers stay saved for 30 days/);
    assert.match(m.html, /href="https:\/\/app\.superrank\.si\/api\/get-started\/unsubscribe\?token=1\.x"[^>]*>Unsubscribe<\/a>/);
  });
  test('has a plain-text twin that keeps the link', () => assert.match(plainTextOf(m.html), /Finish my setup \(https:\/\/superrank\.si\/get-started\?resume=abc\)/));
  test('escapes everything the person typed', () => {
    const x = buildSignupReminderEmail({ brand: evil, step: 3, resumeUrl: 'https://x.test/"><script>1</script>', lines: { 'Website and brand': evil } });
    assert.equal(x.html.includes('<img'), false);
    assert.equal(x.html.includes('<script>'), false);
  });
  test('one step left reads naturally', () => assert.match(buildSignupReminderEmail({ brand: 'A', step: 10, resumeUrl: 'u' }).subject, /1 step from/));
});

describe('return waiting (to the person)', () => {
  const m = buildReturnWaitingEmail({ email: 'priya@lumenhomes.co' });
  test('says sign-in is paused, who was told, and that nothing is needed', () => {
    assert.equal(m.subject, 'We need to confirm you before you sign in');
    assert.match(m.html, /priya@lumenhomes\.co/);
    assert.match(m.html, /one working day/);
    assert.match(m.html, /do not need to do anything/);
    assert.equal(/<a /.test(m.html), false);
  });
  test('escapes the address', () => assert.equal(buildReturnWaitingEmail({ email: evil }).html.includes('<img'), false));
});

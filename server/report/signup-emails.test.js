import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignupReceivedEmail, buildSignupApprovedEmail, buildSignupStaffNotice, buildLoginCodeEmail } from './email.js';

// What a person reads when they sign up, and what staff read when a request
// arrives. The company name, website and message are typed by a stranger on a
// public form, so none of it may reach the HTML as markup.
const evil = '<img src=x onerror=alert(1)>"\'&';

describe('sign-up received (to the person)', () => {
  const m = buildSignupReceivedEmail({ companyName: 'Acme Co', contactEmail: 'owner@acme.test' });
  test('says it is not active yet, who decides, and what happens next', () => {
    assert.equal(m.subject, 'We received your SuperRank request');
    assert.match(m.html, /not active yet/);
    assert.match(m.html, /A person at SuperRank checks every new account/);
    assert.match(m.html, /owner@acme\.test/);
    assert.match(m.html, /password you chose/);
  });
  test('has no sign-in link, because there is nothing to sign in to yet', () => {
    assert.equal(/<a /.test(m.html), false);
  });
  test('escapes everything the person typed', () => {
    const x = buildSignupReceivedEmail({ companyName: evil, contactEmail: evil });
    assert.equal(x.html.includes('<img'), false);
    assert.match(x.html, /&lt;img/);
  });
});

describe('sign-up approved (to the person)', () => {
  const url = 'https://app.superrank.si/login?token=abc123';
  const m = buildSignupApprovedEmail({ companyName: 'Acme Co', contactEmail: 'owner@acme.test', signInUrl: url });
  test('says the account is approved and has one Sign in button that opens the app sign-in', () => {
    assert.equal(m.subject, 'Your SuperRank account is approved');
    assert.match(m.html, /Your account is approved\./);
    assert.match(m.html, /href="https:\/\/app\.superrank\.si\/login\?token=abc123"[^>]*>Sign in<\/a>/);
    assert.equal(/Confirm my email/.test(m.html), false);
  });
  test('says which address and which password to use, and what follows', () => {
    assert.match(m.html, /owner@acme\.test/);
    assert.match(m.html, /password you chose/);
    assert.match(m.html, /Name your workspace/);
    assert.match(m.html, /Add your first project/);
  });
  test('says the link expires and does nothing if they did not ask', () => {
    assert.match(m.html, /expires in 7 days/);
    assert.match(m.html, /nothing is created/);
  });
  test('never contains their password', () => {
    assert.equal(/password[^<]{0,40}:\s*\S+/i.test(m.html), false);
  });
  test('escapes the company name, the address and the link', () => {
    const x = buildSignupApprovedEmail({ companyName: evil, contactEmail: evil, signInUrl: 'https://x.test/"><script>alert(1)</script>' });
    assert.equal(x.html.includes('<img'), false);
    assert.equal(x.html.includes('<script>'), false);
  });
});

describe('sign-in code (to the person)', () => {
  const m = buildLoginCodeEmail({ email: 'owner@acme.test', code: '482913' });
  test('puts the code in the subject and in the message, spaced for reading', () => {
    assert.equal(m.subject, 'Your SuperRank sign-in code: 482 913');
    assert.match(m.html, />482913</);
  });
  test('says it works once, when it expires, and who asked', () => {
    assert.match(m.html, /works once and expires in <b>10 minutes<\/b>/);
    assert.match(m.html, /owner@acme\.test/);
    assert.match(m.html, /Never share it/);
  });
  test('has no link, so it cannot be copied by a phishing message', () => {
    assert.equal(/<a /.test(m.html), false);
  });
  test('escapes the address', () => {
    assert.equal(buildLoginCodeEmail({ email: evil, code: '123456' }).html.includes('<img'), false);
  });
});

describe('sign-up staff notice', () => {
  const base = { companyName: 'Acme Co', websiteDomain: 'acme.test', contactEmail: 'owner@acme.test', message: 'We run a dental clinic', reviewUrl: 'https://app.superrank.si/clients' };
  test('names the company and links to where it is reviewed', () => {
    const m = buildSignupStaffNotice(base);
    assert.equal(m.subject, 'New sign-up request: Acme Co');
    assert.match(m.html, /href="https:\/\/app\.superrank\.si\/clients"/);
    assert.match(m.html, /We run a dental clinic/);
  });
  test('leaves out rows and the message when they were not given', () => {
    const m = buildSignupStaffNotice({ ...base, websiteDomain: null, message: null });
    assert.equal(m.html.includes('Website'), false);
    assert.equal(m.html.includes('dental'), false);
  });
  test('explains what approving does and does not do', () => {
    assert.match(buildSignupStaffNotice(base).html, /Approving creates their login only/);
  });
  test('a stranger-typed message, website and name cannot inject markup', () => {
    const m = buildSignupStaffNotice({ ...base, companyName: evil, websiteDomain: evil, message: evil, contactEmail: evil });
    assert.equal(m.html.includes('<img'), false);
  });
});

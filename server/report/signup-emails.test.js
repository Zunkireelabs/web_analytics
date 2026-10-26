import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignupReceivedEmail, buildSignupApprovedEmail, buildSignupStaffNotice } from './email.js';

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
  const url = 'https://app.superrank.si/verify-email?token=abc123';
  const m = buildSignupApprovedEmail({ companyName: 'Acme Co', contactEmail: 'owner@acme.test', confirmUrl: url });
  test('says the request is approved, asks them to confirm that address, and links to the confirm page', () => {
    assert.equal(m.subject, 'Confirm your email to open your SuperRank account');
    assert.match(m.html, /Your request is approved/);
    assert.match(m.html, /confirm that <b>owner@acme\.test<\/b> is your email address/);
    assert.match(m.html, /Your account is created when you do/);
    assert.match(m.html, /href="https:\/\/app\.superrank\.si\/verify-email\?token=abc123"/);
  });
  test('tells them what follows: sign in with the password they chose, then name a workspace and add a project', () => {
    assert.match(m.html, /password you chose/);
    assert.match(m.html, /name your workspace and add your first project/);
  });
  test('says the link works once, expires, and does nothing if they did not ask', () => {
    assert.match(m.html, /works once and expires in 7 days/);
    assert.match(m.html, /nothing will be created/);
  });
  test('never contains their password', () => {
    assert.equal(/password[^<]{0,40}:\s*\S+/i.test(m.html), false);
  });
  test('escapes the company name, the address and the link', () => {
    const x = buildSignupApprovedEmail({ companyName: evil, contactEmail: evil, confirmUrl: 'https://x.test/"><script>alert(1)</script>' });
    assert.equal(x.html.includes('<img'), false);
    assert.equal(x.html.includes('<script>'), false);
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

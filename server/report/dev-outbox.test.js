import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendPasswordResetEmail } from './email.js';

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  return Promise.resolve(fn()).finally(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
}

test('with DEV_MAIL_OUTBOX set and no SMTP, an email is saved as a page and nothing is sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-'));
  await withEnv({ SMTP_HOST: undefined, SMTP_USER: undefined, SMTP_PASS: undefined, DEV_MAIL_OUTBOX: dir, NODE_ENV: 'development' }, async () => {
    assert.equal(await sendPasswordResetEmail({ to: 'asha@acme.com', resetUrl: 'https://app.example.com/reset?t=abc' }), true);
  });
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  const html = readFileSync(join(dir, files[0]), 'utf8');
  assert.match(html, /asha@acme\.com/);
  assert.match(html, /reset\?t=abc/);
});

test('in production, or without the setting, mail is skipped exactly as before', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-'));
  await withEnv({ SMTP_HOST: undefined, SMTP_USER: undefined, SMTP_PASS: undefined, DEV_MAIL_OUTBOX: dir, NODE_ENV: 'production' }, async () => {
    assert.equal(await sendPasswordResetEmail({ to: 'a@b.com', resetUrl: 'https://x/r' }), false);
  });
  await withEnv({ SMTP_HOST: undefined, SMTP_USER: undefined, SMTP_PASS: undefined, DEV_MAIL_OUTBOX: undefined, NODE_ENV: 'development' }, async () => {
    assert.equal(await sendPasswordResetEmail({ to: 'a@b.com', resetUrl: 'https://x/r' }), false);
  });
  assert.equal(readdirSync(dir).length, 0);
});

import { devAllToWrap, devAllToTarget, REDIRECT_EXEMPT } from './email.js';

test('DEV_MAIL_ALL_TO sends every message, even exempt ones, to the one test inbox and keeps the original recipient visible', async () => {
  const sent = [];
  const wrapped = devAllToWrap({ sendMail: async (m) => { sent.push(m); } }, 'me@zunkireelabs.com', { outbox: null });
  await wrapped.sendMail({ [REDIRECT_EXEMPT]: true, to: 'client@real.com', cc: 'boss@real.com', subject: 'Your sign-in code', html: '<p>hi</p>' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'me@zunkireelabs.com');
  assert.equal(sent[0].cc, undefined);
  assert.match(sent[0].subject, /client@real\.com/);
  assert.equal(sent[0].headers['X-Original-To'], 'client@real.com, boss@real.com');
  assert.equal(sent[0][REDIRECT_EXEMPT], undefined, 'the exemption flag never reaches the transport');
});

test('DEV_MAIL_ALL_TO does nothing in production', () => {
  assert.equal(devAllToTarget({ DEV_MAIL_ALL_TO: 'me@zunkireelabs.com', NODE_ENV: 'production' }), null);
  assert.equal(devAllToTarget({ DEV_MAIL_ALL_TO: 'me@zunkireelabs.com', NODE_ENV: 'development' }), 'me@zunkireelabs.com');
  assert.equal(devAllToTarget({ NODE_ENV: 'development' }), null);
});

import { emailShell } from './email.js';

test('the logo comes from EMAIL_LOGO_URL when set, else from the app address', async () => {
  const get = (env) => withEnv({ APP_BASE_URL: 'http://localhost:5174', EMAIL_LOGO_URL: undefined, ...env }, () => emailShell({ eyebrow: 'x', title: 'y', intro: 'z' }));
  assert.match(await get({}), /src="http:\/\/localhost:5174\/superrank-logo\.png"/);
  assert.match(await get({ EMAIL_LOGO_URL: 'https://app.superrank.si/superrank-logo.png' }), /src="https:\/\/app\.superrank\.si\/superrank-logo\.png"/);
});

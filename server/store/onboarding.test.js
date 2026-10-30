import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mapGoals, cleanOnboarding } from './onboarding.js';
import { GOAL_KEYS } from './workspaces.js';

describe('mapGoals', () => {
  test('turns the page goals into the app goals, in order, without repeats', () => {
    assert.deepEqual(mapGoals(['seo', 'aeo', 'geo', 'agentic', 'content']), ['key_rankings', 'ai_answers', 'google_visitors']);
  });
  test('reporting to clients is the custom goal; unknown goals are dropped', () => {
    assert.deepEqual(mapGoals(['clients', 'nope']), ['custom']);
    assert.deepEqual(mapGoals(undefined), []);
  });
  test('only ever produces goals the app knows', () => {
    for (const g of mapGoals(['seo', 'aeo', 'geo', 'agentic', 'content', 'clients'])) assert.ok(g === 'custom' || GOAL_KEYS.includes(g));
  });
});

describe('cleanOnboarding', () => {
  test('caps lists and text so a crafted request cannot store a huge blob', () => {
    const c = cleanOnboarding({
      brand: 'x'.repeat(500), prompts: Array.from({ length: 900 }, (_, i) => ({ text: `p${i}` })),
      topics: Array.from({ length: 900 }, (_, i) => `t${i}`), brandedShare: 9999, profile: { description: 'd'.repeat(5000) },
    });
    assert.equal(c.brand.length, 120);
    assert.equal(c.prompts.length, 200);
    assert.equal(c.topics.length, 50);
    assert.equal(c.brandedShare, 100);
    assert.equal(c.profile.description.length, 1200);
  });
  test('survives an empty or odd body', () => {
    for (const body of [undefined, null, {}, { prompts: 'x', markets: 5, goals: 'seo' }]) {
      const c = cleanOnboarding(body);
      assert.deepEqual(c.prompts, []);
      assert.equal(c.markets.scope, 'global');
    }
  });
  test('keeps only prompts that have text', () => {
    assert.deepEqual(cleanOnboarding({ prompts: [{ text: '  ' }, 'best crm', { text: 'q', branded: true }] }).prompts.map((p) => p.text), ['best crm', 'q']);
  });
});

import { buildLoginCodeEmail } from '../report/email.js';
import { AUTH_LIMITS } from '../lib/rate-limit.js';

describe('get-started code email', () => {
  test('says it is for the trial, keeps the code, and plain sign-in stays unchanged', () => {
    const trial = buildLoginCodeEmail({ email: 'a@b.test', code: '123456', trial: true });
    assert.match(trial.html, /free trial/);
    assert.match(trial.html, /123456/);
    assert.match(buildLoginCodeEmail({ email: 'a@b.test', code: '123456' }).html, /sign-in page/);
  });
  test('sending and checking a code are both rate limited', () => {
    assert.ok(AUTH_LIMITS['/get-started/code/send'] && AUTH_LIMITS['/get-started/code/verify']);
  });
});

import { plainTextOf } from '../report/email.js';
describe('plain text twin of an email', () => {
  test('keeps the words, the code and the link, and drops the markup', () => {
    const t = plainTextOf('<style>a{}</style><p>Hi <b>you</b></p><div style="x">123456</div><a href="https://app.superrank.si/x?a=1&amp;b=2">Sign in</a>');
    assert.match(t, /Hi you/);
    assert.match(t, /123456/);
    assert.match(t, /Sign in \(https:\/\/app\.superrank\.si\/x\?a=1&b=2\)/);
    assert.ok(!/[<>]/.test(t));
  });
});

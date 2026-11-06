import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { surgeStatus, effectiveSiteLimit, SURGE_DAYS } from './surge-mode.js';
import { laneBudgets, HARD_CEILING, DEFAULT_SITE_LIMIT, SURGE_SITE_LIMIT, ANALYST_MAX } from './autonomous-quota.js';

const DAY = 24 * 60 * 60 * 1000;
const created = new Date('2026-12-01T09:00:00Z');
const until = new Date(created.getTime() + 30 * DAY);
const at = (d) => new Date(created.getTime() + d * DAY);

describe('activation and expiry', () => {
  test('a new project is active from creation, day 1', () => {
    const s = surgeStatus(until, created);
    assert.deepEqual([s.active, s.day, s.activatedAt, s.expiresAt], [true, 1, created.toISOString(), until.toISOString()]);
  });
  test('still active on day 30, gone on day 31 with no manual step', () => {
    assert.equal(surgeStatus(until, at(29.9)).active, true);
    assert.equal(surgeStatus(until, at(29.9)).day, 30);
    const off = surgeStatus(until, at(30));
    assert.equal(off.active, false);
    assert.equal(off.reason, 'expired');
  });
  test('NULL (every existing project) is off', () => {
    assert.equal(surgeStatus(null).active, false);
    assert.equal(surgeStatus(undefined).reason, 'not-enabled');
  });
  test('an unreadable value is off, never a crash', () => {
    assert.equal(surgeStatus('garbage').active, false);
  });
  test('setting a future date by hand enables an existing project', () => {
    assert.equal(surgeStatus(new Date(Date.now() + 5 * DAY)).active, true);
  });
  test('the window is exactly SURGE_DAYS', () => assert.equal(SURGE_DAYS, 30));
});

describe('the limit during surge', () => {
  const on = { active: true }; const off = { active: false };
  test('the default 60 rises to 100 while active, and not otherwise', () => {
    assert.equal(effectiveSiteLimit(60, on), 100);
    assert.equal(effectiveSiteLimit(60, off), 60);
    assert.equal(effectiveSiteLimit(60, null), 60);
  });
  test('an explicit lower limit is respected, including 0 (paused)', () => {
    assert.equal(effectiveSiteLimit(30, on), 30);
    assert.equal(effectiveSiteLimit(0, on), 0);
  });
  test('surge never lowers a limit', () => assert.equal(effectiveSiteLimit(100, on), 100));
  test('null stays null', () => assert.equal(effectiveSiteLimit(null, on), null));
});

describe('capacity through laneBudgets (the real function)', () => {
  const day = (o) => laneBudgets({ siteLimitOverride: effectiveSiteLimit(60, { active: o.surge }), ...o });
  test('normal day: total 60, analyst lane reserved inside it', () => {
    const b = day({ surge: false, analyticsCandidates: 500, analystCandidates: 30 });
    assert.equal(b.dailyLimit, 60);
    assert.equal(b.analystBudget, ANALYST_MAX);
    assert.equal(b.analyticsBudget, 40);
  });
  test('surge day with a deep backlog: 100 total, analyst 20 + analytics 80, never 120', () => {
    const b = day({ surge: true, analyticsCandidates: 500, analystCandidates: 30 });
    assert.deepEqual([b.analystBudget, b.analyticsBudget, b.dailyLimit, b.ceiling], [20, 80, 100, 100]);
  });
  test('backlog-driven: 12 eligible ships 12, nothing is padded', () => {
    const b = day({ surge: true, analyticsCandidates: 12, analystCandidates: 0 });
    assert.equal(b.dailyLimit, 12);
  });
  test('95 eligible ships 95', () => assert.equal(day({ surge: true, analyticsCandidates: 95, analystCandidates: 0 }).dailyLimit, 95));
  test('the hard ceiling is not raised', () => {
    assert.equal(HARD_CEILING, 100);
    assert.equal(SURGE_SITE_LIMIT, HARD_CEILING);
    assert.equal(DEFAULT_SITE_LIMIT, 60);
    assert.equal(laneBudgets({ siteLimitOverride: 500, analyticsCandidates: 900, analystCandidates: 900 }).dailyLimit, 100);
  });
  test('spent today is measured against the ceiling, so 70 spent leaves 30', () => {
    const b = day({ surge: true, analyticsCandidates: 200, analystCandidates: 0, spentToday: 70 });
    assert.equal(b.remaining, 30);
  });
  test('the platform-wide remainder still binds', () => {
    assert.equal(day({ surge: true, analyticsCandidates: 200, analystCandidates: 0, globalRemaining: 7 }).remaining, 7);
  });
  test('a paused site (0) stays paused in surge', () => {
    assert.equal(laneBudgets({ siteLimitOverride: effectiveSiteLimit(0, { active: true }), analyticsCandidates: 50, analystCandidates: 5 }).dailyLimit, 0);
  });
});

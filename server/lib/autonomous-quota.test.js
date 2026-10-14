import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { laneBudgets, HARD_CEILING, NORMAL_TARGET, ANALYTICS_TARGET, ANALYST_MAX, AUTONOMOUS_DRAFT_SOURCES } from './autonomous-quota.js';

describe('autonomous-quota', () => {
  test('the documented numbers are the actual numbers', () => {
    assert.equal(ANALYTICS_TARGET, 60);
    assert.equal(ANALYST_MAX, 20);
    assert.equal(NORMAL_TARGET, 80);
    assert.equal(HARD_CEILING, 100);
  });

  test('a normal day is 60 analytics + 20 analyst = 80', () => {
    const b = laneBudgets({ analyticsCandidates: 60, analystCandidates: 20 });
    assert.equal(b.analyticsBudget, 60);
    assert.equal(b.analystBudget, 20);
    assert.equal(b.dailyLimit, 80);
  });

  test('overflow: more eligible analytics work stretches the day past 80', () => {
    const b = laneBudgets({ analyticsCandidates: 500, analystCandidates: 20 });
    assert.equal(b.analystBudget, 20);
    assert.equal(b.analyticsBudget, 80, 'analytics stretches into overflow, but only up to ceiling - analyst');
    assert.equal(b.dailyLimit, 100);
  });

  test('never 100 analytics + 20 analyst', () => {
    const b = laneBudgets({ analyticsCandidates: 10_000, analystCandidates: 10_000 });
    assert.equal(b.dailyLimit, 100);
    assert.ok(b.analyticsBudget + b.analystBudget <= HARD_CEILING);
    assert.notEqual(b.analyticsBudget, 100);
  });

  test('analytics alone may reach the full 100 when the analyst lane is empty', () => {
    const b = laneBudgets({ analyticsCandidates: 500, analystCandidates: 0 });
    assert.equal(b.analystBudget, 0);
    assert.equal(b.analyticsBudget, 100);
  });

  test('the analyst lane is never padded beyond its real evidence', () => {
    const b = laneBudgets({ analyticsCandidates: 500, analystCandidates: 3 });
    assert.equal(b.analystBudget, 3);
    assert.equal(b.dailyLimit, 100);
  });

  test('a quiet day ships what exists, not the target', () => {
    const b = laneBudgets({ analyticsCandidates: 4, analystCandidates: 1 });
    assert.equal(b.dailyLimit, 5);
    assert.equal(b.remaining, 5);
  });

  test('work already shipped today by ANY autonomous source consumes the ceiling', () => {
    const b = laneBudgets({ analyticsCandidates: 500, analystCandidates: 20, spentToday: 95 });
    assert.equal(b.dailyLimit, 100);
    assert.equal(b.remaining, 5, 'a catch-up/retry/restart resumes the same day, it does not get a fresh one');
  });

  test('the ceiling can never be exceeded by a re-run after a full day', () => {
    const b = laneBudgets({ analyticsCandidates: 500, analystCandidates: 20, spentToday: 100 });
    assert.equal(b.remaining, 0);
  });

  test('spentToday beyond the ceiling never produces negative headroom', () => {
    const b = laneBudgets({ analyticsCandidates: 500, analystCandidates: 20, spentToday: 140 });
    assert.equal(b.remaining, 0);
  });

  test('a per-site override caps the whole day, both lanes together', () => {
    const b = laneBudgets({ analyticsCandidates: 500, analystCandidates: 20, siteLimitOverride: 10 });
    assert.equal(b.analystBudget, 10);
    assert.equal(b.analyticsBudget, 0);
    assert.equal(b.dailyLimit, 10);
  });

  test('a per-site override of 0 pauses the tenant entirely', () => {
    const b = laneBudgets({ analyticsCandidates: 500, analystCandidates: 20, siteLimitOverride: 0 });
    assert.equal(b.dailyLimit, 0);
    assert.equal(b.remaining, 0);
  });

  test('a per-site override can only tighten, never raise, the hard ceiling', () => {
    const b = laneBudgets({ analyticsCandidates: 500, analystCandidates: 20, siteLimitOverride: 400 });
    assert.equal(b.ceiling, HARD_CEILING);
    assert.equal(b.dailyLimit, 100);
  });

  test('the platform-wide remainder tightens the site day when it is smaller', () => {
    const b = laneBudgets({ analyticsCandidates: 500, analystCandidates: 20, globalRemaining: 7 });
    assert.equal(b.remaining, 7);
  });

  test('every autonomous shipping lane is counted against the ceiling', () => {
    for (const source of ['auto-remediation', 'analyst-keyword-gap', 'learned-repair', 'content-repair', 'template-capability-repair']) {
      assert.ok(AUTONOMOUS_DRAFT_SOURCES.includes(source), `${source} must draw from the shared ceiling`);
    }
    assert.ok(!AUTONOMOUS_DRAFT_SOURCES.includes('code-self-repair'), 'code-self-repair repairs the platform itself — the documented exception');
  });
});

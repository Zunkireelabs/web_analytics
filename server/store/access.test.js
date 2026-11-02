import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveState, isLocked, daysLeft, planApproval, isAllowedWhileLocked, summarizeOnboarding, describeAccess, DEMO_DAYS } from './access.js';

const NOW = new Date('2026-11-02T10:00:00Z');
const day = (n) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

describe('effectiveState', () => {
  test('a project nobody changed is a client', () => {
    assert.equal(effectiveState({ access_state: 'client' }, NOW), 'client');
    assert.equal(effectiveState({}, NOW), 'client');
    assert.equal(effectiveState({ access_state: 'something-new' }, NOW), 'client');
  });
  test('a demo is ended the moment its time runs out, even if nothing has recorded it yet', () => {
    assert.equal(effectiveState({ access_state: 'demo', access_ends_at: day(3) }, NOW), 'demo');
    assert.equal(effectiveState({ access_state: 'demo', access_ends_at: NOW }, NOW), 'ended');
    assert.equal(effectiveState({ access_state: 'demo', access_ends_at: day(-1) }, NOW), 'ended');
  });
  test('only a demo expires', () => {
    assert.equal(effectiveState({ access_state: 'client', access_ends_at: day(-5) }, NOW), 'client');
    assert.equal(effectiveState({ access_state: 'pending', access_ends_at: day(-5) }, NOW), 'pending');
  });
});

describe('isLocked', () => {
  test('pending, ended and rejected are locked; demo and client are not', () => {
    for (const s of ['pending', 'ended', 'rejected']) assert.equal(isLocked(s), true, s);
    for (const s of ['demo', 'client']) assert.equal(isLocked(s), false, s);
  });
});

describe('daysLeft', () => {
  test('counts whole days up, so the last day still reads 1', () => {
    assert.equal(daysLeft({ access_state: 'demo', access_ends_at: day(9) }, NOW), 9);
    assert.equal(daysLeft({ access_state: 'demo', access_ends_at: new Date(NOW.getTime() + 3 * 60 * 60 * 1000) }, NOW), 1);
  });
  test('is null for anything that is not a running demo', () => {
    assert.equal(daysLeft({ access_state: 'client' }, NOW), null);
    assert.equal(daysLeft({ access_state: 'demo', access_ends_at: day(-1) }, NOW), null);
  });
});

describe('planApproval', () => {
  test('a demo is 15 days from now, and a client has no end', () => {
    assert.equal(DEMO_DAYS, 15);
    const demo = planApproval({ type: 'demo', githubOptional: true }, NOW);
    assert.equal(demo.state, 'demo');
    assert.equal(demo.endsAt.getTime(), day(15).getTime());
    assert.equal(demo.githubOptional, true);
    const client = planApproval({ type: 'client', githubOptional: true }, NOW);
    assert.deepEqual({ ...client }, { state: 'client', endsAt: null, githubOptional: false });
  });
  test('nothing else is a way to approve', () => {
    assert.equal(planApproval({ type: 'forever' }, NOW), null);
    assert.equal(planApproval({}, NOW), null);
  });
});

describe('isAllowedWhileLocked', () => {
  test('a locked project can still reach what it needs to ask, read its Overview and leave', () => {
    const ok = [
      ['GET', '/api/me'], ['GET', '/api/access'], ['GET', '/api/onboarding/summary'], ['POST', '/api/onboarding/complete'], ['POST', '/api/access/request'], ['POST', '/api/logout'],
      ['GET', '/api/workspaces'], ['POST', '/api/workspaces/switch'], ['GET', '/api/projects/12'],
      ['GET', '/api/range?site=12'], ['GET', '/api/series?site=12&start=2026-10-01&end=2026-10-31'], ['GET', '/api/channels?site=12'],
      ['GET', '/api/breakdown-range?site=12&dim=query'], ['GET', '/api/baseline-report'], ['GET', '/api/baseline-report/download'],
    ];
    for (const [method, path] of ok) assert.equal(isAllowedWhileLocked({ method, path }), true, `${method} ${path}`);
  });
  test('everything else is refused: other pages, and every change', () => {
    const no = [
      ['GET', '/api/keywords'], ['GET', '/api/ai-visibility'], ['GET', '/api/analyst/dashboard'], ['GET', '/api/action-center/content-picks'],
      ['POST', '/api/keywords'], ['POST', '/api/projects/12/connect/google'], ['POST', '/api/projects/12/connect/github'],
      ['DELETE', '/api/projects/12'], ['POST', '/api/mcp-tokens'], ['GET', '/api/mcp-tokens'], ['POST', '/api/workspaces'],
      ['GET', '/api/internal/access'], ['POST', '/api/projects/12'], ['POST', '/api/onboarding/summary'], ['POST', '/api/onboarding/site'],
    ];
    for (const [method, path] of no) assert.equal(isAllowedWhileLocked({ method, path }), false, `${method} ${path}`);
  });
  test('does not let a look-alike path through', () => {
    assert.equal(isAllowedWhileLocked({ method: 'GET', path: '/api/accessories' }), false);
    assert.equal(isAllowedWhileLocked({ method: 'GET', path: '/api/rangefinder' }), false);
    assert.equal(isAllowedWhileLocked({ method: 'GET', path: '/api/me/tokens' }), false);
  });
});

describe('describeAccess', () => {
  test('says what the screens need', () => {
    const d = describeAccess({ access_state: 'demo', access_ends_at: day(9), access_requested_at: day(-2), access_github_optional: true }, NOW);
    assert.deepEqual({ ...d, endsAt: undefined, requestedAt: undefined }, { state: 'demo', locked: false, requested: true, requestedAt: undefined, endsAt: undefined, daysLeft: 9, githubOptional: true, source: null, endedAt: null });
    assert.equal(describeAccess({ access_state: 'pending' }, NOW).locked, true);
    assert.equal(describeAccess({ access_state: 'pending' }, NOW).requested, false);
    assert.equal(describeAccess(null, NOW), null);
  });
});

describe('summarizeOnboarding', () => {
  test('keeps what staff need to judge a request, capped', () => {
    const s = summarizeOnboarding({
      brand: 'Zunkireelabs', goals: ['geo', 'aeo'], markets: { items: ['Africa', 'Brazil'] }, topics: ['a', 'b'], prompts: [{}, {}, {}],
      profile: { category: 'AI agent development', competitors: ['Acme AI'] },
    });
    assert.deepEqual(s, { brand: 'Zunkireelabs', category: 'AI agent development', goals: ['geo', 'aeo'], markets: ['Africa', 'Brazil'], topics: ['a', 'b'], prompts: 3, competitors: ['Acme AI'] });
    assert.deepEqual(summarizeOnboarding(null), { brand: null, category: null, goals: [], markets: [], topics: [], prompts: 0, competitors: [] });
    assert.equal(summarizeOnboarding({ topics: Array.from({ length: 99 }, (_, i) => `t${i}`) }).topics.length, 20);
  });
});

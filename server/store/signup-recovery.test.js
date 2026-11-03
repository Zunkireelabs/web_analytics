import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// The rules behind sign-up recovery: who is due a reminder, which "welcome back" a returning person sees, when the app sign-in
// sends a code, and that a resume link is single use and only its hash is stored. No database: the query function is a stub.
let calls; let reply;
mock.module(resolve('../db.js'), { namedExports: { query: async (sql, params) => { calls.push({ sql, params }); return reply(sql, params); } } });
process.env.SESSION_SECRET = 'test-secret';
process.env.SITE_BASE_URL = 'https://site.test';
const m = await import('./signup-recovery.js');

beforeEach(() => { calls = []; reply = () => ({ rows: [], rowCount: 0 }); });

const NOW = new Date('2026-11-10T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000);
const S = m.DEFAULT_SETTINGS;
const draftOf = (over = {}) => ({ step: 'goals', data: { state: { brand: 'Lumen' } }, updatedAt: daysAgo(8), reminderCount: 0, remindersMuted: false, reminderSentAt: null, ...over });

describe('isReminderDue', () => {
  const base = { settings: S, draft: draftOf(), verified: true, hasProject: false, now: NOW };
  test('due once the wait has passed and the answers are still kept', () => assert.equal(m.isReminderDue(base), true));
  test('not before the wait', () => assert.equal(m.isReminderDue({ ...base, draft: draftOf({ updatedAt: daysAgo(6) }) }), false));
  test('not after the answers would be deleted', () => assert.equal(m.isReminderDue({ ...base, draft: draftOf({ updatedAt: daysAgo(31) }) }), false));
  test('only one reminder per person', () => assert.equal(m.isReminderDue({ ...base, draft: draftOf({ reminderCount: 1 }) }), false));
  test('never when muted, with a project, or a client', () => {
    assert.equal(m.isReminderDue({ ...base, draft: draftOf({ remindersMuted: true }) }), false);
    assert.equal(m.isReminderDue({ ...base, hasProject: true }), false);
    assert.equal(m.isReminderDue({ ...base, isClient: true }), false);
  });
  test('confirmed addresses only, when staff say so', () => {
    assert.equal(m.isReminderDue({ ...base, verified: false }), false);
    assert.equal(m.isReminderDue({ ...base, verified: false, settings: { ...S, confirmedOnly: false } }), true);
  });
  test('off means off, and an emptied draft has nothing to come back to', () => {
    assert.equal(m.isReminderDue({ ...base, settings: { ...S, enabled: false } }), false);
    assert.equal(m.isReminderDue({ ...base, draft: draftOf({ data: {} }) }), false);
  });
});

describe('reminderState (staff table)', () => {
  const st = (over) => m.reminderState({ status: 'unfinished', settings: S, draft: draftOf(), verified: true, now: NOW, ...over });
  test('scheduled, then due', () => {
    assert.equal(st({ draft: draftOf({ updatedAt: daysAgo(2) }) }).state, 'scheduled');
    assert.equal(st({}).state, 'due');
    assert.equal(st({ draft: draftOf({ updatedAt: daysAgo(2) }) }).dueAt.toISOString(), daysAgo(-5).toISOString());
  });
  test('sent, expired, back', () => {
    const sent = draftOf({ reminderCount: 1, reminderSentAt: daysAgo(1), updatedAt: daysAgo(9) });
    assert.equal(st({ draft: sent, link: { expiresAt: daysAgo(-1) } }).state, 'sent');
    assert.equal(st({ draft: sent, link: { expiresAt: daysAgo(0.5) } }).state, 'expired');
    assert.equal(st({ draft: sent, link: { expiresAt: daysAgo(-1), usedAt: daysAgo(0.2) } }).state, 'back');
    assert.equal(st({ draft: { ...sent, updatedAt: daysAgo(0.5) }, link: { expiresAt: daysAgo(-1) } }).state, 'back');
    assert.equal(st({ draft: sent, status: 'waiting' }).state, 'back');
  });
  test('muted and client win', () => {
    assert.equal(st({ draft: draftOf({ remindersMuted: true }) }).state, 'muted');
    assert.equal(st({ status: 'client' }).state, 'client');
  });
  test('nothing to remind: unconfirmed, no answers, or off', () => {
    assert.equal(st({ status: 'unconfirmed', draft: null, verified: false }).state, 'none');
    assert.equal(st({ draft: null }).state, 'none');
    assert.equal(st({ settings: { ...S, enabled: false } }).state, 'none');
  });
});

describe('returningBucket', () => {
  const b = (draft, extra = {}) => m.returningBucket({ draft, keepDays: 30, now: NOW, ...extra });
  test('recent up to 9 days, late from 10 to the keep time', () => {
    assert.equal(b(draftOf({ updatedAt: daysAgo(9) })).bucket, 'recent');
    assert.equal(b(draftOf({ updatedAt: daysAgo(10) })).bucket, 'late');
    assert.equal(b(draftOf({ updatedAt: daysAgo(30) })).bucket, 'late');
    assert.equal(b(draftOf({ updatedAt: daysAgo(10) })).daysAway, 10);
  });
  test('fresh when the answers are gone and they signed up before, more than the keep time ago', () => {
    assert.equal(b(null, { signedUpAt: daysAgo(45) }).bucket, 'fresh');
    assert.equal(b(null, { signedUpAt: daysAgo(12) }), null);
    assert.equal(b(null), null);
  });
  test('a draft that outlived the keep time counts as gone', () => {
    const r = b(draftOf({ updatedAt: daysAgo(40) }));
    assert.equal(r.bucket, 'fresh');
    assert.equal(r.staleDraft, true);
  });
  test('an emptied draft (unsubscribed) is not an answer', () => assert.equal(b(draftOf({ data: {} })), null));
});

describe('decideCodeGate (app sign-in)', () => {
  const g = (o) => m.decideCodeGate(o);
  test('no project: setup not finished only if they started one', () => {
    assert.equal(g({ states: [], started: true }).code, 'SETUP_NOT_FINISHED');
    assert.equal(g({ states: [], started: false }), null);
  });
  test('a project waiting for approval', () => assert.equal(g({ states: ['pending'] }).code, 'REQUEST_PENDING'));
  test('every project ended', () => assert.equal(g({ states: ['ended', 'ended'] }).code, 'TRIAL_ENDED'));
  test('a running demo or a client project gets the code, whatever else they have', () => {
    assert.equal(g({ states: ['demo'] }), null);
    assert.equal(g({ states: ['ended', 'client'] }), null);
    assert.equal(g({ states: ['pending', 'demo'] }), null);
  });
  test('staff are never held back; turned-down projects keep the old behaviour', () => {
    assert.equal(g({ states: [], started: true, isStaff: true }), null);
    assert.equal(g({ states: ['rejected'] }), null);
  });
  test('the messages are short and plain', () => {
    for (const msg of Object.values(m.GATE_MESSAGES)) assert.ok(msg.length < 110 && !/[<>]/.test(msg));
  });
});

describe('settings', () => {
  test('keeps what was not sent, rejects out-of-range values', () => {
    assert.deepEqual(m.validateSettings({ linkDays: 3 }, S).settings, { ...S, linkDays: 3 });
    assert.equal(m.validateSettings({ remindAfterDays: 0 }, S).ok, false);
    assert.equal(m.validateSettings({ linkDays: 61 }, S).ok, false);
    assert.equal(m.validateSettings({ linkDays: 1.5 }, S).ok, false);
    assert.equal(m.validateSettings({ enabled: 'yes' }, S).ok, false);
  });
  test('answers must be kept longer than the wait before the reminder', () => {
    assert.equal(m.validateSettings({ keepDays: 7 }, S).ok, false);
    assert.equal(m.validateSettings({ remindAfterDays: 10, keepDays: 20 }, S).ok, true);
  });
});

describe('steps and answers', () => {
  test('eleven steps, draft ids mapped', () => {
    assert.equal(m.FUNNEL_STEPS.length, 11);
    assert.equal(m.stepReached({ draftStep: 'goals', hasAnswers: true, verified: true }), 8);
    assert.equal(m.stepReached({ draftStep: 'wsname', hasAnswers: true, verified: true }), 11);
    assert.equal(m.stepReached({ verified: false }), 1);
    assert.equal(m.stepReached({ verified: true }), 2);
    assert.equal(m.stepReached({ verified: true, finished: true }), 11);
  });
  test('the answers summary tolerates a missing or odd draft', () => {
    const a = m.summarizeAnswers({ state: { website: 'a.test', brand: 'A', goals: ['seo'], goalsTouched: true, prompts: [1, 2], topics: ['x', 5], profile: { products: ['p'] } } });
    assert.equal(a.promptCount, 2);
    assert.deepEqual(a.goals, [{ key: 'seo', confirmed: true }]);
    assert.deepEqual(a.topics, ['x']);
    assert.equal(m.summarizeAnswers(null).promptCount, 0);
    assert.equal(m.summarizeAnswers({ state: 'oops' }).brand, null);
  });
});

describe('buildProgress', () => {
  const row = (o) => ({ email: 'a@x.test', via: 'email', user_id: 1, verified_at: daysAgo(9), created_at: daysAgo(9), last_active_at: daysAgo(8), states: null, d_updated_at: null, ...o });
  const out = m.buildProgress([
    row({ email: 'u@x.test', user_id: null, verified_at: null }),
    row({ email: 'v@x.test', user_id: 2 }),
    row({ email: 'd@x.test', user_id: 3, d_step: 'goals', d_data: { state: { brand: 'Lumen' } }, d_updated_at: daysAgo(8), reminder_count: 1, reminder_sent_at: daysAgo(1) }),
    row({ email: 'f@x.test', user_id: 4, states: ['pending'] }),
    row({ email: 'c@x.test', user_id: 5, states: ['client'] }),
  ], S, NOW);
  test('counts line', () => assert.deepEqual(out.counts, { started: 5, finished: 2, stopped: 3, reminded: 1, cameBack: 0 }));
  test('funnel is cumulative and has 11 named steps', () => {
    assert.equal(out.funnel.length, 11);
    assert.deepEqual(out.funnel.slice(0, 3).map((f) => f.reached), [5, 4, 3]);
    assert.equal(out.funnel[7].reached, 3);
    assert.equal(out.funnel[10].name, 'Prompts');
  });
  test('rows carry status, step and reminder', () => {
    const d = out.rows.find((r) => r.email === 'd@x.test');
    assert.deepEqual([d.status, d.step, d.stepName, d.brand, d.reminder.state], ['unfinished', 8, 'Goals', 'Lumen', 'sent']);
    assert.equal(out.rows.find((r) => r.email === 'u@x.test').status, 'unconfirmed');
    assert.equal(out.rows.find((r) => r.email === 'c@x.test').reminder.state, 'client');
  });
});

describe('resume links', () => {
  const ago = (n) => new Date(Date.now() - n * 86400000); // the store checks expiry against the real clock
  test('stores only a hash, and the URL carries the token', async () => {
    const { token, url } = await m.createResumeLink(7, { days: 2 });
    assert.ok(token.length >= 40);
    assert.equal(url, `https://site.test/get-started?resume=${token}`);
    const insert = calls[0];
    assert.equal(insert.params.includes(token), false);
    assert.match(insert.params[0], /^[0-9a-f]{64}$/);
  });
  test('a good link signs the person in once', async () => {
    reply = (sql) => (/^SELECT/.test(sql) ? { rows: [{ id: 1, user_id: 7, expires_at: ago(-1), used_at: null }] } : { rowCount: 1, rows: [] });
    assert.deepEqual(await m.redeemResumeLink('x'.repeat(43)), { ok: true, userId: 7 });
  });
  test('used, unknown, expired and lost-the-race links are refused', async () => {
    const t = 'x'.repeat(43);
    reply = () => ({ rows: [{ id: 1, user_id: 7, expires_at: ago(-1), used_at: ago(0.1) }] });
    assert.deepEqual(await m.redeemResumeLink(t), { ok: false, reason: 'invalid' });
    reply = () => ({ rows: [] });
    assert.deepEqual(await m.redeemResumeLink(t), { ok: false, reason: 'invalid' });
    reply = () => ({ rows: [{ id: 1, user_id: 7, expires_at: ago(1), used_at: null }] });
    assert.deepEqual(await m.redeemResumeLink(t), { ok: false, reason: 'expired' });
    reply = (sql) => (/^SELECT/.test(sql) ? { rows: [{ id: 1, user_id: 7, expires_at: ago(-1), used_at: null }] } : { rowCount: 0, rows: [] });
    assert.deepEqual(await m.redeemResumeLink(t), { ok: false, reason: 'invalid' });
    assert.deepEqual(await m.redeemResumeLink(undefined), { ok: false, reason: 'invalid' });
  });
  test('the unsubscribe token only works for the person it was made for', () => {
    const t = m.unsubscribeToken(42);
    assert.equal(m.readUnsubscribeToken(t), 42);
    assert.equal(m.readUnsubscribeToken(t.replace(/^42/, '43')), null);
    assert.equal(m.readUnsubscribeToken('42.nope'), null);
    assert.equal(m.readUnsubscribeToken(''), null);
  });
});

describe('ended-demo purge', () => {
  test('is off unless the env says true', () => {
    assert.equal(m.purgeEndedEnabled({}), false);
    assert.equal(m.purgeEndedEnabled({ SIGNUP_PURGE_ENDED_ENABLED: 'false' }), false);
    assert.equal(m.purgeEndedEnabled({ SIGNUP_PURGE_ENDED_ENABLED: 'true' }), true);
  });
  test('a dry run only selects ended demos from /get-started, and deletes nothing', async () => {
    reply = (sql) => (/FROM sites/.test(sql) ? { rows: [{ id: 9, name: 'Old', workspace_id: 3 }] } : { rows: [{ purge_day: 30 }] });
    const out = await m.purgeEndedDemos({ apply: false, now: NOW });
    assert.deepEqual([out.dryRun, out.due, out.deleted], [true, [9], []]);
    const select = calls.find((c) => /FROM sites/.test(c.sql)).sql;
    assert.match(select, /access_state = 'ended'/);
    assert.equal(calls.some((c) => /^\s*(DELETE|UPDATE)/i.test(c.sql)), false);
  });
});

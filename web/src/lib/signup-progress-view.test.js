import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { STEP_COUNT, funnelBars, summaryCounts, filterCounts, filterRows, defaultFilter, canRemind, whyNot, bulkRemindNote, reached, gotLine, lastActive, dueWording, reminderStatus, summaryLine, stepList, actions } from './signup-progress-view.js';

const NOW = new Date('2026-11-03T12:00:00Z').getTime();
const days = (n) => new Date(NOW + n * 24 * 3600 * 1000).toISOString();

const row = (over = {}) => ({
  userId: 1, email: 'priya@lumenhomes.co', brand: 'Lumen Homes', website: 'lumenhomes.co', verified: true, step: 8, stepName: 'Goals',
  startedAt: days(-6), lastActiveAt: days(-6), status: 'unfinished', reminder: { state: 'none' },
  answers: { website: 'lumenhomes.co', brand: 'Lumen Homes', entityCountry: 'United Kingdom', run: { country: 'United Kingdom', language: 'English', city: 'London' },
    profile: { products: ['Smart lighting', 'Sensors'], personas: ['Homeowners'], competitors: ['Hue', 'LIFX'] }, goals: [{ key: 'show_up_in_ai', confirmed: false }], markets: [], topics: [], promptCount: 0 },
  ...over,
});

describe('funnelBars', () => {
  test('scales to the tallest bar and marks the biggest drop', () => {
    const bars = funnelBars([{ step: 1, name: 'Email', reached: 100 }, { step: 2, name: 'Code', reached: 90 }, { step: 3, name: 'Website', reached: 50 }], 60);
    assert.deepEqual(bars.map((b) => b.px), [60, 54, 30]);
    assert.deepEqual(bars.map((b) => b.hot), [false, false, true]);
  });
  test('an empty funnel still has a minimum height and no hot bar', () => {
    const bars = funnelBars([{ step: 1, name: 'Email', reached: 0 }]);
    assert.equal(bars[0].px, 6);
    assert.equal(bars[0].hot, false);
  });
});

describe('summaryCounts', () => {
  const rows = [
    row({ userId: 1, reminder: { state: 'due' } }),
    row({ userId: 2, reminder: { state: 'due' }, status: 'unconfirmed', verified: false }),
    row({ userId: 3, status: 'client', reminder: { state: 'client' } }),
  ];
  test('takes the window counts from the server and the rest from the rows', () => {
    assert.deepEqual(summaryCounts({ counts: { started: 64, reminded: 18, cameBack: 7 }, rows }), { started: 64, due: 1, reminded: 18, unconfirmed: 1, cameBack: 7 });
  });
  test('copes with no data', () => assert.equal(summaryCounts(null).started, 0));
});

describe('filters', () => {
  const rows = [
    row({ userId: 1, reminder: { state: 'due' }, lastActiveAt: days(-20) }),
    row({ userId: 2, email: 'a@b.co', brand: 'Orbit', website: 'orbit.com', status: 'client', reminder: { state: 'client' }, step: 11 }),
    row({ userId: null, email: 'c@d.co', brand: '', website: '', status: 'unconfirmed', verified: false, step: 2, lastActiveAt: days(-2) }),
    row({ userId: 4, email: 'e@f.co', step: 3, reminder: { state: 'scheduled', dueAt: days(2) }, lastActiveAt: days(-9) }),
    row({ userId: 5, email: 'g@h.co', step: 9, reminder: { state: 'sent', sentAt: days(-3) }, lastActiveAt: days(-12) }),
    row({ userId: 6, email: 'i@j.co', step: 4, reminder: { state: 'back' }, lastActiveAt: days(-1) }),
  ];
  test('counts every pill, with All including finished people', () => {
    assert.deepEqual(filterCounts(rows), { due: 1, scheduled: 1, reminded: 2, goals: 2, unconfirmed: 1, all: 6 });
  });
  test('each pill shows its own people', () => {
    const ids = (f) => filterRows(rows, f).map((r) => r.userId);
    assert.deepEqual(ids('due'), [1]);
    assert.deepEqual(ids('scheduled'), [4]);
    assert.deepEqual(ids('reminded').sort(), [5, 6]);
    assert.deepEqual(ids('goals').sort(), [1, 5]);
    assert.deepEqual(ids('unconfirmed'), [null]);
  });
  test('searches email, brand and website', () => {
    assert.equal(filterRows(rows, 'all', 'ORBIT').length, 1);
    assert.equal(filterRows(rows, 'all', 'lumenhomes').length, 4);
  });
  test('sorts longest quiet first, newest first, or furthest along', () => {
    assert.deepEqual(filterRows(rows, 'all', '', 'quiet').map((r) => r.userId).slice(0, 2), [1, 5]);
    assert.equal(filterRows(rows, 'all', '', 'recent')[0].userId, 6);
    assert.equal(filterRows(rows, 'all', '', 'furthest')[0].userId, 2);
  });
  test('opens on Reminder due when there is one, else All', () => {
    assert.equal(defaultFilter(rows), 'due');
    assert.equal(defaultFilter(rows.slice(1)), 'all');
  });
});

describe('who can be reminded', () => {
  test('only confirmed people still in progress, not muted, not clients', () => {
    assert.equal(canRemind(row()), true);
    assert.equal(canRemind(row({ status: 'unconfirmed', userId: null })), false);
    assert.equal(canRemind(row({ reminder: { state: 'muted' } })), false);
    assert.equal(canRemind(row({ status: 'client', reminder: { state: 'client' } })), false);
    assert.equal(whyNot(row({ status: 'client' })), 'already a client');
    assert.equal(whyNot(row({ status: 'unconfirmed' })), 'email not confirmed');
    assert.equal(whyNot(row({ reminder: { state: 'muted' } })), 'reminders stopped');
  });
  test('the result note says what was sent, what failed and what was skipped', () => {
    assert.equal(bulkRemindNote({ sent: 4, failed: [{ email: 'a@b.co', reason: 'mailbox full' }] }), '4 reminders sent, 1 could not be sent: a@b.co (mailbox full)');
    assert.equal(bulkRemindNote({ sent: 1, skipped: [{ email: 'c@d.co', reason: 'reminders stopped' }] }), '1 reminder sent, 1 skipped: c@d.co (reminders stopped)');
    assert.equal(bulkRemindNote({ failed: [{ email: 'a@b.co' }] }), '1 could not be sent: a@b.co');
  });
});

describe('reached', () => {
  test('lights one dot per step reached', () => {
    const r = reached(row());
    assert.equal(r.of, `8/${STEP_COUNT}`);
    assert.equal(r.dots.filter(Boolean).length, 8);
  });
});

describe('gotLine', () => {
  test('keeps to three short parts', () => assert.equal(gotLine(row().answers), 'United Kingdom · Smart lighting +1 · 2 competitors'));
  test('falls back to the brand, or nothing', () => {
    assert.equal(gotLine({ brand: 'Field Notes' }), 'Field Notes');
    assert.equal(gotLine({}), '');
  });
});

describe('lastActive and dueWording', () => {
  test('whole days', () => {
    assert.equal(lastActive(days(-6), NOW), '6 days ago');
    assert.equal(lastActive(days(-1), NOW), '1 day ago');
    assert.equal(lastActive(days(0), NOW), 'Today');
  });
  test('today, tomorrow, later', () => {
    assert.equal(dueWording(days(-1), NOW), 'Sends today');
    assert.equal(dueWording(days(0.5), NOW), 'Sends tomorrow');
    assert.equal(dueWording(days(1), NOW), 'Sends tomorrow');
    assert.equal(dueWording(days(5), NOW), 'In 5 days');
  });
});

describe('reminderStatus', () => {
  const st = (reminder, status = 'unfinished') => reminderStatus(row({ reminder, status }), NOW);
  test('due and scheduled', () => {
    assert.deepEqual(st({ state: 'due', dueAt: days(1) }), { tone: 'due', text: 'Sends tomorrow' });
    assert.deepEqual(st({ state: 'scheduled', dueAt: days(5) }), { tone: 'soon', text: 'In 5 days' });
  });
  test('sent shows whether the link is still open', () => {
    assert.match(st({ state: 'sent', sentAt: days(-1), linkExpiresAt: days(1) }).text, /link open$/);
    assert.match(st({ state: 'sent', sentAt: days(-3), linkExpiresAt: days(-1) }).text, /link expired$/);
  });
  test('the rest', () => {
    assert.equal(st({ state: 'back' }).text, 'Came back');
    assert.equal(st({ state: 'muted' }).text, 'Reminders stopped');
    assert.equal(st({ state: 'client' }, 'client').text, 'No reminders');
    assert.equal(st({ state: 'none' }, 'unconfirmed').text, 'Email not confirmed');
  });
});

describe('summaryLine', () => {
  test('a due reminder says when and how long the link works', () => {
    assert.match(summaryLine(row({ reminder: { state: 'due', dueAt: days(1) } }), 2, NOW), /The reminder goes out tomorrow and its link works for 2 days\.$/);
    assert.match(summaryLine(row({ reminder: { state: 'scheduled', dueAt: days(5) } }), 1, NOW), /goes out in 5 days and its link works for 1 day\.$/);
  });
});

describe('stepList', () => {
  test('marks done, current and not reached', () => {
    const s = stepList(row());
    assert.equal(s.length, STEP_COUNT);
    assert.deepEqual([s[0].state, s[7].state, s[8].state], ['done', 'now', 'todo']);
    assert.equal(s[7].label, 'Goals · stopped here');
    assert.deepEqual(s[7].chips, [{ text: 'Show up in ai', draft: true }]);
    assert.equal(s[7].text, 'Picked but not confirmed');
    assert.equal(s[5].text, 'United Kingdom · English · London');
    assert.equal(s[6].text, 'Competitors: Hue, LIFX');
    assert.equal(s[8].text, '');
  });
  test('a finished sign-up has every step done', () => {
    assert.ok(stepList(row({ status: 'trial' })).every((s) => s.state === 'done'));
  });
});

describe('actions', () => {
  test('only unfinished people can be reminded; a muted one can be switched back on', () => {
    assert.deepEqual(actions(row()), { canAct: true, muted: false });
    assert.deepEqual(actions(row({ reminder: { state: 'muted' } })), { canAct: true, muted: true });
    assert.equal(actions(row({ status: 'client' })).canAct, false);
  });
});

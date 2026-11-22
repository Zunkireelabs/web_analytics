import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildReminderEvent, runApprovalRemindersForAllSites } from './approval-reminders.js';
import { buildNeedsYou, OVERDUE_AFTER_DAYS } from '../assistant/needs-you.js';
import { eventKeyFor, COOLDOWN_DAYS } from '../notifications/alert-gate.js';

const day = 86_400_000;
const NOW = Date.UTC(2026, 10, 23, 10);
const ago = (d) => new Date(NOW - d * day).toISOString();

describe('overdue marking (computed from the record age, so answering it makes it disappear)', () => {
  const drafts = [
    { id: 1, action_type: 'blog-outline', status: 'draft', created_at: ago(4) },                       // content waiting 4 days
    { id: 2, action_type: 'faq', status: 'pr_opened', pr_number: 12, pr_base_branch: 'staging', created_at: ago(3) }, // Mobilise-style stage
    { id: 3, action_type: 'faq', status: 'pr_opened', pr_number: 13, pr_base_branch: 'staging', created_at: ago(0) }, // fresh
  ];
  const items = buildNeedsYou({ drafts, stageBranch: 'staging', now: NOW });
  test('items waiting 2+ days are overdue, say how long, and sort ahead of fresh ones', () => {
    assert.equal(OVERDUE_AFTER_DAYS, 2);
    const overdue = items.filter((i) => i.overdue);
    assert.deepEqual(overdue.map((i) => i.prNumber ?? i.scope).sort(), [12, 'content'].sort());
    assert.ok(overdue.every((i) => /waiting \d+ days?$/.test(i.title)));
    assert.equal(items.find((i) => i.prNumber === 13).overdue, undefined);
    assert.ok(items.indexOf(items.find((i) => i.prNumber === 13)) > items.indexOf(overdue[overdue.length - 1]));
  });
  test('once the person answers (record gone), nothing is overdue any more', () => {
    assert.equal(buildNeedsYou({ drafts: [], stageBranch: 'staging', now: NOW }).filter((i) => i.overdue).length, 0);
  });
});

describe('reminder event', () => {
  const items = [
    { overdue: true, ageDays: 6, title: 'Ready to merge to stage: pull request #12 (1 change) — waiting 6 days' },
    { overdue: true, ageDays: 3, title: '2 pieces of content are waiting for your approval — waiting 3 days' },
    { overdue: false, ageDays: 0, title: 'fresh' },
  ];
  test('lists only overdue items, strips the age suffix, is high severity at 5+ days, and says what to do', () => {
    const e = buildReminderEvent(8874, items);
    assert.equal(e.type, 'approval-reminder'); assert.equal(e.severity, 'high');
    assert.match(e.title, /2 items are waiting for your approval \(oldest: 6 days\)/);
    assert.doesNotMatch(e.body, /waiting 6 days/); assert.doesNotMatch(e.body, /fresh/);
    assert.match(e.body, /tell it to go ahead/);
  });
  test('nothing overdue -> no reminder at all', () => {
    assert.equal(buildReminderEvent(1, [{ overdue: false, ageDays: 1, title: 'x' }]), null);
    assert.equal(buildReminderEvent(1, []), null);
  });
  test('the identity is stable across days (so the 2-day cooldown applies) even though the wording changes', () => {
    const a = buildReminderEvent(5, items); const b = buildReminderEvent(5, items.map((i) => ({ ...i, ageDays: i.ageDays + 1 })));
    assert.equal(eventKeyFor(a), eventKeyFor(b)); assert.equal(eventKeyFor(a), 'insight:approvals:5');
    assert.notEqual(eventKeyFor(a), eventKeyFor(buildReminderEvent(6, items)));
    assert.equal(COOLDOWN_DAYS['approval-reminder'], 2);
  });
});

describe('runApprovalRemindersForAllSites', () => {
  test('reminds only sites with overdue items; one failing site never stops the others; it only delivers (never approves or merges)', async () => {
    const delivered = [];
    const t = await runApprovalRemindersForAllSites({
      query: async () => ({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
      collect: async (id) => { if (id === 2) throw new Error('boom'); return id === 1 ? [{ overdue: true, ageDays: 3, title: 'x' }] : []; },
      deliver: async (id, events) => { delivered.push([id, events.map((e) => e.type)]); },
    });
    assert.deepEqual(delivered, [[1, ['approval-reminder']]]);
    assert.deepEqual(t, { sites: 3, reminded: 1, failed: 1 });
  });
});

import { eventsForChannel } from '../notifications/channels/index.js';
import { IN_APP_ONLY_TYPES } from '../store/notifications.js';
describe('no email for reminders', () => {
  test('the reminder is addressed to the in-app bell only, and email gets nothing from a batch that only has it', () => {
    const e = buildReminderEvent(1, [{ overdue: true, ageDays: 3, title: 'x' }]);
    assert.deepEqual(e.channels, ['in-app']);
    assert.equal(eventsForChannel('email', [e]).length, 0);
    assert.equal(eventsForChannel('in-app', [e]).length, 1);
  });
  test('events that name no channel still go everywhere, and a mixed batch splits correctly', () => {
    const normal = { type: 'critical-issue', title: 'n' }; const rem = { type: 'approval-reminder', channels: ['in-app'] };
    assert.deepEqual(eventsForChannel('email', [normal, rem]), [normal]);
    assert.deepEqual(eventsForChannel('in-app', [normal, rem]), [normal, rem]);
  });
  test('a reminder in the bell never counts as "an email already went out today"', () => {
    assert.ok(IN_APP_ONLY_TYPES.includes('approval-reminder'));
  });
});

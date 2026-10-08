import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const resolve = (p) => fileURLToPath(new URL(p, import.meta.url));

let site;
let alreadyNotifiedToday;
let hasNotificationTodayCalls;
let emailDeliverCalls;
let inAppDeliverCalls;
let gateCalls;
let gateSuppressesAll;
let gateThrows;

beforeEach(() => {
  site = { id: 1, timezone: 'Asia/Kolkata' };
  alreadyNotifiedToday = false;
  hasNotificationTodayCalls = [];
  emailDeliverCalls = [];
  inAppDeliverCalls = [];
  gateCalls = [];
  gateSuppressesAll = false;
  gateThrows = false;
});

mock.module(resolve('../../store/read.js'), {
  namedExports: { getSiteById: async (id) => (id === site.id ? site : null) },
});
mock.module(resolve('../../store/notifications.js'), {
  namedExports: {
    hasNotificationToday: async (siteId, timezone) => {
      hasNotificationTodayCalls.push({ siteId, timezone });
      return alreadyNotifiedToday;
    },
  },
});
mock.module(resolve('./in-app.js'), {
  namedExports: {
    id: 'in-app',
    deliver: async (siteId, events, opts) => { inAppDeliverCalls.push({ siteId, events, opts }); },
  },
});
mock.module(resolve('./email.js'), {
  namedExports: {
    id: 'email',
    deliver: async (siteId, events, opts) => { emailDeliverCalls.push({ siteId, events, opts }); },
  },
});

// The gate's own rules are covered in ../alert-gate.test.js; here it is
// stubbed so these stay tests of the channel wiring.
mock.module(resolve('../alert-gate.js'), {
  namedExports: {
    gateEvents: async (siteId, events) => {
      gateCalls.push({ siteId, events });
      if (gateThrows) throw new Error('gate exploded');
      return gateSuppressesAll
        ? { deliver: [], suppressed: events.map((event) => ({ event, reason: 'test' })), enforcing: true }
        : { deliver: events, suppressed: [], enforcing: true };
    },
  },
});

const { deliverToAllChannels, collapseForInApp } = await import('./index.js');

describe('deliverToAllChannels — email-spam guard', () => {
  test('no events: nothing is checked or delivered', async () => {
    await deliverToAllChannels(1, []);
    assert.equal(hasNotificationTodayCalls.length, 0);
    assert.equal(emailDeliverCalls.length, 0);
    assert.equal(inAppDeliverCalls.length, 0);
  });

  test('first batch of the day: canEmail is decided once and passed to every channel, using the site\'s own timezone', async () => {
    alreadyNotifiedToday = false;
    const events = [{ type: 'critical-issue' }];
    await deliverToAllChannels(1, events);

    assert.equal(hasNotificationTodayCalls.length, 1, 'the guard must be checked exactly once per batch, not once per channel');
    assert.equal(hasNotificationTodayCalls[0].timezone, 'Asia/Kolkata');
    assert.equal(emailDeliverCalls.length, 1);
    assert.equal(emailDeliverCalls[0].opts.canEmail, true);
    assert.equal(inAppDeliverCalls.length, 1, 'in-app still runs regardless of the email guard');
    assert.equal(inAppDeliverCalls[0].opts.canEmail, true);
  });

  test('a second batch later the same day: email channel is told not to send, in-app still runs', async () => {
    alreadyNotifiedToday = true;
    const events = [{ type: 'opportunity' }];
    await deliverToAllChannels(1, events);

    assert.equal(emailDeliverCalls.length, 1);
    assert.equal(emailDeliverCalls[0].opts.canEmail, false);
    assert.equal(inAppDeliverCalls.length, 1);
  });

  test('the guard is decided BEFORE either channel runs, not raced against in-app\'s own write', async () => {
    // If the real bug (checking inside email.js concurrently with in-app's
    // write) came back, this test can't actually observe the race directly
    // through these mocks — what it locks in instead is the contract: the
    // decision is made by deliverToAllChannels itself and handed down as a
    // plain boolean, so email.deliver never needs to (and in the real
    // module, no longer does) query the notifications table itself.
    alreadyNotifiedToday = false;
    await deliverToAllChannels(1, [{ type: 'critical-issue' }]);
    assert.equal(hasNotificationTodayCalls.length, 1);
  });

  test('site lookup fails: fails open (canEmail stays true) rather than silently going mute', async () => {
    const events = [{ type: 'critical-issue' }];
    await deliverToAllChannels(999, events); // no site with this id in the mock
    assert.equal(emailDeliverCalls[0].opts.canEmail, true);
  });
});

describe('deliverToAllChannels — alert gate', () => {
  test('the gate runs before the email guard, so a suppressed batch does not spend the day\'s one email', async () => {
    gateSuppressesAll = true;
    await deliverToAllChannels(1, [{ type: 'critical-issue' }]);

    assert.equal(gateCalls.length, 1);
    assert.equal(hasNotificationTodayCalls.length, 0, 'the email guard must not even be consulted');
    assert.equal(emailDeliverCalls.length, 0);
    assert.equal(inAppDeliverCalls.length, 0);
  });

  test('only the surviving events reach the channels', async () => {
    await deliverToAllChannels(1, [{ type: 'critical-issue' }, { type: 'opportunity' }]);
    assert.deepEqual(emailDeliverCalls[0].events.map((e) => e.type), ['critical-issue', 'opportunity']);
  });

  test('a broken gate delivers ungated rather than silencing real alerts', async () => {
    gateThrows = true;
    await deliverToAllChannels(1, [{ type: 'critical-issue' }]);

    assert.equal(emailDeliverCalls.length, 1, 'fail open: a gate bug must not mute the system');
    assert.equal(inAppDeliverCalls.length, 1);
  });

  test('the gate is not consulted for an empty batch', async () => {
    await deliverToAllChannels(1, []);
    assert.equal(gateCalls.length, 0);
  });
});

describe('collapseForInApp', () => {
  const ev = (n, severity = 'medium') => ({ type: 'opportunity', severity, title: `t${n}`, findingIds: [`f${n}`] });

  test('a small batch is passed through untouched', () => {
    const events = [ev(1), ev(2), ev(3)];
    assert.equal(collapseForInApp(events), events);
  });

  test('a large batch keeps the cap and collapses the rest into one grouped row', () => {
    const out = collapseForInApp([ev(1), ev(2), ev(3), ev(4), ev(5)]);

    assert.equal(out.length, 4);
    assert.deepEqual(out.slice(0, 3).map((e) => e.title), ['t1', 't2', 't3']);
    assert.equal(out[3].type, 'critical-issues-group');
    assert.match(out[3].title, /2 more updates/);
  });

  test('no event is silently discarded — every collapsed finding id survives', () => {
    const out = collapseForInApp([ev(1), ev(2), ev(3), ev(4), ev(5)]);
    assert.deepEqual(out[3].findingIds, ['f4', 'f5']);
  });

  test('collapsing never downgrades a high-severity event into a medium summary', () => {
    const out = collapseForInApp([ev(1), ev(2), ev(3), ev(4), ev(5, 'high')]);
    assert.equal(out[3].severity, 'high');
  });

  test('singular wording for exactly one collapsed event', () => {
    const out = collapseForInApp([ev(1), ev(2), ev(3), ev(4)]);
    assert.match(out[3].title, /1 more update$/);
  });

  test('in-app gets the collapsed list while email gets the full one', async () => {
    await deliverToAllChannels(1, [ev(1), ev(2), ev(3), ev(4), ev(5)]);

    assert.equal(inAppDeliverCalls[0].events.length, 4, 'the bell is capped');
    assert.equal(emailDeliverCalls[0].events.length, 5, 'email has its own one-per-day guard already');
  });
});

import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const resolve = (p) => fileURLToPath(new URL(p, import.meta.url));

let site;
let alreadyNotifiedToday;
let hasNotificationTodayCalls;
let emailDeliverCalls;
let inAppDeliverCalls;

beforeEach(() => {
  site = { id: 1, timezone: 'Asia/Kolkata' };
  alreadyNotifiedToday = false;
  hasNotificationTodayCalls = [];
  emailDeliverCalls = [];
  inAppDeliverCalls = [];
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

const { deliverToAllChannels } = await import('./index.js');

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

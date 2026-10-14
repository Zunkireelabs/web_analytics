import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { headlineFor, summarizeFunnel, DEMO_STATUSES } from './product-funnel.js';
import { GOAL_TYPES } from './site-goals.js';

describe('headlineFor — conversion_event free text onto one real count', () => {
  const counts = { demosBooked: 4, trialSignups: 9, converted: 2 };
  test('demo events headline demos booked', () => {
    assert.deepEqual(headlineFor('booked_demo', counts), { label: 'Demos booked', value: 4 });
    assert.deepEqual(headlineFor('Demo Requested', counts), { label: 'Demos booked', value: 4 });
  });
  test('trial / signup events headline trial signups', () => {
    assert.equal(headlineFor('trial', counts).value, 9);
    assert.equal(headlineFor('signup', counts).value, 9);
  });
  test('purchase-style events headline converted customers', () => {
    assert.deepEqual(headlineFor('purchase', counts), { label: 'Converted customers', value: 2 });
  });
  test('an unset or unrecognised event yields no headline rather than an invented one', () => {
    assert.equal(headlineFor('', counts), null);
    assert.equal(headlineFor(undefined, counts), null);
    assert.equal(headlineFor('newsletter_opened', counts), null);
  });
});

describe('summarizeFunnel', () => {
  test('counts demo stages together but keeps trial and converted separate', () => {
    const f = summarizeFunnel({
      conversionEvent: 'booked_demo',
      prospectStatusCounts: { demo_booked: 3, demo_completed: 2, trial: 5, converted: 1, lost: 7 },
      signupCounts: { real: 6, competitor: 2 },
    });
    assert.equal(f.counts.demosBooked, 5);
    assert.equal(f.counts.converted, 1);
    assert.equal(f.counts.trialSignups, 6);
    assert.equal(f.counts.competitorSuspectSignups, 2);
    assert.deepEqual(f.headline, { label: 'Demos booked', value: 5 });
  });
  test('competitor-suspect signups never count toward the signup headline', () => {
    const f = summarizeFunnel({ conversionEvent: 'trial', prospectStatusCounts: {}, signupCounts: { real: 1, competitor: 40 } });
    assert.equal(f.headline.value, 1);
  });
  test('an empty product funnel is all zeros, not an error', () => {
    const f = summarizeFunnel({ conversionEvent: 'booked_demo' });
    assert.equal(f.counts.demosBooked, 0);
    assert.equal(f.counts.trialSignups, 0);
    assert.deepEqual(f.counts.prospectsByStatus, {});
  });
  test('demo statuses are exactly the two that mean a demo was booked or held', () => {
    assert.deepEqual([...DEMO_STATUSES], ['demo_booked', 'demo_completed']);
  });
});

describe('product goal types (migration 177)', () => {
  test('store accepts the three product goal types and keeps every original one', () => {
    for (const t of ['book_demos', 'grow_signups', 'activate_users']) assert.ok(GOAL_TYPES.includes(t), t);
    for (const t of ['generate_leads', 'grow_bookings', 'grow_sales', 'custom']) assert.ok(GOAL_TYPES.includes(t), t);
  });
});

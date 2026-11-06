import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDropOffs, describeDropOff, looksLikeSuccess, THRESHOLDS } from './visitor-behaviour.js';

// A drop-off is not a defect by itself — every site has a last step. These tests exist to keep this from ever becoming
// "flag the top row every week", which trains a client to ignore it.

const summary = (over = {}) => ({
  days: 28, measured_days: 28, sessions: 1000,
  topDropOffs: [
    { event: 'page: /pricing', sessions_ending_here: 300 },
    { event: 'signup_form_viewed', sessions_ending_here: 150 },
    { event: 'page: /about', sessions_ending_here: 40 },
  ],
  ...over,
});

describe('when there is not enough to say anything', () => {
  test('no PostHog data is a stated reason, not silence', () => {
    for (const s of [null, undefined, { days: 0 }]) {
      const out = analyzeDropOffs(s);
      assert.equal(out.status, 'insufficient-data');
      assert.equal(out.reason, 'no_posthog_data');
    }
  });

  test('a short history is told how many days it needs', () => {
    const out = analyzeDropOffs(summary({ measured_days: 6 }));
    assert.equal(out.reason, 'too_few_days');
    assert.equal(out.measuredDays, 6);
    assert.equal(out.needDays, THRESHOLDS.minMeasuredDays);
    assert.deepEqual(out.candidates, []);
  });

  test('days with data but no sessions produce nothing', () => {
    assert.equal(analyzeDropOffs(summary({ sessions: 0 })).reason, 'no_sessions');
  });
});

describe('which steps earn a recommendation', () => {
  test('a step ending a large share of visits is raised, biggest first', () => {
    const out = analyzeDropOffs(summary());
    assert.equal(out.status, 'ok');
    assert.deepEqual(out.candidates.map((c) => c.step), ['page: /pricing', 'signup_form_viewed']);
  });

  test('a step with too few visits is ignored however large its share', () => {
    const out = analyzeDropOffs(summary({ sessions: 100, topDropOffs: [{ event: 'page: /x', sessions_ending_here: 20 }] }));
    assert.deepEqual(out.candidates, [], '20 visits is under the floor even though it is 20%');
  });

  test('an ordinary small exit is ignored', () => {
    const out = analyzeDropOffs(summary({ topDropOffs: [{ event: 'page: /about', sessions_ending_here: 60 }] }));
    assert.deepEqual(out.candidates, [], '6% of visits is just a place people leave from');
  });

  test('priority follows the share', () => {
    const out = analyzeDropOffs(summary({ topDropOffs: [
      { event: 'a_step', sessions_ending_here: 300 }, { event: 'b_step', sessions_ending_here: 160 }, { event: 'c_step', sessions_ending_here: 110 },
    ] }));
    assert.deepEqual(out.candidates.map((c) => [c.step, c.priority]), [['a_step', 'high'], ['b_step', 'medium'], ['c_step', 'low']]);
  });

  test('the list is capped so it never becomes wallpaper', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ event: `step_${i}`, sessions_ending_here: 200 - i }));
    const out = analyzeDropOffs(summary({ sessions: 1200, topDropOffs: many }));
    assert.equal(out.candidates.length, THRESHOLDS.maxFindings);
  });

  test('how many steps were weighed is reported, so a quiet run can be explained', () => {
    assert.equal(analyzeDropOffs(summary()).considered, 3);
  });
});

describe('a visit ending in success is not a drop-off', () => {
  test('confirmation and completion pages are excluded', () => {
    for (const step of ['page: /thank-you', 'page: /order-confirmation', 'signup_completed', 'purchase_complete', 'booking_confirmed', 'form_submitted']) {
      assert.equal(looksLikeSuccess(step), true, step);
    }
  });

  test('an intermediate step that merely contains a success word is still a drop-off', () => {
    for (const step of ['checkout_started', 'booking_started', 'order_viewed', 'signup_form_viewed', 'purchase_clicked', 'page: /pricing']) {
      assert.equal(looksLikeSuccess(step), false, step);
    }
  });

  test("the client's own goal event is the strongest signal", () => {
    assert.equal(looksLikeSuccess('lead_generated', { conversionEvents: ['lead_generated'] }), true);
    assert.equal(looksLikeSuccess('Lead_Generated', { conversionEvents: ['lead_generated'] }), true);
    assert.equal(looksLikeSuccess('lead_generated'), false, 'with no declared goal the wording is all there is');
  });

  test('a success step is dropped from the candidates even when it is the biggest', () => {
    const out = analyzeDropOffs(summary({ topDropOffs: [
      { event: 'page: /thank-you', sessions_ending_here: 400 }, { event: 'page: /pricing', sessions_ending_here: 200 },
    ] }));
    assert.deepEqual(out.candidates.map((c) => c.step), ['page: /pricing']);
  });

  test('a declared goal event removes a step the wording would have kept', () => {
    const out = analyzeDropOffs(summary({ topDropOffs: [{ event: 'quote_requested', sessions_ending_here: 300 }] }), { conversionEvents: ['quote_requested'] });
    assert.deepEqual(out.candidates, []);
  });

  test('empty and junk step names are not success', () => {
    for (const step of ['', null, undefined, '   ']) assert.equal(looksLikeSuccess(step), false);
  });
});

describe('what the recommendation says', () => {
  const text = describeDropOff({ step: 'page: /pricing', visits: 300, share: 0.3 }, { totalSessions: 1000, days: 28 });

  test('it states the real numbers', () => {
    assert.match(text, /30% of visits over the last 28 days/);
    assert.match(text, /300 of 1,000/);
    assert.match(text, /the \/pricing page/);
  });

  test('it admits it cannot say why — no invented cause', () => {
    assert.match(text, /not why/);
    assert.match(text, /place to look rather than a confirmed fault/);
  });

  test('a custom event is named in the client\'s own words', () => {
    const t = describeDropOff({ step: 'signup_form_viewed', visits: 150, share: 0.15 }, { totalSessions: 1000, days: 28 });
    assert.match(t, /"signup form viewed" step/);
  });
});

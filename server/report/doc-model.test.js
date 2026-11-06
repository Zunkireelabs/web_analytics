import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { avgPosition, periodStats, deltaFor, positionDelta, tilesFor, headlineFor, bettermentTable, topSearchesSection, visitorBehaviourSections, humanStep, behaviourModel } from './doc-model.js';

const rows = [
  { clicks: 100, impressions: 1000, position: 10, users: 40, sessions: 50 },
  { clicks: 50, impressions: 3000, position: 6, users: 20, sessions: 25 },
];

test('average position is weighted by impressions, and null with none', () => {
  assert.equal(avgPosition(rows), (10 * 1000 + 6 * 3000) / 4000);
  assert.equal(avgPosition([{ position: 5, impressions: 0 }]), null);
});

test('deltas say what happened and never invent a comparison', () => {
  assert.deepEqual(deltaFor(120, 100, 'prior week'), { delta: '▲ 20% vs prior week', tone: 'good' });
  assert.deepEqual(deltaFor(80, 100, 'prior week'), { delta: '▼ 20% vs prior week', tone: 'bad' });
  assert.equal(deltaFor(5, 0, 'prior week').delta, 'no prior period to compare');
  assert.equal(deltaFor(5, null, 'prior week').tone, 'flat');
  assert.equal(positionDelta(8.6, 9.3, 'prior week').delta, '▲ 0.7 better');
  assert.equal(positionDelta(9.3, 8.6, 'prior week').tone, 'bad');
});

test('tiles are impressions, clicks, position and users; the headline follows the clicks', () => {
  const cur = periodStats(rows), prev = { ...cur, clicks: 100, impressions: 3000, users: 50, position: 7 };
  const tiles = tilesFor(cur, prev, 'prior week');
  assert.deepEqual(tiles.map((t) => t.label), ['Impressions', 'Clicks', 'Avg position', 'Users']);
  assert.equal(tiles[0].value, '4,000');
  assert.equal(headlineFor(cur, prev, 'this week', 'the prior week'), 'Clicks are up 50% on the prior week');
  assert.match(headlineFor({ ...cur, clicks: 50 }, prev, 'this week', 'the prior week'), /^A quieter week: clicks are down 50%/);
  assert.match(headlineFor(cur, null, 'this week', 'the prior week'), /^150 clicks and 4,000 impressions this week$/);
});

const baseline = { daysOfHistory: 30, clicks: 300, impressions: 3000, healthScore: 71 };
const cur = { clicks: 700, impressions: 7000, days: 7 };
const labels = { prev: 'Last week', cur: 'This week' };

test('since-baseline compares per day, like for like, with the health score when both exist', () => {
  const t = bettermentTable({ baseline, baselineAt: '2026-10-12', periodEnd: '2026-10-26', cur, prev: { clicks: 490, impressions: 4900, days: 7 }, currentHealth: 86, labels });
  assert.equal(t.table.head[4], 'Since baseline');
  const clicks = t.table.rows[0]; // baseline 10/day, now 100/day
  assert.deepEqual([clicks[0], clicks[1], clicks[2], clicks[3]], ['Clicks per day', '10.0', '70.0', '100.0'.replace('100.0', '100')]);
  assert.deepEqual(clicks[4], { t: '▲ +900%', tone: 'good' });
  assert.deepEqual(t.table.rows.at(-1), ['Health score', '71', '—', '86', { t: '▲ +15', tone: 'good' }]);
});

test('no honest comparison means no table', () => {
  const base = { baselineAt: '2026-10-12', periodEnd: '2026-10-26', cur, labels };
  assert.equal(bettermentTable({ ...base, baseline: null }), null);
  assert.equal(bettermentTable({ ...base, baseline: { ...baseline, daysOfHistory: 3 } }), null);
  assert.equal(bettermentTable({ ...base, baseline, baselineAt: '2026-11-02' }), null, 'baseline taken after the period ended');
  const noHealth = bettermentTable({ ...base, baseline: { ...baseline, healthScore: null }, currentHealth: 86 });
  assert.equal(noHealth.table.rows.length, 2);
});

test('top searches section is absent when there are none', () => {
  assert.equal(topSearchesSection([]), null);
  assert.equal(topSearchesSection([{ dim_value: 'seo report', clicks: 12 }]).table.rows[0][0], 'seo report');
});

test('bettermentTable accepts the Date the database returns for the baseline time', () => {
  const t = bettermentTable({ baseline: { daysOfHistory: 30, clicks: 300, impressions: 3000 }, baselineAt: new Date('2026-09-15T09:00:00Z'), periodEnd: '2026-10-25',
    cur: { clicks: 700, impressions: 7000, days: 7 }, prev: null, currentHealth: null, labels: { prev: 'Last week', cur: 'This week' } });
  assert.ok(t, 'a baseline taken before the period must produce the table');
  assert.equal(bettermentTable({ baseline: { daysOfHistory: 30, clicks: 1, impressions: 1 }, baselineAt: new Date('2026-11-01T00:00:00Z'), periodEnd: '2026-10-25', cur: { clicks: 1, impressions: 1, days: 7 }, prev: null, labels: { prev: 'a', cur: 'b' } }), null);
});

describe('visitor behaviour sections (PostHog)', () => {
  const summary = {
    days: 7, measured_days: 7, events: 27387, pageviews: 15215, sessions: 4258, peak_daily_people: 465,
    topDropOffs: [
      { event: 'page: /pricing', sessions_ending_here: 182 },
      { event: 'signup_form_viewed', sessions_ending_here: 95 },
    ],
  };

  test('a project without PostHog gets nothing at all — no heading, no "not connected" line', () => {
    assert.deepEqual(visitorBehaviourSections(null), []);
    assert.deepEqual(visitorBehaviourSections(undefined), []);
    assert.deepEqual(visitorBehaviourSections({ days: 0 }), []);
  });

  test('a connected project gets what visitors did and where they stopped', () => {
    const out = visitorBehaviourSections(summary);
    assert.deepEqual(out.map((s) => s.title), ['What visitors did', 'Where people stopped']);
    assert.deepEqual(out[0].table.rows[0], ['Visits (sessions)', '4,258']);
  });

  test('people are labelled as the busiest day, never a period total', () => {
    const rows = visitorBehaviourSections(summary)[0].table.rows;
    assert.ok(rows.some((r) => r[0] === 'People, on the busiest day' && r[1] === '465'));
    assert.ok(!rows.some((r) => /^people$/i.test(r[0])), 'there must be no plain summed "People" row');
  });

  test('steps read as words: a page by its path, an event de-snaked', () => {
    const stops = visitorBehaviourSections(summary)[1].table.rows;
    assert.deepEqual(stops[0], ['The /pricing page', '182', '4%']);
    assert.deepEqual(stops[1], ['Signup form viewed', '95', '2%']);
  });

  test('a partial period says how many days it covers', () => {
    const out = visitorBehaviourSections({ ...summary, measured_days: 5 });
    assert.match(out[0].sub, /covers 5 of 7 days/);
  });

  test('a clean full period does not claim partial coverage', () => {
    assert.ok(!/covers/.test(visitorBehaviourSections(summary)[0].sub));
  });

  test('no drop-offs means only the first section', () => {
    assert.equal(visitorBehaviourSections({ ...summary, topDropOffs: [] }).length, 1);
  });

  test('both sections are keyed so the page can avoid drawing the same data twice', () => {
    assert.deepEqual(visitorBehaviourSections(summary).map((s) => s.key), ['visitor-behaviour', 'visitor-behaviour-stops']);
  });

  test('the stops list is capped at five', () => {
    const many = { ...summary, topDropOffs: Array.from({ length: 9 }, (_, i) => ({ event: `step_${i}`, sessions_ending_here: 9 - i })) };
    assert.equal(visitorBehaviourSections(many)[1].table.rows.length, 5);
  });

  test('humanStep leaves a custom event name recognisable', () => {
    assert.equal(humanStep('get_started_clicked'), 'Get started clicked');
    assert.equal(humanStep('page: /'), 'The / page');
    assert.equal(humanStep(''), '');
    assert.equal(humanStep(null), '');
  });

  describe('behaviourModel (what the on-screen report draws)', () => {
    test('null for a project without PostHog data, so nothing is drawn', () => {
      assert.equal(behaviourModel(null, null, 'prior week'), null);
      assert.equal(behaviourModel({ days: 0 }, null, 'prior week'), null);
    });

    test('four tiles, with changes only when a previous period exists, never for busiest-day people', () => {
      const none = behaviourModel(summary, null, 'prior week');
      assert.deepEqual(none.tiles.map((t) => t.label), ['Pages viewed', 'Visits', 'Actions taken', 'People, busiest day']);
      assert.equal(none.tiles[0].value, '15,215');
      assert.equal(none.tiles[0].delta, null, 'no previous period: no change is claimed');
      const withPrev = behaviourModel(summary, { days: 7, measured_days: 7, pageviews: 10000, sessions: 4258, events: 30000 }, 'prior week');
      assert.equal(withPrev.tiles[0].delta, '▲ 52% vs prior week');
      assert.equal(withPrev.tiles[1].delta, null, 'an unchanged figure states nothing');
      assert.equal(withPrev.tiles[2].delta, '▼ 9% vs prior week');
      assert.equal(withPrev.tiles[3].delta, 'highest single day');
    });

    test('no change is stated against a period PostHog only measured in part', () => {
      const partialPrev = behaviourModel(summary, { days: 7, measured_days: 3, pageviews: 100, sessions: 40, events: 300 }, 'prior week');
      assert.deepEqual(partialPrev.tiles.slice(0, 3).map((t) => t.delta), [null, null, null]);
      const partialNow = behaviourModel({ ...summary, measured_days: 5 }, { days: 7, measured_days: 7, pageviews: 100, sessions: 40, events: 300 }, 'prior week');
      assert.deepEqual(partialNow.tiles.slice(0, 3).map((t) => t.delta), [null, null, null]);
    });

    test('the ranked list carries a share of all visits, and a raw name only for a custom event', () => {
      const m = behaviourModel(summary, null, 'prior week');
      assert.equal(m.visits, 4258);
      assert.deepEqual(m.stops[0], { label: 'The /pricing page', raw: null, n: 182, share: 4 });
      assert.deepEqual(m.stops[1], { label: 'Signup form viewed', raw: 'signup_form_viewed', n: 95, share: 2 });
    });

    test('the takeaway says what the numbers say and nothing about why', () => {
      const m = behaviourModel(summary, null, 'prior week');
      assert.match(m.takeaway, /^More visits end on The \/pricing page than anywhere else, 4% of all visits\./);
      assert.equal(behaviourModel({ ...summary, topDropOffs: [] }, null, 'x').takeaway, null);
      assert.equal(behaviourModel({ ...summary, sessions: null }, null, 'x').takeaway, null, 'no visit total, no share, no sentence');
    });

    test('a partial period says how many days it covers', () => {
      assert.match(behaviourModel({ ...summary, measured_days: 5 }, null, 'x').note, /Covers 5 of 7 days/);
      assert.equal(behaviourModel(summary, null, 'x').note, null);
    });
  });
});

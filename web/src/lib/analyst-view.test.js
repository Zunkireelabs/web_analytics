import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOutlookStory, problemSummary, chartGeometry, accuracyLine, rangeText, changeText,
  filterProblems, filterCounts, stepperFor, fixesStrip, fixesBadge, whenLabel,
} from './analyst-view.js';

const ok = (extra = {}) => ({ status: 'ok', forecast: { clicks: { predicted: 1240.4, changePct: 11.2 }, impressions: { predicted: 41000 } }, keywords: [{}, {}], shifts: [{ text: 'Searches that mention ChatGPT are up 38%', direction: 'up' }], ...extra });

describe('buildOutlookStory', () => {
  test('only says what the data has', () => {
    const s = buildOutlookStory(ok());
    assert.match(s, /about 1,240 clicks, up 11%, and about 41,000 impressions/);
    assert.match(s, /2 keywords are close enough/);
    assert.match(s, /ChatGPT are up 38%\.$/);
  });
  test('no forecast and no keywords means no such sentences', () => {
    assert.equal(buildOutlookStory({ status: 'ok', forecast: null, keywords: [], shifts: [] }), null);
    assert.doesNotMatch(buildOutlookStory({ status: 'ok', forecast: null, keywords: [{}], shifts: [] }), /clicks/);
  });
  test('not-ready gives no story', () => assert.equal(buildOutlookStory({ status: 'not-ready' }), null));
  test('a flat change does not claim up or down', () => {
    assert.doesNotMatch(buildOutlookStory(ok({ forecast: { clicks: { predicted: 100, changePct: 0 } }, shifts: [] })), /up|down/);
  });
});

describe('problemSummary', () => {
  test('counts', () => assert.deepEqual(problemSummary({ expected: 5, handled: 3, needsOk: 1 }), { headline: '5 problems expected', detail: '3 handled · 1 needs your OK' }));
  test('none expected means nothing to show', () => assert.equal(problemSummary({ expected: 0 }), null));
});

describe('chartGeometry', () => {
  const f = { history: [1, 2, 3].map((c, i) => ({ week: `w${i}`, clicks: c * 100 })), future: [{ week: 'a', clicks: { predicted: 320, low: 300, high: 340 } }, { week: 'b', clicks: { predicted: 330, low: 290, high: 380 } }] };
  test('history joins future at the split and the band closes', () => {
    const g = chartGeometry(f);
    assert.equal(g.history.split(' ').length, 3);
    assert.equal(g.future.split(' ').length, 3);
    assert.equal(g.future.split(' ')[0], g.history.split(' ')[2]);
    assert.equal(g.band.split(' ').length, 6);
  });
  test('too little history means no chart', () => {
    assert.equal(chartGeometry({ history: [{ clicks: 1 }], future: f.future }), null);
    assert.equal(chartGeometry({ history: f.history, future: [] }), null);
  });
});

describe('text helpers', () => {
  test('accuracy only with real numbers', () => {
    assert.equal(accuracyLine({ withinPct: 8.6, weeksChecked: 8 }), 'Last 8 predictions were within 9% on average');
    assert.equal(accuracyLine({ withinPct: 5, weeksChecked: 1 }), 'Last 1 prediction was within 5% on average');
    assert.equal(accuracyLine(null), null);
  });
  test('range and change', () => {
    assert.equal(rangeText({ low: 1150, high: 1330 }), 'likely between 1,150 and 1,330');
    assert.equal(rangeText({ low: null, high: 5 }), null);
    assert.equal(changeText({ changePct: -4.2, thisWeek: 1000 }), '−4% vs this week (1,000)');
    assert.equal(changeText({ changePct: 11, thisWeek: 1120 }), '+11% vs this week (1,120)');
  });
});

describe('problems', () => {
  const ps = [{ stage: 'predicted' }, { stage: 'needs-ok', step: 0 }, { stage: 'fixing', step: 1 }, { stage: 'fixed', step: 2 }];
  test('filters; needs-ok counts with predicted', () => {
    assert.equal(filterProblems(ps, 'all').length, 4);
    assert.equal(filterProblems(ps, 'predicted').length, 2);
    assert.equal(filterProblems(ps, 'fixing').length, 1);
    assert.deepEqual(filterCounts(ps), { all: 4, predicted: 2, fixing: 1, fixed: 1 });
    assert.deepEqual(filterCounts(null), { all: 0, predicted: 0, fixing: 0, fixed: 0 });
  });
  test('stepper states and the needs-your-OK label', () => {
    assert.deepEqual(stepperFor({ stage: 'fixing', step: 1 }).map((s) => s.state), ['done', 'current', 'todo', 'todo']);
    const n = stepperFor({ stage: 'needs-ok', step: 0 });
    assert.equal(n[0].label, 'Needs your OK');
    assert.equal(n[0].alert, true);
    assert.equal(stepperFor({ stage: 'fixed', step: 9 })[3].state, 'current', 'step is clamped');
  });
});

describe('strip, badge, when', () => {
  test('strip uses clicks won back only when present', () => {
    const s = fixesStrip({ predicted: 1, fixing: 2, fixed: 1, needsOk: 1, solvedThisMonth: 4, clicksWonBack: 120 });
    assert.equal(s.length, 5);
    assert.equal(s[4].sub, 'about 120 clicks won back');
    assert.doesNotMatch(fixesStrip({ solvedThisMonth: 0 })[4].sub, /won back/);
    assert.deepEqual(fixesStrip(null), []);
  });
  test('badge counts what still needs attention', () => {
    assert.equal(fixesBadge({ needsOk: 1, predicted: 2 }), 3);
    assert.equal(fixesBadge({ needsOk: 0, predicted: 0 }), null);
  });
  test('relative dates', () => {
    const now = new Date('2026-10-27T12:00:00Z');
    assert.equal(whenLabel('2026-10-27T01:00:00Z', now), 'Today');
    assert.equal(whenLabel('2026-10-26T01:00:00Z', now), 'Yesterday');
    assert.equal(whenLabel('2026-10-20T00:00:00Z', now), '7 days ago');
    assert.equal(whenLabel('2026-10-06T00:00:00Z', now), '3 weeks ago');
    assert.equal(whenLabel('nope', now), '');
  });
});

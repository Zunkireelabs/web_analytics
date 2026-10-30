import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pathKey, stageForIssue, buildProblems, sortProblems, countProblems, buildSolved, solvedSummary, buildWeek, buildShifts, buildOutlook, buildFixes, fixLabel } from './analyst-outlook.js';

const issue = (id, page, over = {}) => ({ id, page, likelihood: 0.8, reason: 'Clicks fell 40% last week.', createdAt: '2026-10-26T05:00:00Z', ...over });
const draft = (id, page, status, over = {}) => ({ id, page, status, actionType: 'faq', createdAt: '2026-10-26T06:00:00Z', implementedAt: null, ...over });

describe('pathKey', () => {
  test('absolute URL, path, case and trailing slash all match', () => {
    assert.equal(pathKey('https://X.com/Blog/Guide/'), '/blog/guide');
    assert.equal(pathKey('/blog/guide'), '/blog/guide');
    assert.equal(pathKey('https://x.com'), '/');
    assert.equal(pathKey(null), '');
  });
});

describe('stageForIssue', () => {
  test('nothing aimed at the page yet is predicted', () => {
    assert.deepEqual(stageForIssue(issue(1, 'https://x.com/a'), {}), { stage: 'predicted', step: 0, draft: null });
  });
  test('an open recommendation alone means the agent is on it', () => {
    const r = stageForIssue(issue(1, 'https://x.com/a'), { openRecommendationPages: new Set(['/a']) });
    assert.equal(r.stage, 'fixing'); assert.equal(r.step, 1);
  });
  test('a draft waiting for a person needs OK; an approved one is being fixed', () => {
    assert.equal(stageForIssue(issue(1, '/a'), { drafts: [draft(9, 'https://x.com/a', 'submitted_for_approval')] }).stage, 'needs-ok');
    assert.equal(stageForIssue(issue(1, '/a'), { drafts: [draft(9, '/a', 'approved')] }).stage, 'fixing');
  });
  test('implemented is fixed, and result checked once measured', () => {
    assert.equal(stageForIssue(issue(1, '/a'), { drafts: [draft(9, '/a', 'implemented')] }).step, 2);
    assert.equal(stageForIssue(issue(1, '/a'), { drafts: [draft(9, '/a', 'implemented')], measuredDraftIds: new Set([9]) }).step, 3);
  });
  test('a draft from before the prediction, an abandoned one, or another page does not count', () => {
    const ctx = (d) => stageForIssue(issue(1, '/a'), { drafts: [d] }).stage;
    assert.equal(ctx(draft(9, '/a', 'implemented', { createdAt: '2026-09-01T00:00:00Z' })), 'predicted');
    assert.equal(ctx(draft(9, '/a', 'abandoned')), 'predicted');
    assert.equal(ctx(draft(9, '/b', 'implemented')), 'predicted');
  });
  test('the newest draft decides', () => {
    const r = stageForIssue(issue(1, '/a'), { drafts: [draft(1, '/a', 'approved', { createdAt: '2026-10-26T06:00:00Z' }), draft(2, '/a', 'implemented', { createdAt: '2026-10-27T06:00:00Z' })] });
    assert.equal(r.stage, 'fixed');
  });
});

describe('problems and counts', () => {
  const ctx = { drafts: [draft(9, '/b', 'approved'), draft(8, '/c', 'implemented'), draft(7, '/d', 'draft')] };
  const problems = buildProblems([issue(1, '/a', { likelihood: 0.5 }), issue(2, '/b'), issue(3, '/c'), issue(4, '/d')], ctx);
  test('each problem gets plain-words fields and its stage', () => {
    assert.equal(problems[1].stage, 'fixing');
    assert.equal(problems[1].likelihoodPct, 80);
    assert.equal(problems[1].fix, 'Add an FAQ');
    assert.equal(problems[0].title, '/a is likely to lose clicks');
  });
  test('needs-ok first, then predicted, fixing, fixed', () => {
    assert.deepEqual(sortProblems(problems).map((p) => p.stage), ['needs-ok', 'predicted', 'fixing', 'fixed']);
  });
  test('counts', () => assert.deepEqual(countProblems(problems), { predicted: 1, fixing: 1, fixed: 1, needsOk: 1 }));
});

describe('solved', () => {
  const measured = [
    { id: 1, generator_id: 'meta-title', page_url: 'https://x.com/a', measured_at: '2026-10-20T00:00:00Z', delta: { clicks: 42 } },
    { id: 2, generator_id: 'faq', page_url: null, measured_at: '2026-08-01T00:00:00Z', delta: { clicks: -3 } },
    { id: 3, generator_id: 'schema', page_url: '/c', measured_at: '2026-10-25T00:00:00Z', delta: {} },
  ];
  test('titles and gains come from the measured rows only', () => {
    const s = buildSolved(measured);
    assert.equal(s[0].title, 'Rewrite the title · /a'); assert.equal(s[0].gain, '+42 clicks');
    assert.equal(s[1].gain, '-3 clicks'); assert.equal(s[2].gain, null);
  });
  test('this month counts only recent ones and wins only positive clicks', () => {
    assert.deepEqual(solvedSummary(measured, new Date('2026-10-27').getTime()), { solvedThisMonth: 2, clicksWonBack: 42 });
  });
});

describe('week', () => {
  const now = new Date('2026-10-28T09:00:00'); // Wednesday
  test('lists this week implemented, queued and waiting work only', () => {
    const w = buildWeek([
      draft(1, '/a', 'implemented', { implementedAt: '2026-10-26T10:00:00', createdAt: '2026-10-24T10:00:00' }),
      draft(2, '/b', 'approved'),
      draft(3, '/c', 'draft', { createdAt: '2026-10-27T10:00:00' }),
      draft(4, '/d', 'implemented', { implementedAt: '2026-10-01T10:00:00', createdAt: '2026-09-30T10:00:00' }),
    ], now);
    assert.deepEqual(w.map((x) => x.stage), ['fixed', 'fixing', 'needs-ok']);
    assert.equal(w[0].when, 'Mon');
  });
});

describe('outlook', () => {
  test('not ready carries the message and no invented numbers', () => {
    const o = buildOutlook({ py: { status: 'not-ready', message: 'Need 8 weeks.' }, problems: [], shifts: [] });
    assert.equal(o.status, 'not-ready'); assert.equal(o.forecast, null); assert.equal(o.message, 'Need 8 weeks.');
  });
  test('ok passes the forecast through and counts handled problems', () => {
    const problems = buildProblems([issue(1, '/a'), issue(2, '/b')], { drafts: [draft(9, '/b', 'approved')] });
    const o = buildOutlook({ py: { status: 'ok', forecast: { nextWeek: '2026-11-02' }, lastWeek: null, keywords: [{ keyword: 'k' }] }, problems, shifts: [] });
    assert.deepEqual(o.problemCounts, { expected: 2, handled: 1, needsOk: 0 });
    assert.equal(o.forecast.nextWeek, '2026-11-02');
  });
  test('shifts: radar topics and rising queries, labelled by source', () => {
    const s = buildShifts({ radarTopics: [{ topic: 'AI answer engines' }], risingQueries: [{ query: 'seo report', pctChange: 22 }] });
    assert.deepEqual(s.map((x) => x.source), ['Trend radar', 'Your own searches']);
    assert.match(s[1].text, /"seo report" 22% more/);
  });
});

describe('fixes', () => {
  test('strip, problems without internal ids, solved and week assemble together', () => {
    const problems = buildProblems([issue(1, '/a')], { drafts: [draft(9, '/a', 'implemented')] });
    const f = buildFixes({ problems, measured: [{ id: 1, generator_id: 'faq', page_url: '/a', measured_at: new Date().toISOString(), delta: { clicks: 10 } }], drafts: [] });
    assert.equal(f.counts.fixed, 1); assert.equal(f.counts.solvedThisMonth, 1); assert.equal(f.counts.clicksWonBack, 10);
    assert.ok(!('draftId' in f.problems[0]));
    assert.equal(fixLabel('nope'), 'Improve the page');
  });
});

describe('field shifts', () => {
  const industry = { scope: 'industry', projects: 9, fieldChangeNext3Pct: 6.4, fieldRecentChangePct: 3, yourRecentChangePct: 12 };
  test('a rising field and how this project compares, labelled with how many projects it rests on', () => {
    const s = buildShifts({ industry });
    assert.match(s[0].text, /demand in your field is expected to rise about 6% over the next 3 weeks/);
    assert.equal(s[0].source, 'Learned across 9 projects'); assert.equal(s[0].direction, 'up');
    assert.match(s[1].text, /your searches grew 12% while your field grew 3%/); assert.equal(s[1].direction, 'up');
  });
  test('a flat field reads as flat, a falling one as falling, platform scope says projects like yours', () => {
    assert.equal(buildShifts({ industry: { ...industry, fieldChangeNext3Pct: 0.5 } })[0].direction, 'flat');
    const down = buildShifts({ industry: { ...industry, scope: 'platform', fieldChangeNext3Pct: -8 } })[0];
    assert.equal(down.direction, 'down'); assert.match(down.text, /projects like yours is expected to fall about 8%/);
  });
  test('no field figure, no field shift', () => assert.deepEqual(buildShifts({ industry: null }), []));
});

import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL ||= 'postgres://x:x@localhost:1/x';
const { summariseQuestions, upcomingDates, stageProgress } = await import('./industry-page.js');

test('only question-shaped searches count, and answered means page one', () => {
  const filler = Array.from({ length: 6 }, (_, i) => ({ query: `how to apply ${i}`, impressions: 30, position: 4 }));
  const r = summariseQuestions([
    { query: 'what are the fees to study in canada', impressions: 1500, position: 14 },
    { query: 'do i need ielts for germany', impressions: 900, position: 6 },
    { query: 'study abroad consultants', impressions: 5000, position: 3 },
    { query: 'is a student visa hard', impressions: 3, position: 20 },
    ...filler,
  ]);
  assert.equal(r.total, 8); assert.equal(r.answered, 7); assert.equal(r.percent, 88);
  assert.deepEqual(r.open, [{ question: 'what are the fees to study in canada', shownPerMonth: 500 }]);
});
test('too few questions is not a measurement', () => {
  assert.equal(summariseQuestions([{ query: 'what is a visa', impressions: 90, position: 3 }, { query: 'how to apply', impressions: 90, position: 30 }]), null);
});
test('no questions means no summary, not a zero', () => {
  assert.equal(summariseQuestions([{ query: 'visa', impressions: 400, position: 5 }]), null);
});
test('upcoming dates start from this month and wrap the year', () => {
  const d = upcomingDates([{ month: 1, title: 'A' }, { month: 3, title: 'B' }, { month: 8, title: 'C' }], new Date('2026-11-06'));
  assert.deepEqual(d.map((x) => x.title), ['A', 'B', 'C']);
});
test('stage: first not-done stage is current; convert is never done without visitor data', () => {
  const st = [{ key: 'found' }, { key: 'trusted' }, { key: 'convert' }, { key: 'expand' }];
  assert.deepEqual(stageProgress(st, { foundDone: true, trustedDone: true, convertDone: false }).map((s) => s.state), ['done', 'done', 'now', 'next']);
  assert.deepEqual(stageProgress(st, { foundDone: false, trustedDone: false, convertDone: false }).map((s) => s.state), ['now', 'next', 'next', 'next']);
});

const { plainMove } = await import('./industry-page.js');
const rec = (issue, reason, a) => ({ issue, reason, detecting_agents: [a] });
test('moves read as plain actions', () => {
  assert.equal(plainMove(rec('Cover this topic', 'A real buyer-style prompt ("How can I find luxury senior relocation assistance?") got no mention of this company', 'ai-recommendation')).title, 'Answer this question people ask AI assistants: "How can I find luxury senior relocation assistance?"');
  assert.equal(plainMove(rec('Cover: downsize help UK', 'No page targets it', 'keyword-narrative')).title, 'Add a page about downsize help UK');
  assert.equal(plainMove(rec('Insight: Visa rules change', 'x', 'trend-radar')).title, 'Write about: Visa rules change');
  assert.equal(plainMove(rec('Generate Translation', 'Portuguese had 2 real session(s) this period', 'country-intelligence')).title, 'Translate your top page into Portuguese');
  assert.equal(plainMove(rec('Generate Landing Page', "Pakistan's share of sessions rose", 'country-intelligence')).title, 'Add a page for visitors from Pakistan');
  assert.equal(plainMove(rec('Growth opportunity (quick-win): "admizz"', 'Ranks #1.3', 'growth-opportunities')).title, 'Improve how "admizz" shows in search');
  assert.equal(plainMove(rec('Something else entirely', 'because', 'content-gap')).title, 'Something else entirely');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyFacts, validateCandidates, newsContext, refreshFacts, monthYear } from './official-news.js';

const page = { url: 'https://www.gov.uk/student-visa/money', ok: true, text: 'You must show that you have enough money.   For a course in London you need £1,483 for each month, for up to 9 months.' };

test('a fact is kept only when its quote really appears on the official page (whitespace and case aside)', () => {
  const facts = [
    { statement: 'London monthly amount', quote: 'for a course in london you need £1,483 for each month' },
    { statement: 'invented', quote: 'You need £9,999 for each month of the course' },
    { statement: 'too short', quote: 'enough money' },
  ];
  const out = verifyFacts(facts, [page]);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, page.url);
});
test('a page that could not be opened confirms nothing', () => {
  assert.deepEqual(verifyFacts([{ statement: 's', quote: 'for a course in London you need £1,483 for each month' }], [{ url: 'u', ok: false, text: '' }]), []);
});
test('candidates need real headline indexes and a country the project has official sources for; repeats are dropped', () => {
  const items = [{ title: 'UK changes rule', url: 'u1', source: 'ICEF', publishedAt: '2026-11-18' }];
  const raw = [
    { topic: 'UK financial proof 2027', country: 'uk', claim: 'The amount rises', sources: [0] },
    { topic: 'UK financial proof 2027', country: 'UK', claim: 'dup', sources: [0] },
    { topic: 'France thing', country: 'France', claim: 'x', sources: [0] },
    { topic: 'No lead', country: 'UK', claim: 'x', sources: [7] },
  ];
  const out = validateCandidates(raw, items, ['UK', 'Canada']);
  assert.equal(out.length, 1);
  assert.equal(out[0].country, 'UK');
});
test('the writer context carries only confirmed facts with their official page, the Sources and checked-in rules, and the client style', () => {
  const ctx = newsContext({ candidate: { country: 'UK', topic: 'UK proof 2027', claim: 'amount rises' }, facts: [{ statement: 's', quote: 'q'.repeat(30), url: 'https://www.gov.uk/x' }], styleRules: 'American English', now: new Date('2026-11-19T00:00:00Z') });
  assert.match(ctx, /https:\/\/www\.gov\.uk\/x/);
  assert.match(ctx, /Checked in November 2026/);
  assert.match(ctx, /"Sources" section/);
  assert.match(ctx, /American English/);
  assert.match(ctx, /never state it as fact/);
});
test('refresh facts name the month to stamp', () => {
  assert.match(refreshFacts({ candidate: { country: 'UK', claim: 'c' }, facts: [{ statement: 's', quote: 'q', url: 'u' }], now: new Date('2026-12-02T00:00:00Z') }), /December 2026/);
  assert.equal(monthYear(new Date('2026-01-05T00:00:00Z')), 'January 2026');
});

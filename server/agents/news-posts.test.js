import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, confirmCandidate } from './news-posts.js';

const REAL = 'For a course in London you need £1,483 for each month, for up to 9 months, and you must hold it for 28 days.';
const config = (over = {}) => ({
  enabled: true, interval_days: 7, style_rules: 'American English',
  lead_feeds: [{ id: 'f', url: 'https://example.org/feed' }],
  official_sources: [{ country: 'UK', name: 'GOV.UK', pages: ['https://www.gov.uk/student-visa/money'] }, { country: 'Canada', name: 'IRCC', pages: ['https://www.canada.ca/x'] }],
  ...over,
});
const lead = (title) => ({ title, url: 'https://news.example/' + title.length, source: 'ICEF', publishedAt: new Date().toISOString(), summary: '' });
const feeds = async () => ({ items: [lead('UK raises student funds'), lead('Canada sets new permit cap'), lead('Third item here'), lead('Fourth item')], failed: [], fetched: 1 });
const fetchPage = async (url) => (url.includes('gov.uk') ? { ok: true, text: REAL } : { ok: false, error: 'blocked' });
// The fake model answers each step with the shape the real one is asked for.
const callJson = async (system, user) => {
  if (/candidates/.test(system)) {
    return { candidates: [
      { topic: 'UK student visa funds 2027 for Nepali students', country: 'UK', claim: 'The monthly amount is £1,483', sources: [0] },
      { topic: 'Canada study permit cap 2027', country: 'Canada', claim: 'The cap falls', sources: [1] },
    ] };
  }
  return { facts: [{ statement: 'London monthly amount is £1,483', quote: 'For a course in London you need £1,483 for each month' }, { statement: 'made up', quote: 'You must hold £99,999 in a blocked account forever' }] };
};
const base = (over = {}) => ({ siteId: 1, deps: { getConfig: async () => config(), fetchFeeds: feeds, callJson, fetchPage, listPages: async () => [], getSite: async () => ({ website_domain: 'admizzeducation.com' }), ...over } });

test('a project with no enabled news config is skipped and touches nothing', async () => {
  const out = await run(base({ getConfig: async () => null }));
  assert.equal(out.status, 'skipped');
  const off = await run(base({ getConfig: async () => config({ enabled: false }) }));
  assert.equal(off.status, 'skipped');
});
test('a lead confirmed on the official page becomes a draft; one whose official page cannot be opened is dropped', async () => {
  const out = await run(base());
  assert.equal(out.status, 'ok');
  assert.equal(out.facts.confirmed, 1);
  assert.equal(out.facts.findings.length, 1);
  const f = out.facts.findings[0];
  assert.equal(f.recommendedAction.generatorId, 'blog-outline');
  assert.equal(f.recommendedAction.params.category, 'Insights');
  assert.match(f.recommendedAction.params.context, /£1,483/);
  assert.doesNotMatch(f.recommendedAction.params.context, /99,999/); // the invented quote never reaches the writer
  assert.equal(out.facts.dropped.length, 1);
  assert.equal(out.facts.dropped[0].country, 'Canada');
  assert.match(out.facts.dropped[0].reason, /could not be opened/);
});
test('a topic the site already covers becomes a refresh of that page, not a duplicate', async () => {
  const out = await run(base({ listPages: async () => [{ page: '/uk-student-visa-funds-nepali-students-2026' }] }));
  const f = out.facts.findings[0];
  assert.equal(f.recommendedAction.generatorId, 'refresh-content');
  assert.equal(f.recommendedAction.params.page, 'https://admizzeducation.com/uk-student-visa-funds-nepali-students-2026');
  assert.match(f.recommendedAction.params.officialFacts, /£1,483/);
});
test('a claim the official page does not state is not confirmed', async () => {
  const r = await confirmCandidate({ country: 'UK', claim: 'x' }, config(), { callJson: async () => ({ facts: [{ statement: 's', quote: 'This sentence is not on the official page at all' }] }), fetchPage });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /not found/);
});
test('too few readable headlines is insufficient-data, not an empty success', async () => {
  const out = await run(base({ fetchFeeds: async () => ({ items: [lead('only one')], failed: [], fetched: 1 }) }));
  assert.equal(out.status, 'insufficient-data');
});

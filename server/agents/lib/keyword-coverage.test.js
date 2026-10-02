import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assessKeywordCoverage, keywordSignals, COVERAGE } from './keyword-coverage.js';

const WEB = 'https://zunkireelabs.com/services/web-development/';
const AI = 'https://zunkireelabs.com/services/ai-development/';
const pages = [{ page: WEB }, { page: AI }, { page: 'https://zunkireelabs.com/about/' }];

const content = {
  [WEB]: { title: 'Web Development Services', h1: 'Web Development', metaDescription: 'We build websites.', bodyText: 'Web development for businesses.', htmlLang: 'en' },
  [AI]: { title: 'AI Development Services', h1: 'AI Development', metaDescription: 'Custom AI.', bodyText: 'AI development, machine learning.', htmlLang: 'en' },
};

function run(topic, { llm, shortlistForeign } = {}) {
  const calls = { llm: 0 };
  return assessKeywordCoverage({
    topic, pages,
    fetchPage: async (url) => content[url] ?? null,
    llm: async (...a) => { calls.llm += 1; return llm ? llm(...a) : { decision: 'not_covered', covered_by: null, reason: 'x' }; },
    shortlistForeign,
  }).then((r) => ({ ...r, calls }));
}

describe('keywordSignals', () => {
  test('detects market, language and intent without treating them as core topic', () => {
    const s = keywordSignals('Webentwicklung Unternehmen Schweiz');
    assert.equal(s.market, 'switzerland');
    assert.equal(s.lang, 'de');
    assert.equal(s.confident, true);
    assert.ok(!s.core.includes('schweiz'));
  });
  test('plain English keyword has no market and is not flagged foreign', () => {
    const s = keywordSignals('web development');
    assert.equal(s.market, null);
    assert.equal(s.confident, false);
  });
});

describe('assessKeywordCoverage', () => {
  test('exact topic on a matching page is covered, with no LLM call', async () => {
    const r = await run('web development');
    assert.equal(r.decision, COVERAGE.COVERED);
    assert.equal(r.coveredBy, WEB);
    assert.equal(r.stage, 'deterministic');
    assert.equal(r.calls.llm, 0);
  });

  test('"custom AI development services" is covered by the AI development page', async () => {
    const r = await run('custom AI development services');
    assert.equal(r.decision, COVERAGE.COVERED);
    assert.equal(r.coveredBy, AI);
  });

  test('a market the page never mentions is NOT covered, with no LLM call (Switzerland)', async () => {
    const r = await run('web development Switzerland');
    assert.notEqual(r.decision, COVERAGE.COVERED);
    assert.equal(r.coveredBy, null);
    assert.equal(r.decision, COVERAGE.PARTIAL);
    assert.equal(r.calls.llm, 0);
  });

  test('"Webentwicklung Schweiz" is not suppressed by the generic English page', async () => {
    const r = await run('Webentwicklung Schweiz', { shortlistForeign: async () => [{ page: WEB }] });
    assert.notEqual(r.decision, COVERAGE.COVERED);
    assert.equal(r.coveredBy, null);
  });

  test('"Webentwicklung Unternehmen Schweiz" is not suppressed either', async () => {
    const r = await run('Webentwicklung Unternehmen Schweiz', { shortlistForeign: async () => [{ page: WEB }] });
    assert.notEqual(r.decision, COVERAGE.COVERED);
  });

  test('"KI-Entwicklung" (language differs, no market) goes to the LLM and may be covered', async () => {
    const r = await run('KI Entwicklung', {
      shortlistForeign: async () => [{ page: AI }],
      llm: async () => ({ decision: 'covered', covered_by: AI, reason: 'AI development page satisfies it.' }),
    });
    assert.equal(r.stage, 'llm');
    assert.equal(r.decision, COVERAGE.COVERED);
    assert.equal(r.coveredBy, AI);
  });

  test('an LLM "covered" naming a page it was not shown cannot suppress the keyword', async () => {
    const r = await run('KI Entwicklung', {
      shortlistForeign: async () => [{ page: AI }],
      llm: async () => ({ decision: 'covered', covered_by: 'https://evil.example/x', reason: 'x' }),
    });
    assert.equal(r.decision, COVERAGE.PARTIAL);
    assert.equal(r.coveredBy, null);
  });

  test('LLM failure records nothing (checked:false) and never reports covered', async () => {
    const r = await run('KI Entwicklung', {
      shortlistForeign: async () => [{ page: AI }],
      llm: async () => { throw new Error('boom'); },
    });
    assert.equal(r.checked, false);
    assert.notEqual(r.decision, COVERAGE.COVERED);
  });

  test('no related page at all is not_covered without any fetch or LLM call', async () => {
    const r = await run('quantum computing consulting');
    assert.equal(r.decision, COVERAGE.NOT_COVERED);
    assert.equal(r.calls.llm, 0);
  });
});

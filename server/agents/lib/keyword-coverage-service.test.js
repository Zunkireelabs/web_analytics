import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGapCoverage, isCoverageFresh, DEFINITIVE_TTL_DAYS, UNCERTAIN_TTL_DAYS } from './keyword-coverage-service.js';

const SITE_ROW = { id: 1, website_domain: 'example.com', language_code: 'en' };
const NOW = new Date('2026-10-02T00:00:00Z');

// Everything the service touches is injected: no DB, network or model.
function harness({ inventory = [], ranking = [], translate = {}, judgeAnswer = null, pages = {} } = {}) {
  const calls = { llm: 0, translate: 0, fetch: 0, saved: [], ranking: 0 };
  const deps = {
    getSite: async () => SITE_ROW,
    listInventory: async () => inventory.map((page) => ({ page })),
    getRanking: async () => { calls.ranking++; return ranking; },
    translate: async (terms) => { calls.translate++; return new Map(terms.filter((t) => translate[t]).map((t) => [t, translate[t]])); },
    getCachedTranslations: async (terms) => new Map(terms.filter((t) => translate[t]).map((t) => [t, translate[t]])),
    fetchPage: async (url) => { calls.fetch++; return pages[url] || null; },
    llmJson: async () => { calls.llm++; if (judgeAnswer instanceof Error) throw judgeAnswer; return judgeAnswer; },
    save: async (_s, id, row) => { calls.saved.push({ id, ...row }); },
  };
  return { deps, calls };
}
const run = (gap, h, opts = {}) => classifyGapCoverage(1, { id: 7, ...gap }, { now: NOW, deps: h.deps, ...opts });
const U = (p) => `https://example.com${p}`;

describe('classifyGapCoverage — orchestration and cost', () => {
  test('a clear case is decided deterministically: no LLM call, no page fetch', async () => {
    const h = harness({ inventory: [U('/services/web-development/')] });
    const r = await run({ topic: 'web development', search_intent: 'commercial' }, h);
    assert.equal(r.status, 'duplicate');
    assert.equal(h.calls.llm, 0);
    assert.equal(h.calls.fetch, 0);
  });

  test('a page already ranking for the keyword is found even when its slug shares no words', async () => {
    const h = harness({ ranking: [{ page: U('/blog/app-pricing-guide/'), query: 'cost of building an app', impressions: 80, clicks: 3, position: 9 }] });
    const r = await run({ topic: 'cost of building an app', search_intent: 'informational' }, h);
    assert.equal(r.status, 'covered');
    assert.equal(r.url, U('/blog/app-pricing-guide/'));
  });

  test('11. a repeat evaluation inside the TTL is served from cache: no LLM, no fetch, no retrieval', async () => {
    const h = harness({ inventory: [U('/services/web-development/')] });
    const gap = { topic: 'web development', coverage_status: 'covered', coverage_reason: 'cached', coverage_checked_at: '2026-09-20T00:00:00Z', existing_page_match: U('/services/web-development/') };
    const r = await run(gap, h);
    assert.equal(r.cached, true);
    assert.equal(r.method, 'cache');
    assert.deepEqual([h.calls.llm, h.calls.fetch, h.calls.ranking, h.calls.saved.length], [0, 0, 0, 0]);
  });

  test('freshness: definitive verdicts live 30 days, uncertain ones 7', () => {
    const base = { coverage_status: 'covered', coverage_checked_at: new Date(NOW - (DEFINITIVE_TTL_DAYS - 1) * 86400000).toISOString() };
    assert.equal(isCoverageFresh(base, NOW), true);
    assert.equal(isCoverageFresh({ ...base, coverage_checked_at: new Date(NOW - (DEFINITIVE_TTL_DAYS + 1) * 86400000).toISOString() }, NOW), false);
    assert.equal(isCoverageFresh({ coverage_status: 'uncertain', coverage_checked_at: new Date(NOW - (UNCERTAIN_TTL_DAYS + 1) * 86400000).toISOString() }, NOW), false);
    assert.equal(isCoverageFresh({ topic: 'x' }, NOW), false);
  });

  test('English/German/Dutch: a German keyword finds the English page that covers the subject (language_gap)', async () => {
    const h = harness({
      inventory: [U('/services/web-development/')],
      translate: { 'Webentwicklung Schweiz': { language: 'German', translation: 'web development switzerland' } },
    });
    const r = await run({ topic: 'Webentwicklung Schweiz', search_intent: 'commercial', location_code: 2756 }, h);
    assert.equal(r.status, 'language_gap');
    assert.equal(r.languageCode, 'de');
    assert.equal(r.evidence.contextMarket, 'CH');
    assert.equal(h.calls.translate, 1);
  });

  test('a non-English keyword that cannot be translated is uncertain — not a false "new opportunity"', async () => {
    const h = harness({ inventory: [U('/services/web-development/')] });
    const r = await run({ topic: 'Webentwicklung Unternehmen', search_intent: 'commercial' }, h, { allowLLM: false });
    assert.equal(r.status, 'uncertain');
    assert.match(r.reason, /English reading/);
  });

  test('an English keyword never triggers a translation call', async () => {
    const h = harness({ inventory: [U('/services/web-development/')] });
    await run({ topic: 'web development', search_intent: 'commercial' }, h);
    assert.equal(h.calls.translate, 0);
  });

  test('ambiguous overlap is judged once, and the verdict is persisted', async () => {
    const h = harness({
      inventory: [U('/services/ai-customer-experience/')],
      pages: { [U('/services/ai-customer-experience/')]: { title: 'AI customer experience', excerpt: 'Chatbots and support automation for customer teams.' } },
      judgeAnswer: { status: 'covered', url: U('/services/ai-customer-experience/'), reason: 'The page covers support chatbots.' },
    });
    const r = await run({ topic: 'ai customer support chatbot', search_intent: 'commercial' }, h);
    assert.equal(r.status, 'covered');
    assert.equal(r.method, 'llm');
    assert.equal(h.calls.llm, 1);
    assert.equal(h.calls.saved.length, 1);
    assert.equal(h.calls.saved[0].existingPageMatch, U('/services/ai-customer-experience/'));
  });

  test('an unchanged judged relationship is not re-judged', async () => {
    const first = harness({
      inventory: [U('/services/ai-customer-experience/')],
      pages: { [U('/services/ai-customer-experience/')]: { title: 'AI customer experience', excerpt: 'Support chatbots.' } },
      judgeAnswer: { status: 'covered', url: U('/services/ai-customer-experience/'), reason: 'ok' },
    });
    const gap = { topic: 'ai customer support chatbot', search_intent: 'commercial' };
    const r1 = await run(gap, first);
    const saved = first.calls.saved[0];
    const second = harness({ inventory: [U('/services/ai-customer-experience/')], pages: { [U('/services/ai-customer-experience/')]: { title: 'AI customer experience', excerpt: 'Support chatbots.' } }, judgeAnswer: new Error('must not be called') });
    // Past the TTL (so not served from cache), with unchanged evidence.
    const r2 = await classifyGapCoverage(1, { id: 7, ...gap, coverage_status: r1.status, coverage_reason: saved.reason, coverage_evidence: saved.evidence, coverage_checked_at: '2026-06-01T00:00:00Z' }, { now: NOW, deps: second.deps });
    assert.equal(r2.status, 'covered');
    assert.equal(r2.method, 'llm-cached');
    assert.equal(second.calls.llm, 0);
  });

  test('a judgment that names a page it never saw is rejected → uncertain, never trusted', async () => {
    const h = harness({
      inventory: [U('/services/ai-customer-experience/')],
      judgeAnswer: { status: 'covered', url: 'https://evil.example/other', reason: 'x' },
    });
    const r = await run({ topic: 'ai customer support chatbot' }, h);
    assert.equal(r.status, 'uncertain');
  });

  test('LLM failure → uncertain with a reason; the keyword is not dropped', async () => {
    const h = harness({ inventory: [U('/services/ai-customer-experience/')], judgeAnswer: new Error('rate limited') });
    const r = await run({ topic: 'ai customer support chatbot' }, h);
    assert.equal(r.status, 'uncertain');
    assert.match(r.reason, /Judgment unavailable/);
    assert.equal(h.calls.saved.length, 1);
  });

  test('allowLLM:false never calls the model', async () => {
    const h = harness({ inventory: [U('/services/ai-customer-experience/')], judgeAnswer: { status: 'covered', url: U('/services/ai-customer-experience/'), reason: 'x' } });
    const r = await run({ topic: 'ai customer support chatbot' }, h, { allowLLM: false });
    assert.equal(r.status, 'uncertain');
    assert.equal(h.calls.llm, 0);
  });

  test('persist:false computes without writing (dry run)', async () => {
    const h = harness({ inventory: [U('/services/web-development/')] });
    await run({ topic: 'web development' }, h, { persist: false });
    assert.equal(h.calls.saved.length, 0);
  });

  test('only a page that really covers the topic sets existing_page_match', async () => {
    const h = harness({ inventory: [U('/services/web-development/')] });
    await run({ topic: 'web development company switzerland', search_intent: 'commercial' }, h);
    assert.equal(h.calls.saved[0].status, 'market_gap');
    assert.equal(h.calls.saved[0].existingPageMatch, null);
  });

  test('pages on another domain are never candidates', async () => {
    const h = harness({ inventory: ['https://other.example/services/web-development/'] });
    const r = await run({ topic: 'web development' }, h);
    assert.equal(r.status, 'opportunity');
  });
});

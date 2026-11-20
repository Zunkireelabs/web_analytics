import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let policy; let profile; let pages; let llmResponse; let llmCalls; let feedXml; let site; let growthConfig;

mock.module(resolve('../store/read.js'), { namedExports: { getSiteById: async () => site } });
mock.module(resolve('../store/product-growth-config.js'), { namedExports: { getProductGrowthConfig: async () => growthConfig } });
mock.module(resolve('../store/site-seo-policy.js'), { namedExports: { getSeoPolicy: async () => policy } });
mock.module(resolve('../store/data-analyst.js'), { namedExports: { getSiteProfile: async () => profile } });
mock.module(resolve('../store/page-inventory.js'), { namedExports: { listPageInventory: async () => pages } });
mock.module(resolve('../llm.js'), { namedExports: { callLLMForJson: async (system, user, opts) => { llmCalls.push({ system, user, opts }); return llmResponse; } } });

const { run } = await import('./trend-radar.js');
const bp = await import('../lib/business-profile.js');

const NOW = Date.now();
const iso = (d) => new Date(NOW - d * 86_400_000).toUTCString();
const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel>${items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${i.date}</pubDate><description>&lt;p&gt;x&lt;/p&gt;</description></item>`).join('')}</channel></rss>`;

const ev = [{ source: 'page', ref: 'u', summary: 's', quote: 'q' }];
const F = (value) => ({ value, status: 'detected', confidence: 'high', evidence: ev });
const zennlyProfile = () => bp.normalizeProfile({ fields: {
  ownIndustry: F({ label: 'Software (SaaS)' }), subIndustry: F('Spa and salon booking software'),
  productsServices: F([{ name: 'Online booking' }]), targetCustomerIndustries: F(['Spas', 'Salons', 'Gyms']),
  targetCustomers: F([{ segment: 'Spa and salon owners' }]), customerProblems: F(['Double-bookings']), coreTopics: F(['salon booking software']),
} });
const mobiliseProfile = () => bp.normalizeProfile({ fields: {
  ownIndustry: F({ label: 'Marketing and advertising services' }), productsServices: F([{ name: 'Demand generation' }]),
  targetCustomers: F([{ segment: 'Enterprise brands' }]), targetCustomerIndustries: F(['Technology', 'Healthcare']),
} });
const canonical = (profileObj, extra = {}) => ({ status: 'canonical', canonical: true, usable: true, version: 2, state: 'detected', profile: profileObj, description: bp.describeCompany(profileObj), siteId: 1, ...extra });

describe('trend radar with a verified business profile', () => {
  const realFetch = globalThis.fetch;
  const stubFetch = () => { globalThis.fetch = async (url) => { const v = feedXml[url]; if (v == null) return { ok: false, status: 404, text: async () => '' }; return { ok: true, status: 200, text: async () => v }; }; };

  beforeEach(() => {
    policy = null; profile = null; growthConfig = null; pages = []; llmCalls = []; feedXml = {}; site = { id: 1, name: 'Zennly', domain: 'zennly.io' };
    llmResponse = { topics: [] };
    stubFetch();
  });

  const items = (n, prefix = 'Headline') => Array.from({ length: n }, (_, i) => ({ title: `${prefix} ${i}`, link: `https://n.test/${prefix}-${i}`, date: iso(1) }));

  test('MOBILISE: with a verified profile Trend Radar runs, and no longer fails with "No industry known"', async () => {
    site = { id: 8874, name: 'MOBILISE', domain: 'mobilise.agency' };
    profile = null; // nothing in the legacy tables: this is the exact failing state
    feedXml['https://www.marketingweek.com/feed/'] = rss(items(5, 'Marketing'));
    feedXml['https://martech.org/feed/'] = rss(items(3, 'MarTech'));
    llmResponse = { topics: [{ topic: 'How B2B teams align sales enablement with demand generation', angle: 'a', whyRelevant: 'w', sources: [0, 5] }] };
    const out = await run({ siteId: 8874, deps: { loadBusinessContext: async () => canonical(mobiliseProfile()), validateRelevance: async (t) => t.map((topic) => ({ topic, verdict: 'accept', reasons: ['ok'] })) } });
    assert.equal(out.status, 'ok');
    assert.equal(out.facts.findings.length, 1);
    assert.deepEqual(out.facts.industries, ['Marketing and advertising services']);
    assert.ok(out.facts.feedsUsed.includes('marketingweek'));
    assert.equal(out.facts.relevance.checked, true);
  });

  test('the prompt receives the separated business description, and an instruction to stay tied to the product and customers’ problems', async () => {
    feedXml['https://hnrss.org/frontpage'] = rss(items(6));
    llmResponse = { topics: [] };
    await run({ siteId: 1, deps: { loadBusinessContext: async () => canonical(zennlyProfile(), { state: 'confirmed' }) } });
    assert.equal(llmCalls.length, 1);
    assert.match(llmCalls[0].user, /Industry: Software \(SaaS\)/);
    assert.match(llmCalls[0].user, /NOT its own\): Spas, Salons, Gyms/);
    assert.match(llmCalls[0].user, /Only propose topics that a customer of this company would search for/);
    assert.doesNotMatch(llmCalls[0].user, /Industry: .*(wellness|fitness)/i);
  });

  test('Zennly: off-topic fitness topics are rejected with reasons and never become findings; a salon-software topic does', async () => {
    feedXml['https://hnrss.org/frontpage'] = rss(items(6));
    llmResponse = { topics: [
      { topic: 'The Market Shift Towards Inclusive Fitness', angle: 'a', whyRelevant: 'w', sources: [0, 1] },
      { topic: 'How salon booking software stops double-bookings', angle: 'a', whyRelevant: 'w', sources: [2, 3] },
    ] };
    const validateRelevance = async (topics) => topics.map((topic) => (/fitness/i.test(topic)
      ? { topic, verdict: 'reject', reasons: ['not about what the company sells or the problem it solves'] }
      : { topic, verdict: 'accept', reasons: ['relevant'] }));
    const out = await run({ siteId: 1, deps: { loadBusinessContext: async () => canonical(zennlyProfile()), validateRelevance } });
    assert.equal(out.status, 'ok');
    assert.deepEqual(out.facts.findings.map((f) => f.recommendedAction.params.topic), ['How salon booking software stops double-bookings']);
    assert.equal(out.facts.relevance.rejected.length, 1);
    assert.match(out.facts.relevance.rejected[0].topic, /Inclusive Fitness/);
    assert.ok(out.facts.relevance.rejected[0].reasons.length > 0);
    assert.equal(out.facts.relevance.profileVersion, 2);
  });

  test('topics the validator cannot confirm are held, not published: only an accepted topic becomes a finding', async () => {
    feedXml['https://hnrss.org/frontpage'] = rss(items(6));
    llmResponse = { topics: [{ topic: 'Something borderline', angle: 'a', whyRelevant: 'w', sources: [0, 1] }] };
    const out = await run({ siteId: 1, deps: { loadBusinessContext: async () => canonical(zennlyProfile()), validateRelevance: async (t) => t.map((topic) => ({ topic, verdict: 'unknown', reasons: ['cannot confirm'] })) } });
    assert.equal(out.facts.findings.length, 0);
    assert.equal(out.facts.relevance.held.length, 1);
  });

  test('the legacy industry guess is never consulted when a verified profile exists, and nothing is written to site_profiles', async () => {
    feedXml['https://hnrss.org/frontpage'] = rss(items(6));
    profile = { industry: 'wellness', main_topics: ['fitness', 'supplements'] }; // the stale label that caused the wrong topics
    let saved = false; let analyzed = false;
    await run({ siteId: 1, deps: { loadBusinessContext: async () => canonical(zennlyProfile()), save: async () => { saved = true; }, analyze: async () => { analyzed = true; return { ok: false }; } } });
    assert.equal(saved, false);
    assert.equal(analyzed, false);
    assert.doesNotMatch(llmCalls[0]?.user || '', /wellness|supplements/i);
  });

  test('without a verified profile nothing about the legacy behaviour changes, and the run says relevance was not checked', async () => {
    profile = { industry: 'IT services', main_topics: ['cloud'] };
    feedXml['https://hnrss.org/frontpage'] = rss(items(6));
    llmResponse = { topics: [{ topic: 'Quantum networking basics', angle: 'a', whyRelevant: 'w', sources: [0, 1] }] };
    const out = await run({ siteId: 1, deps: { loadBusinessContext: async () => ({ status: 'legacy-unverified', canonical: false, profile: null }), validateRelevance: async () => { throw new Error('must not be called'); } } });
    assert.equal(out.status, 'ok');
    assert.equal(out.facts.findings.length, 1);
    assert.equal(out.facts.relevance.checked, false);
    assert.equal(out.facts.relevance.reason, 'legacy-unverified');
  });

  test('with neither a profile nor any industry the message points at the verified profile as the fix', async () => {
    const out = await run({ siteId: 1, deps: { loadBusinessContext: async () => ({ status: 'insufficient', canonical: false, profile: null }), analyze: async () => ({ ok: false }) } });
    assert.equal(out.status, 'insufficient-data');
    assert.match(out.message, /no verified business profile \(Business Intelligence page\)/);
    assert.equal(out.facts.businessProfile, 'insufficient');
  });

  test('a verified profile whose own industry no feed covers is reported as unmapped, not as unknown', async () => {
    const odd = bp.normalizeProfile({ fields: { ownIndustry: F({ label: 'Subsistence farming' }), productsServices: F([{ name: 'Seeds' }]) } });
    const out = await run({ siteId: 1, deps: { loadBusinessContext: async () => canonical(odd) } });
    assert.equal(out.facts.capabilityGap, 'industry-unmapped');
  });

  globalThis.__restoreFetch = () => { globalThis.fetch = realFetch; };
});

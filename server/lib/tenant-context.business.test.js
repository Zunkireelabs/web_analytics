import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const resolve = (p) => fileURLToPath(new URL(p, import.meta.url));

// Two projects with different businesses and different stored profiles: the provider must keep them apart.
const SITES = {
  8872: { id: 8872, name: 'Zennly', property_type: 'website', website_domain: 'zennly.io' },
  8871: { id: 8871, name: 'Superrank', property_type: 'website', website_domain: 'superrank.si' },
  8862: { id: 8862, name: 'Admizz', property_type: 'website', website_domain: 'admizzeducation.com' },
};
let profiles = {};
let legacy = {};
const readCalls = [];

mock.module(resolve('../store/read.js'), { namedExports: { getSiteById: async (id) => SITES[id] || null } });
mock.module(resolve('../store/site-goals.js'), { namedExports: { listActiveGoals: async () => [] } });
mock.module(resolve('../store/data-analyst.js'), { namedExports: {
  getProductKnowledge: async () => [],
  getSiteProfile: async (id) => { readCalls.push(['siteProfile', id]); return legacy[id] || null; },
} });
mock.module(resolve('../store/product-growth-config.js'), { namedExports: { getProductGrowthConfig: async () => null } });
mock.module(resolve('../store/site-seo-policy.js'), { namedExports: { getSeoPolicy: async () => null } });
mock.module(resolve('./site-capabilities.js'), { namedExports: { computeSiteCapabilities: () => ({}) } });
mock.module(resolve('../store/business-profile.js'), { namedExports: {
  getCurrentBusinessProfile: async (id) => { readCalls.push(['businessProfile', id]); return profiles[id] || null; },
} });

const { loadBusinessContext, businessContextPrompt, clearTenantContextCache } = await import('./tenant-context.js');
const bp = await import('./business-profile.js');

const field = (value, status = 'detected', confidence = 'high') => ({ value, status, confidence, evidence: [{ source: 'page', ref: 'u', summary: 's', quote: 'q' }] });
const zennly = () => ({ version: 3, pending: [], profile: bp.normalizeProfile({ fields: {
  ownIndustry: field({ label: 'Software (SaaS)' }), productsServices: field([{ name: 'Online booking' }]),
  targetCustomerIndustries: field(['Spas', 'Salons']), targetCustomers: field([{ segment: 'Spa and salon owners' }]),
  customerProblems: field(['Double-bookings']), businessModel: field({ model: 'saas' }),
} }) });
const superrank = () => ({ version: 1, pending: [], profile: bp.normalizeProfile({ fields: {
  ownIndustry: field({ label: 'Software (SaaS)' }), subIndustry: field('AI SEO, GEO and AEO software'),
  productsServices: field([{ name: 'Autonomous SEO agent' }]), targetCustomers: field([{ segment: 'Marketers and agencies' }]),
} }) });

beforeEach(() => { profiles = {}; legacy = {}; readCalls.length = 0; clearTenantContextCache(); });

describe('loadBusinessContext', () => {
  test('a canonical profile is authoritative and a conflicting legacy label cannot override it', async () => {
    profiles[8872] = zennly();
    legacy[8872] = { industry: 'wellness', industry_source: 'detected', main_topics: ['fitness', 'supplements'] };
    const bc = await loadBusinessContext(8872, { agent: 'trend-radar' });
    assert.equal(bc.status, 'canonical');
    assert.equal(bc.canonical, true);
    assert.equal(bc.ownIndustry, 'Software (SaaS)');
    assert.match(bc.description, /NOT its own\): Spas, Salons/);
    assert.ok(!JSON.stringify(bc.profile).includes('fitness'));
  });

  test('projects are isolated: each gets only its own profile, and the cache is per project', async () => {
    profiles[8872] = zennly();
    profiles[8871] = superrank();
    const [a, b] = await Promise.all([loadBusinessContext(8872), loadBusinessContext(8871)]);
    assert.equal(bp.valueOf(a.profile, 'subIndustry'), null);
    assert.equal(bp.valueOf(b.profile, 'subIndustry'), 'AI SEO, GEO and AEO software');
    assert.ok(!JSON.stringify(a.profile).includes('SEO'));
    assert.ok(!JSON.stringify(b.profile).includes('Salons'));
    const again = await loadBusinessContext(8872);
    assert.equal(again.ownIndustry, 'Software (SaaS)');
    assert.ok(readCalls.every(([, id]) => [8872, 8871].includes(id)));
  });

  test('another project with no profile never inherits one from a neighbour', async () => {
    profiles[8872] = zennly();
    legacy[8862] = { industry: 'Study abroad and overseas education consultancy', industry_source: 'detected' };
    const bc = await loadBusinessContext(8862);
    assert.equal(bc.status, 'legacy-unverified');
    assert.equal(bc.ownIndustry, 'Study abroad and overseas education consultancy');
    assert.ok(!JSON.stringify(bc.profile).includes('Salons'));
  });

  test('with no profile and no labels the answer is insufficient, and the prompt text is empty', async () => {
    const bc = await loadBusinessContext(8862);
    assert.equal(bc.status, 'insufficient');
    assert.equal(businessContextPrompt(bc), '');
  });

  test('an unknown project and a missing id are reported, not guessed', async () => {
    assert.equal((await loadBusinessContext(999)).status, 'no-site');
    assert.equal((await loadBusinessContext(null)).status, 'no-site');
  });

  test('each agent receives only its own slice', async () => {
    profiles[8872] = zennly();
    const tr = await loadBusinessContext(8872, { agent: 'trend-radar' });
    const comp = await loadBusinessContext(8872, { agent: 'competitor' });
    assert.ok('customerProblems' in tr.slice && !('targetCustomers' in tr.slice));
    assert.ok('targetCustomers' in comp.slice && !('customerProblems' in comp.slice));
  });
});

describe('businessContextPrompt', () => {
  test('legacy and partial contexts leave prompts exactly as they were', async () => {
    legacy[8872] = { industry: 'wellness', industry_source: 'detected' };
    assert.equal(businessContextPrompt(await loadBusinessContext(8872)), '');
  });

  test('a canonical profile states the separated concepts, and says when a person has not confirmed it yet', async () => {
    profiles[8872] = zennly();
    const text = businessContextPrompt(await loadBusinessContext(8872));
    assert.match(text, /^About this company \(detected from the company's own website; not yet confirmed by a person\):/);
    assert.match(text, /own industry: Software \(SaaS\)/);
  });

  test('a confirmed profile carries no caveat', () => {
    const confirmed = bp.applyReview(zennly().profile, ['ownIndustry', 'productsServices', 'targetCustomers'].map((field) => ({ field, accept: true })), { userId: 1 }).profile;
    const text = businessContextPrompt({ status: 'canonical', state: 'confirmed', description: bp.describeCompany(confirmed) });
    assert.match(text, /^About this company: /);
  });
});

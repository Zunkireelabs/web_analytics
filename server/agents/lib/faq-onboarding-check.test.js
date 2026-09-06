import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

const SITE = {
  id: 1, repo_owner: 'Zunkireelabs', repo_name: 'zunkireelabs-web',
  visible_faq_baseline: 0,
  website_domain: 'zunkireelabs.com',
};

let currentSite;
let anyFaqDraftEver;
let homepageHtml;
let homepageAnalysis;
let topQueries;
let existingRec;
let inserted;

const realRead = await import(resolve('../../store/read.js'));
mock.module(resolve('../../store/read.js'), {
  namedExports: {
    ...realRead,
    getSiteById: async () => currentSite,
    getQueriesForPage: async () => topQueries,
  },
});
const realDrafts = await import(resolve('../../store/drafts.js'));
mock.module(resolve('../../store/drafts.js'), {
  namedExports: { ...realDrafts, hasAnyFaqDraftEver: async () => anyFaqDraftEver },
});
const realPageContent = await import(resolve('./page-content.js'));
mock.module(resolve('./page-content.js'), {
  namedExports: {
    ...realPageContent,
    fetchHtml: async () => (homepageHtml == null ? { ok: false, error: 'unreachable' } : { ok: true, html: homepageHtml }),
    analyzePageUrl: async () => (homepageAnalysis == null ? { ok: false, error: 'unreachable' } : { ok: true, analysis: homepageAnalysis }),
  },
});
const realRecommendations = await import(resolve('../../store/recommendations.js'));
mock.module(resolve('../../store/recommendations.js'), {
  namedExports: {
    ...realRecommendations,
    findOpenRecommendation: async () => existingRec,
    insertRecommendation: async (siteId, payload) => { inserted.push(payload); return { id: 999 }; },
  },
});

const { checkFaqOnboardingCoverage } = await import(resolve('./faq-onboarding-check.js'));

beforeEach(() => {
  currentSite = { ...SITE };
  anyFaqDraftEver = false;
  homepageHtml = '<html><body><p>Welcome to Zunkiree Labs.</p></body></html>';
  homepageAnalysis = { title: 'Zunkiree Labs — AI-Native Search' };
  topQueries = [];
  existingRec = null;
  inserted = [];
});

describe('checkFaqOnboardingCoverage', () => {
  test('a site with no repo connected is skipped, not crashed', async () => {
    const result = await checkFaqOnboardingCoverage(2, { site: { id: 2 } });
    assert.equal(result.checked, false);
    assert.equal(result.reason, 'no-repo');
    assert.equal(inserted.length, 0);
  });

  test('a real recorded FAQ baseline means "already has FAQ" — no fetch, no recommendation', async () => {
    currentSite.visible_faq_baseline = 3;
    const result = await checkFaqOnboardingCoverage(1, { site: currentSite });
    assert.equal(result.hasFaq, true);
    assert.equal(result.reason, 'baseline');
    assert.equal(inserted.length, 0);
  });

  test('this tool having already shipped a real FAQ draft means "already has FAQ"', async () => {
    anyFaqDraftEver = true;
    const result = await checkFaqOnboardingCoverage(1, { site: currentSite });
    assert.equal(result.hasFaq, true);
    assert.equal(result.reason, 'already-shipped');
    assert.equal(inserted.length, 0);
  });

  test('an organic FAQ pattern on the live homepage means "already has FAQ" — never re-generated', async () => {
    homepageHtml = '<div class="faq-item" x-data="{ activeIndex: null }"><h3>Frequently asked questions</h3></div>';
    const result = await checkFaqOnboardingCoverage(1, { site: currentSite });
    assert.equal(result.hasFaq, true);
    assert.equal(result.reason, 'organic-signal-on-homepage');
    assert.equal(inserted.length, 0);
  });

  test('genuinely zero FAQ coverage anywhere creates ONE homepage FAQ recommendation, grounded in a real GSC query when one exists', async () => {
    topQueries = [{ query: 'ai native search nepal', clicks: 12, impressions: 300 }];
    const result = await checkFaqOnboardingCoverage(1, { site: currentSite });
    assert.equal(result.created, true);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].recommendationType, 'faq');
    assert.equal(inserted[0].params.query, 'ai native search nepal');
    assert.equal(inserted[0].params.page, 'https://zunkireelabs.com/');
  });

  test('a brand-new client with no GSC history yet still gets a real, grounded FAQ — via the homepage\'s own real title, never an invented topic', async () => {
    topQueries = [];
    const result = await checkFaqOnboardingCoverage(1, { site: currentSite });
    assert.equal(result.created, true);
    assert.equal(inserted[0].params.topic, 'Zunkiree Labs — AI-Native Search');
    assert.equal(inserted[0].params.query, undefined);
  });

  test('an already-open recommendation for this exact page/generator is never duplicated', async () => {
    existingRec = { id: 42 };
    const result = await checkFaqOnboardingCoverage(1, { site: currentSite });
    assert.equal(result.created, false);
    assert.equal(result.reason, 'already-recommended');
    assert.equal(inserted.length, 0);
  });

  test('an unreachable homepage is reported honestly, never treated as "has FAQ" or "needs FAQ"', async () => {
    homepageHtml = null;
    const result = await checkFaqOnboardingCoverage(1, { site: currentSite });
    assert.equal(result.checked, false);
    assert.equal(result.reason, 'homepage-unreachable');
    assert.equal(inserted.length, 0);
  });
});

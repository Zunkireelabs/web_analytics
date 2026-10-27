import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// Regression coverage for the audit finding: no route-level test file
// existed for keywords.js at all — the gap-approval PUT route (the ONLY
// keyword -> Action Center path in the app) and the newer growth-
// opportunities generate-draft route were both untested at the HTTP layer,
// and no test confirmed the router is actually staff-only.
//
// Every store/agent import is mocked narrow, same discipline as
// analyst-sync.test.js: analyst-seo-mapping.js and action-center.js both
// reach a transitive dependency (formdata-node/web-streams-polyfill, via
// llm.js -> openai) that fails to instantiate under node:test's module
// mocking, so real imports of either are never safe in a test file.
let capturedRecommendationCall;
let classification; // what the relevance classifier returns for a typed keyword (null = it failed)
const storeSiteIds = {};
let capturedGenerateDraftCall;
let gapApprovalResult;
let opportunityAction;
let generateDraftResult;
let generateDraftError;

mock.module(resolve('../agents/lib/analyst-seo-mapping.js'), {
  namedExports: {
    createActionCenterRecommendationForGap: async (siteId, gap, opts) => {
      capturedRecommendationCall = { siteId, gap, opts };
      return gapApprovalResult;
    },
    classifyGapRelevance: async () => { if (!classification) throw new Error('classifier down'); return classification; },
    buildProductTopicMap: async () => ({ capabilities: [], unmapped: { clusters: [], gaps: [] } }),
    opportunityDraftEligibility: (site, opportunity) => opportunityAction,
    recommendedActionForGap: (gap) => ({ kind: gap.coverage_status === 'duplicate' ? 'none' : 'blog-post', label: 'stub' }),
  },
});

mock.module(resolve('../agents/lib/growth-opportunities.js'), {
  namedExports: { buildGrowthOpportunities: async () => ({}) },
});

mock.module(resolve('./action-center.js'), {
  namedExports: {
    generateDraft: async (siteId, opts) => {
      capturedGenerateDraftCall = { siteId, opts };
      if (generateDraftError) throw generateDraftError;
      return generateDraftResult;
    },
  },
});

let siteById;
let queryPageRows = [];
mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => siteById, getSiteStatus: async () => null, getQueryPageMetrics: async () => queryPageRows },
});
let gscAsOf = '2026-10-25';
mock.module(resolve('../store/data-freshness.js'), { namedExports: { gscDailyDataAsOf: async () => ({ as_of: gscAsOf, rows_total: gscAsOf ? 10 : 0 }) } });
let inventoryRows = [];
mock.module(resolve('../store/page-inventory.js'), { namedExports: { listPageInventory: async () => inventoryRows } });

let updatedGap;
let gapRows = [];
let gapPlanRow;
let statusCalls = [];
let planWrites = [];
mock.module(resolve('../store/data-analyst.js'), {
  namedExports: {
    getKeywordClusters: async () => [],
    getKeywordGaps: async (siteId) => { storeSiteIds.gaps = siteId; return gapRows; },
    updateKeywordGapStatus: async (siteId, gapId, status) => { storeSiteIds.update = siteId; statusCalls.push(status); return updatedGap; },
    getGapContentPlan: async () => gapPlanRow,
    setGapContentPlan: async (siteId, gapId, plan) => { planWrites.push([siteId, gapId, plan]); return true; },
    getSiteProfile: async () => null,
    getLatestKeywordNarrative: async () => null,
    getAnomalyAlerts: async () => [],
    getLatestForecastStatuses: async () => [],
    getLatestLayoutSuggestion: async () => null,
    saveLayoutSuggestion: async () => ({ generated_at: null }),
    createUserKeywordGap: async (siteId) => { storeSiteIds.create = siteId; return { id: 11, topic: 'best crm' }; },
    getProductCapabilities: async () => [],
    createProductCapability: async () => ({}),
    updateProductCapabilityStatus: async () => ({}),
  },
});

mock.module(resolve('../llm.js'), {
  namedExports: { callLLM: async () => { throw new Error('layout suggestion LLM is not exercised by these tests'); } },
});

let actingUser;
mock.module(resolve('../store/users.js'), {
  namedExports: {
    getUserById: async () => actingUser,
    getUserByEmail: async () => { throw new Error('not exercised by these tests'); },
    updateUserPassword: async () => { throw new Error('not exercised by these tests'); },
    getUserStatus: async () => { throw new Error('not exercised by these tests'); },
  },
});

const { default: keywordsRouter, clientKeywordsRouter } = await import('./keywords.js');
const { requireAuth, requirePlatformRole } = await import('./login.js');

function findRoute(method, path) {
  const layer = keywordsRouter.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${path} not registered`);
  // The actual handler is the last function in the route's own middleware
  // stack (after any route-specific middleware — none here today).
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function mockRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

beforeEach(() => {
  capturedRecommendationCall = undefined;
  capturedGenerateDraftCall = undefined;
  gapApprovalResult = { eligible: true, created: true, recommendationId: 1, draftId: 5 };
  opportunityAction = null;
  generateDraftResult = { id: 42, status: 'ready' };
  generateDraftError = null;
  siteById = { id: 1 };
  updatedGap = { id: 1, topic: 'best crm software', status: 'approved' };
  actingUser = { role: 'platform_admin' };
  classification = { searchIntent: 'informational', productRelevance: 'direct' };
  queryPageRows = [];
  gscAsOf = '2026-10-25';
  inventoryRows = [];
  gapPlanRow = { id: 4, topic: 'seo for law firms', content_plan: null };
  statusCalls = [];
  planWrites = [];
  gapRows = [];
});

describe('keywords router — staff-only gate', () => {
  test('requireAuth is the router-wide first middleware — every route below is behind session auth', () => {
    const authLayer = keywordsRouter.stack.find((l) => !l.route);
    assert.equal(authLayer.handle, requireAuth);
  });

  test('requirePlatformRole(platform_admin) 404s a non-admin — the exact gate keywords.js and dataAnalyst.js both rely on', async () => {
    const originalCompanySiteId = process.env.COMPANY_SITE_ID;
    process.env.COMPANY_SITE_ID = '1';
    try {
      const gate = requirePlatformRole('platform_admin');
      actingUser = { role: 'tenant_admin' };
      const res = mockRes();
      let nextErr = 'not called';
      await gate({ siteId: 1, userId: 9 }, res, (e) => { nextErr = e; });
      assert.equal(res.statusCode, 404, 'a non-admin gets a 404, not a 403 — no route-existence signal leaks');
      assert.equal(nextErr, 'not called');
    } finally {
      process.env.COMPANY_SITE_ID = originalCompanySiteId;
    }
  });

  test('requirePlatformRole(platform_admin) 404s a request against a non-internal site, even for a real platform_admin', async () => {
    const originalCompanySiteId = process.env.COMPANY_SITE_ID;
    process.env.COMPANY_SITE_ID = '1';
    try {
      const gate = requirePlatformRole('platform_admin');
      actingUser = { role: 'platform_admin' };
      const res = mockRes();
      await gate({ siteId: 999, userId: 9 }, res, () => {});
      assert.equal(res.statusCode, 404);
    } finally {
      process.env.COMPANY_SITE_ID = originalCompanySiteId;
    }
  });

  test('requirePlatformRole(platform_admin) passes a real platform_admin on the internal site through to next()', async () => {
    const originalCompanySiteId = process.env.COMPANY_SITE_ID;
    process.env.COMPANY_SITE_ID = '1';
    try {
      const gate = requirePlatformRole('platform_admin');
      actingUser = { role: 'platform_admin' };
      const res = mockRes();
      let called = false;
      await gate({ siteId: 1, userId: 9 }, res, (e) => { if (!e) called = true; });
      assert.equal(called, true);
      assert.equal(res.body, undefined, 'next() ran — no response was sent by the gate itself');
    } finally {
      process.env.COMPANY_SITE_ID = originalCompanySiteId;
    }
  });
});

describe('PUT /internal/keywords/:siteId/gaps/:gapId — the keyword -> Action Center path', () => {
  const handler = findRoute('put', '/internal/keywords/:siteId/gaps/:gapId');

  test('approving a gap calls createActionCenterRecommendationForGap with the freshly-updated gap row', async () => {
    const res = mockRes();
    await handler({ params: { siteId: '1', gapId: '1' }, body: { status: 'approved' } }, res, (e) => { throw e; });
    assert.ok(capturedRecommendationCall, 'createActionCenterRecommendationForGap was not called');
    assert.equal(capturedRecommendationCall.siteId, '1');
    assert.deepEqual(capturedRecommendationCall.gap, updatedGap);
    assert.deepEqual(res.body.actionCenter, gapApprovalResult);
  });

  test('rejecting a gap does NOT call createActionCenterRecommendationForGap — only approval drafts', async () => {
    updatedGap = { id: 1, topic: 'best crm software', status: 'rejected' };
    const res = mockRes();
    await handler({ params: { siteId: '1', gapId: '1' }, body: { status: 'rejected' } }, res, (e) => { throw e; });
    assert.equal(capturedRecommendationCall, undefined);
    assert.equal(res.body.actionCenter, null);
  });

  test('an invalid status is rejected with 400 before touching the store', async () => {
    const res = mockRes();
    let error;
    await handler({ params: { siteId: '1', gapId: '1' }, body: { status: 'not-a-real-status' } }, res, (e) => { error = e; });
    assert.equal(error?.status, 400);
    assert.equal(capturedRecommendationCall, undefined);
  });

  test('a gap that does not exist (or belongs to another site) 404s', async () => {
    updatedGap = null;
    const res = mockRes();
    let error;
    await handler({ params: { siteId: '1', gapId: '999' }, body: { status: 'approved' } }, res, (e) => { error = e; });
    assert.equal(error?.status, 404);
  });
});

describe('POST /internal/keywords/:siteId/growth-opportunities/generate-draft', () => {
  const handler = findRoute('post', '/internal/keywords/:siteId/growth-opportunities/generate-draft');

  test('an ineligible opportunity 400s and never reaches generateDraft', async () => {
    opportunityAction = null;
    const res = mockRes();
    let error;
    await handler({ params: { siteId: '1' }, body: { opportunity: { type: 'content-gap' } } }, res, (e) => { error = e; });
    assert.equal(error?.status, 400);
    assert.equal(capturedGenerateDraftCall, undefined);
  });

  test('an unknown site 404s', async () => {
    siteById = null;
    const res = mockRes();
    let error;
    await handler({ params: { siteId: '999' }, body: { opportunity: { type: 'quick-win' } } }, res, (e) => { error = e; });
    assert.equal(error?.status, 404);
  });

  test('an eligible opportunity calls generateDraft with the mapped generator/params/findingId', async () => {
    opportunityAction = { generatorId: 'meta-title', params: { page: 'https://example.com/p', query: 'q' }, findingId: 'growth-opportunity:quick-win:https://example.com/p:q' };
    const res = mockRes();
    await handler({ params: { siteId: '1' }, body: { opportunity: { type: 'quick-win', page: 'https://example.com/p', query: 'q' } } }, res, (e) => { throw e; });
    assert.equal(capturedGenerateDraftCall.siteId, 1);
    assert.equal(capturedGenerateDraftCall.opts.generatorId, 'meta-title');
    assert.deepEqual(capturedGenerateDraftCall.opts.params, { page: 'https://example.com/p', query: 'q' });
    assert.equal(capturedGenerateDraftCall.opts.findingId, opportunityAction.findingId);
    assert.equal(capturedGenerateDraftCall.opts.source, 'analyst-growth-opportunity');
    assert.deepEqual(res.body, generateDraftResult);
  });

  test('a generateDraft failure propagates as a real error, not a silently-swallowed 200', async () => {
    opportunityAction = { generatorId: 'expand-content', params: { page: 'https://example.com/p' }, findingId: 'x' };
    generateDraftError = new Error('quality gate failed');
    const res = mockRes();
    let error;
    await handler({ params: { siteId: '1' }, body: { opportunity: { type: 'page1-opportunity', page: 'https://example.com/p' } } }, res, (e) => { error = e; });
    assert.equal(error?.message, 'quality gate failed');
  });
});

describe('GET /internal/keywords/:siteId/gaps', () => {
  test('annotates every gap with the action the backend would really take', async () => {
    gapRows = [{ id: 1, topic: 'a', coverage_status: 'duplicate' }, { id: 2, topic: 'b', coverage_status: 'opportunity' }];
    const res = mockRes();
    await findRoute('get', '/internal/keywords/:siteId/gaps')({ params: { siteId: '1' }, query: {} }, res, (e) => { throw e; });
    assert.deepEqual(res.body.map((g) => g.recommended_action.kind), ['none', 'blog-post']);
    assert.equal(res.body[0].coverage_status, 'duplicate'); // original fields preserved
    gapRows = [];
  });
});

describe('POST /internal/keywords/:siteId/translate', () => {
  test('rejects a non-array body instead of calling anything', async () => {
    let err;
    await findRoute('post', '/internal/keywords/:siteId/translate')({ params: { siteId: '1' }, body: { terms: 'bedrijf' } }, mockRes(), (e) => { err = e; });
    assert.equal(err.status, 400);
  });
});

// The client mirror: the same handlers, but always the session's own site.
describe('client mirror — /keywords/... (every client, their own site only)', () => {
  const clientRoute = (method, path) => {
    const layer = clientKeywordsRouter.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    if (!layer) throw new Error(`client route ${method.toUpperCase()} ${path} not registered`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };

  test('requireAuth guards /keywords only — the prefix, so no other router is touched', () => {
    const authLayer = clientKeywordsRouter.stack.find((l) => !l.route);
    assert.equal(authLayer.handle, requireAuth);
    assert.ok(authLayer.regexp.test('/keywords/gaps'));
    assert.ok(!authLayer.regexp.test('/internal/keywords/1/gaps'));
    assert.ok(!authLayer.regexp.test('/analyst/dashboard'));
  });

  test('the staff-only layout-suggestion route (an LLM call) is not exposed to clients', () => {
    const paths = clientKeywordsRouter.stack.filter((l) => l.route).map((l) => l.route.path);
    assert.ok(!paths.some((p) => p.includes('layout')));
    assert.ok(paths.includes('/keywords/gaps') && paths.includes('/keywords/topic-map'));
  });

  test('reading gaps uses the SESSION site, whatever the URL param says', async () => {
    gapRows = [{ id: 1, topic: 'crm', coverage_status: 'new' }];
    const res = mockRes();
    await clientRoute('get', '/keywords/gaps')({ siteId: 7, params: { siteId: '999' }, query: {} }, res, () => {});
    assert.equal(storeSiteIds.gaps, '7');
    assert.equal(res.body.length, 1);
  });

  test('adding a keyword writes it to the session site', async () => {
    await clientRoute('post', '/keywords/gaps')({ siteId: 7, params: { siteId: '999' }, body: { topic: 'best crm' } }, mockRes(), () => {});
    assert.equal(storeSiteIds.create, '7');
  });

  test('approving a gap acts on the session site and creates the Action Center item there', async () => {
    const res = mockRes();
    await clientRoute('put', '/keywords/gaps/:gapId')({ siteId: 7, params: { siteId: '999', gapId: '4' }, body: { status: 'approved' } }, res, () => {});
    assert.equal(storeSiteIds.update, '7');
    assert.equal(capturedRecommendationCall.siteId, '7');
  });
});


// ───────── the Keywords page ─────────

describe('GET /internal/keywords/:siteId/overview', () => {
  const overview = (siteId = '1') => { const res = mockRes(); return findRoute('get', '/internal/keywords/:siteId/overview')({ params: { siteId } }, res, (e) => { throw e; }).then(() => res.body); };

  test('what the site has comes from Search Console rows; what it lacks from the collected gaps', async () => {
    queryPageRows = [{ query: 'ai seo agent', page: 'https://x.test/', clicks: 10, impressions: 500, avgPosition: 9 }];
    gapRows = [{ id: 1, topic: 'llms.txt generator', status: 'pending_review', search_volume: 720 }, { id: 2, topic: 'ai seo agent', status: 'pending_review' }];
    const body = await overview();
    assert.equal(body.summary.keywords, 1);
    assert.equal(body.have[0].keyword, 'ai seo agent');
    assert.deepEqual(body.notYet.map((r) => r.keyword), ['llms.txt generator']);
    assert.equal(body.notYet[0].potential, 180);
    assert.deepEqual(body.window, { start: '2026-09-28', end: '2026-10-25' });
  });
  test('a project with no Search Console data yet gets empty lists, not an error', async () => {
    gscAsOf = null;
    const body = await overview();
    assert.deepEqual(body.have, []);
    assert.equal(body.window, null);
  });
  test('isProduct follows the project type, and industries are collected only for a product', async () => {
    siteById = { id: 1, property_type: 'product' };
    assert.equal((await overview()).isProduct, true);
    siteById = { id: 1, property_type: 'website' };
    const body = await overview();
    assert.equal(body.isProduct, false);
    assert.deepEqual(body.industries, []);
  });
});

describe('GET /internal/keywords/:siteId/pages', () => {
  test('groups the keywords by page and lists pages with none', async () => {
    queryPageRows = [{ query: 'a', page: 'https://x.test/', clicks: 1, impressions: 10, avgPosition: 4 }];
    inventoryRows = [{ page: 'https://x.test/', first_seen_at: '2026-01-01' }, { page: 'https://x.test/careers', first_seen_at: '2026-01-01' }, { page: 'https://x.test/privacy', first_seen_at: '2026-01-01' }];
    const res = mockRes();
    await findRoute('get', '/internal/keywords/:siteId/pages')({ params: { siteId: '1' } }, res, (e) => { throw e; });
    assert.equal(res.body.pages.length, 1);
    assert.deepEqual(res.body.none.map((n) => n.path), ['/careers']);
    assert.equal(res.body.summary.skipped, 1);
  });
});

describe('POST /internal/keywords/:siteId/recommend', () => {
  const recommend = (body) => { const res = mockRes(); let err; return findRoute('post', '/internal/keywords/:siteId/recommend')({ params: { siteId: '1' }, body }, res, (e) => { err = e; }).then(() => ({ res, err })); };

  test('a learning search is a blog post, and nothing is written', async () => {
    const { res } = await recommend({ topic: 'seo for law firms' });
    assert.equal(res.body.plan, 'blog');
    assert.equal(res.body.intent, 'informational');
    assert.equal(statusCalls.length, 0);
  });
  test('a buying search on something the site sells is a landing page', async () => {
    classification = { searchIntent: 'commercial', productRelevance: 'direct' };
    assert.equal((await recommend({ topic: 'salon booking software' })).res.body.plan, 'landing');
  });
  test('a keyword the site already ranks for is just tracked, without asking the classifier', async () => {
    queryPageRows = [{ query: 'ai seo agent', page: 'https://x.test/', clicks: 1, impressions: 50, avgPosition: 9 }];
    classification = null; // would throw if it were called
    const { res } = await recommend({ topic: '  AI SEO Agent ' });
    assert.equal(res.body.plan, 'track');
    assert.equal(res.body.alreadyRanks, true);
  });
  test('when the classifier is down it still answers, with a safe blog suggestion', async () => {
    classification = null;
    assert.equal((await recommend({ topic: 'something new' })).res.body.plan, 'blog');
  });
  test('an empty or over-long keyword is refused', async () => {
    assert.equal((await recommend({ topic: '  ' })).err.status, 400);
    assert.equal((await recommend({ topic: 'x'.repeat(201) })).err.status, 400);
  });
});

describe('POST /internal/keywords/:siteId/gaps/:gapId/plan', () => {
  const plan = (body, gapId = '4') => { const res = mockRes(); let err; return findRoute('post', '/internal/keywords/:siteId/gaps/:gapId/plan')({ params: { siteId: '1', gapId }, body }, res, (e) => { err = e; }).then(() => ({ res, err })); };

  test('only blog, landing and track are accepted', async () => {
    assert.equal((await plan({ plan: 'both' })).err.status, 400);
    assert.equal((await plan({})).err.status, 400);
  });
  test('track keeps the keyword and creates nothing', async () => {
    const { res } = await plan({ plan: 'track' });
    assert.equal(res.body.plan, 'track');
    assert.equal(capturedRecommendationCall, undefined);
    assert.deepEqual(planWrites, [['1', '4', 'track']]);
    assert.deepEqual(statusCalls, ['approved']);
  });
  test('blog queues one blog for the daily run, flagged as requested by the person', async () => {
    const { res } = await plan({ plan: 'blog' });
    assert.equal(res.body.plan, 'blog');
    assert.deepEqual(capturedRecommendationCall.opts, { deferDraft: true, clientRequested: true, plan: 'blog' });
    assert.deepEqual(planWrites, [['1', '4', 'blog']]);
  });
  test('landing is drafted now (the daily run never picks up a manual-tier page), not flagged as a requested blog', async () => {
    await plan({ plan: 'landing' });
    assert.deepEqual(capturedRecommendationCall.opts, { deferDraft: false, clientRequested: false, plan: 'landing' });
    assert.deepEqual(planWrites, [['1', '4', 'landing']]);
  });
  test('planning the same thing twice queues nothing the second time', async () => {
    gapPlanRow = { id: 4, topic: 'x', content_plan: 'blog' };
    const { res } = await plan({ plan: 'blog' });
    assert.equal(res.body.alreadyPlanned, true);
    assert.equal(capturedRecommendationCall, undefined);
  });
  test('a different choice for something already planned is refused with what to do', async () => {
    gapPlanRow = { id: 4, topic: 'x', content_plan: 'blog' };
    const { err } = await plan({ plan: 'landing' });
    assert.equal(err.status, 409);
    assert.match(err.message, /blog post/);
    assert.equal(capturedRecommendationCall, undefined);
  });
  test('tracked can still be turned into a blog or a landing page later', async () => {
    gapPlanRow = { id: 4, topic: 'x', content_plan: 'track' };
    assert.equal((await plan({ plan: 'landing' })).res.body.plan, 'landing');
  });
  test('if nothing could be created the choice is not saved and the gap goes back to pending', async () => {
    gapApprovalResult = { eligible: false, dropped: 'already-covered' };
    const { res } = await plan({ plan: 'blog' });
    assert.equal(res.body.notCreated, true);
    assert.equal(res.body.plan, null);
    assert.deepEqual(planWrites, []);
    assert.deepEqual(statusCalls, ['approved', 'pending_review']);
  });
  test('a blocked recommendation (for example no place to publish pages) is saved and says why', async () => {
    gapApprovalResult = { eligible: true, created: true, recommendationId: 9, draftId: null, blockedReason: 'No landing page folder is set up.' };
    const { res } = await plan({ plan: 'landing' });
    assert.equal(res.body.actionCenter.blockedReason, 'No landing page folder is set up.');
    assert.deepEqual(planWrites, [['1', '4', 'landing']]);
  });
  test('an unknown keyword is a 404', async () => {
    gapPlanRow = null;
    assert.equal((await plan({ plan: 'track' })).err.status, 404);
  });
});

describe('POST /internal/keywords/:siteId/gaps with a plan', () => {
  const add = (body) => { const res = mockRes(); let err; return findRoute('post', '/internal/keywords/:siteId/gaps')({ params: { siteId: '1' }, body }, res, (e) => { err = e; }).then(() => ({ res, err })); };
  test('adding a keyword with a choice saves it and carries the choice out in one step', async () => {
    gapPlanRow = { id: 11, topic: 'best crm', content_plan: null };
    const { res } = await add({ topic: 'best crm', plan: 'landing' });
    assert.equal(res.body.planned.plan, 'landing');
    assert.deepEqual(planWrites, [['1', 11, 'landing']]);
  });
  test('without a choice it behaves as before: a pending gap and nothing queued', async () => {
    const { res } = await add({ topic: 'best crm' });
    assert.equal(res.body.planned, undefined);
    assert.equal(capturedRecommendationCall, undefined);
  });
  test('an unknown choice is refused before anything is saved', async () => {
    assert.equal((await add({ topic: 'best crm', plan: 'both' })).err.status, 400);
  });
});

describe('the new routes on the client mirror', () => {
  test('overview, pages, recommend and plan are exposed to every client, on their own site only', async () => {
    const paths = clientKeywordsRouter.stack.filter((l) => l.route).map((l) => l.route.path);
    for (const p of ['/keywords/overview', '/keywords/pages', '/keywords/recommend', '/keywords/gaps/:gapId/plan']) assert.ok(paths.includes(p), p);
    const layer = clientKeywordsRouter.stack.find((l) => l.route?.path === '/keywords/overview');
    gscAsOf = null;
    const res = mockRes();
    await layer.route.stack[layer.route.stack.length - 1].handle({ siteId: 7, params: { siteId: '999' } }, res, (e) => { throw e; });
    assert.deepEqual(res.body.have, []);
  });
});

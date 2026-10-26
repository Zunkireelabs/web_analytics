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
const storeSiteIds = {};
let capturedGenerateDraftCall;
let gapApprovalResult;
let opportunityAction;
let generateDraftResult;
let generateDraftError;

mock.module(resolve('../agents/lib/analyst-seo-mapping.js'), {
  namedExports: {
    createActionCenterRecommendationForGap: async (siteId, gap) => {
      capturedRecommendationCall = { siteId, gap };
      return gapApprovalResult;
    },
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
mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => siteById, getSiteStatus: async () => null },
});

let updatedGap;
let gapRows = [];
mock.module(resolve('../store/data-analyst.js'), {
  namedExports: {
    getKeywordClusters: async () => [],
    getKeywordGaps: async (siteId) => { storeSiteIds.gaps = siteId; return gapRows; },
    updateKeywordGapStatus: async (siteId) => { storeSiteIds.update = siteId; return updatedGap; },
    getSiteProfile: async () => null,
    getLatestKeywordNarrative: async () => null,
    getAnomalyAlerts: async () => [],
    getLatestForecastStatuses: async () => [],
    getLatestLayoutSuggestion: async () => null,
    saveLayoutSuggestion: async () => ({ generated_at: null }),
    createUserKeywordGap: async (siteId) => { storeSiteIds.create = siteId; return {}; },
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

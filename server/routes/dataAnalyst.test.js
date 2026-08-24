import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// Regression coverage for the audit finding: no route-level test file
// existed for dataAnalyst.js — the resolve/dismiss endpoints (the "Fixed"/
// dismiss buttons on the Analyst page) and the insights generate-draft
// route were untested at the HTTP layer, and nothing confirmed the actor
// (resolved_by/dismissed_by) is actually threaded through to the Python
// service rather than silently dropped.

let actingUser;
mock.module(resolve('../store/users.js'), {
  namedExports: {
    getUserById: async () => actingUser,
    getUserByEmail: async () => { throw new Error('not exercised by these tests'); },
    updateUserPassword: async () => { throw new Error('not exercised by these tests'); },
    getUserStatus: async () => { throw new Error('not exercised by these tests'); },
  },
});

let siteById;
mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => siteById, getSiteStatus: async () => null },
});

let capturedPythonCall;
let pythonResult;
let pythonError;
mock.module(resolve('../lib/data-analyst-client.js'), {
  namedExports: {
    callDataAnalystAgent: async (path, opts) => {
      capturedPythonCall = { path, opts };
      if (pythonError) throw pythonError;
      return pythonResult;
    },
  },
});

mock.module(resolve('../report/insight-doc.js'), {
  namedExports: { createInsightReportDoc: async () => { throw new Error('not exercised by these tests'); } },
});

let seoAction;
mock.module(resolve('../agents/lib/analyst-seo-mapping.js'), {
  namedExports: { seoDraftEligibility: () => seoAction },
});

let capturedGenerateDraftCall;
let generateDraftResult;
mock.module(resolve('./action-center.js'), {
  namedExports: {
    generateDraft: async (siteId, opts) => {
      capturedGenerateDraftCall = { siteId, opts };
      return generateDraftResult;
    },
  },
});

const dataAnalystRouter = (await import('./dataAnalyst.js')).default;
const { requireAuth } = await import('./login.js');

function findRoute(method, path) {
  const layer = dataAnalystRouter.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${path} not registered`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function mockRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

beforeEach(() => {
  actingUser = { email: 'staff@zunkireelabs.com', role: 'platform_admin' };
  siteById = { id: 1 };
  capturedPythonCall = undefined;
  pythonResult = { ok: true };
  pythonError = null;
  seoAction = null;
  capturedGenerateDraftCall = undefined;
  generateDraftResult = { id: 42, status: 'ready' };
});

describe('dataAnalyst router — staff-only gate', () => {
  test('requireAuth is the router-wide first middleware — same gate as keywords.js', () => {
    const authLayer = dataAnalystRouter.stack.find((l) => !l.route);
    assert.equal(authLayer.handle, requireAuth);
  });
});

describe('POST .../recommendations/:id/resolve — the "Fixed" button', () => {
  const handler = findRoute('post', '/internal/analyst/clients/:clientId/recommendations/:recommendationId/resolve');

  test('forwards the acting staff member\'s email as resolved_by, not a generic flag', async () => {
    const res = mockRes();
    await handler({ params: { clientId: '1', recommendationId: '9' }, userId: 5 }, res, (e) => { throw e; });
    assert.equal(capturedPythonCall.path, '/clients/1/recommendations/9/resolve');
    assert.equal(capturedPythonCall.opts.method, 'POST');
    assert.equal(capturedPythonCall.opts.body.resolved_by, 'staff@zunkireelabs.com');
    assert.deepEqual(res.body, pythonResult);
  });

  test('a user record that failed to load still resolves the recommendation (resolved_by null, never a hard failure)', async () => {
    actingUser = null;
    const res = mockRes();
    await handler({ params: { clientId: '1', recommendationId: '9' }, userId: 5 }, res, (e) => { throw e; });
    assert.equal(capturedPythonCall.opts.body.resolved_by, null);
  });

  test('a Python-side failure propagates as a real error, not a silently-swallowed 200', async () => {
    pythonError = new Error('upstream 500');
    const res = mockRes();
    let error;
    await handler({ params: { clientId: '1', recommendationId: '9' }, userId: 5 }, res, (e) => { error = e; });
    assert.equal(error?.message, 'upstream 500');
  });
});

describe('POST .../recommendations/:id/dismiss', () => {
  const handler = findRoute('post', '/internal/analyst/clients/:clientId/recommendations/:recommendationId/dismiss');

  test('forwards the acting staff member\'s email as dismissed_by', async () => {
    const res = mockRes();
    await handler({ params: { clientId: '1', recommendationId: '9' }, userId: 5 }, res, (e) => { throw e; });
    assert.equal(capturedPythonCall.path, '/clients/1/recommendations/9/dismiss');
    assert.equal(capturedPythonCall.opts.body.dismissed_by, 'staff@zunkireelabs.com');
  });
});

describe('POST .../insights/generate-draft — the "Send to Action Center" button', () => {
  const handler = findRoute('post', '/internal/analyst/clients/:clientId/insights/generate-draft');

  test('an ineligible insight 400s and never reaches generateDraft', async () => {
    seoAction = null;
    const res = mockRes();
    let error;
    await handler({ params: { clientId: '1' }, body: { insight: {} } }, res, (e) => { error = e; });
    assert.equal(error?.status, 400);
    assert.equal(capturedGenerateDraftCall, undefined);
  });

  test('an unknown client 404s', async () => {
    siteById = null;
    const res = mockRes();
    let error;
    await handler({ params: { clientId: '999' }, body: { insight: {} } }, res, (e) => { error = e; });
    assert.equal(error?.status, 404);
  });

  test('an eligible insight calls generateDraft with the mapped generator/params and source "analyst"', async () => {
    seoAction = { generatorId: 'meta-title', params: { page: 'https://example.com/p', query: 'q' }, findingId: 'analyst:gsc_ctr:trend_shift:2026-08-18:https://example.com/p' };
    const res = mockRes();
    await handler({ params: { clientId: '1' }, body: { insight: { metric_key: 'gsc_ctr' } } }, res, (e) => { throw e; });
    assert.equal(capturedGenerateDraftCall.siteId, 1);
    assert.equal(capturedGenerateDraftCall.opts.generatorId, 'meta-title');
    assert.equal(capturedGenerateDraftCall.opts.source, 'analyst');
    assert.equal(capturedGenerateDraftCall.opts.findingId, seoAction.findingId);
    assert.deepEqual(res.body, generateDraftResult);
  });
});

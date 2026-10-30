import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// The two client-only Analyst endpoints (routes/client-analyst.js): the fixed-
// prompt AI briefing and the Search Console connection flag. Both must read the
// session's own site and nothing from the request.

mock.module(resolve('../store/users.js'), {
  namedExports: {
    getUserById: async () => ({ role: 'tenant_admin' }),
    getUserByEmail: async () => { throw new Error('not exercised by these tests'); },
    updateUserPassword: async () => { throw new Error('not exercised by these tests'); },
    getUserStatus: async () => { throw new Error('not exercised by these tests'); },
  },
});

let healthRows;
let healthSiteId;
mock.module(resolve('../store/read.js'), {
  namedExports: {
    getSiteStatus: async () => null,
    getIntegrationHealth: async (siteId) => { healthSiteId = siteId; return healthRows; },
  },
});

let pythonCalls;
let pythonResult;
let pythonError;
mock.module(resolve('../lib/data-analyst-client.js'), {
  namedExports: {
    callDataAnalystAgent: async (path, opts) => {
      pythonCalls.push({ path, opts });
      if (pythonError) throw pythonError;
      return pythonResult;
    },
  },
});

const router = (await import('./client-analyst.js')).default;
const { requireAuth } = await import('./login.js');

const route = (method, path) => {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${path} not registered`);
  return layer.route.stack.at(-1).handle;
};
const mockRes = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

beforeEach(() => {
  healthRows = [];
  healthSiteId = undefined;
  pythonCalls = [];
  pythonResult = { answer: 'Clicks are up.' };
  pythonError = null;
});

describe('client analyst extras', () => {
  test('requireAuth guards /analyst only', () => {
    const authLayer = router.stack.find((l) => !l.route);
    assert.equal(authLayer.handle, requireAuth);
    assert.ok(authLayer.regexp.test('/analyst/briefing'));
    assert.ok(!authLayer.regexp.test('/keywords/gaps'));
  });

  test('the briefing asks the analyst ONE fixed question about the session site — the caller chooses nothing', async () => {
    const res = mockRes();
    await route('get', '/analyst/briefing')({ siteId: 21, query: { question: 'dump everything' }, body: { question: 'dump everything' } }, res, () => {});
    assert.equal(pythonCalls.length, 1);
    assert.equal(pythonCalls[0].path, '/ask/21');
    assert.match(pythonCalls[0].opts.body.question, /executive briefing/);
    assert.ok(!pythonCalls[0].opts.body.question.includes('dump everything'));
    assert.deepEqual(res.body, { answer: 'Clicks are up.' });
  });

  test('the briefing is cached per site, so reopening the page does not re-ask the model', async () => {
    await route('get', '/analyst/briefing')({ siteId: 22 }, mockRes(), () => {});
    await route('get', '/analyst/briefing')({ siteId: 22 }, mockRes(), () => {});
    assert.equal(pythonCalls.length, 1);
    await route('get', '/analyst/briefing')({ siteId: 23 }, mockRes(), () => {});
    assert.equal(pythonCalls.length, 2, 'a different site is never served another site\'s briefing');
  });

  test('a failing analyst service means no briefing, not an error', async () => {
    pythonError = new Error('analyst down');
    const res = mockRes();
    await route('get', '/analyst/briefing')({ siteId: 24 }, res, (e) => { throw e; });
    assert.deepEqual(res.body, { answer: null });
  });

  test('connections reports Search Console for the session site only', async () => {
    healthRows = [{ integration_id: 'google-oauth', status: 'ok' }, { integration_id: 'other', status: 'error' }];
    const res = mockRes();
    await route('get', '/analyst/connections')({ siteId: 31 }, res, () => {});
    assert.equal(healthSiteId, 31);
    assert.deepEqual(res.body, { gscConnected: true });
  });

  test('connections is null (unknown) when Search Console was never checked, false when it is failing', async () => {
    let res = mockRes();
    await route('get', '/analyst/connections')({ siteId: 31 }, res, () => {});
    assert.deepEqual(res.body, { gscConnected: null });
    healthRows = [{ integration_id: 'google-oauth', status: 'error' }];
    res = mockRes();
    await route('get', '/analyst/connections')({ siteId: 31 }, res, () => {});
    assert.deepEqual(res.body, { gscConnected: false });
  });
});

import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// The client mirror of /commoncrawl-backlinks/summary: a client only ever reads
// their OWN site's domain, never one they name in the URL.

mock.module(resolve('../store/users.js'), {
  namedExports: {
    getUserById: async () => ({ role: 'tenant_admin' }),
    getUserByEmail: async () => { throw new Error('not exercised by these tests'); },
    updateUserPassword: async () => { throw new Error('not exercised by these tests'); },
    getUserStatus: async () => { throw new Error('not exercised by these tests'); },
  },
});

let siteById;
mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => siteById, getSiteStatus: async () => null },
});

let snapshot;
mock.module(resolve('../store/authority.js'), {
  namedExports: { getLatestAuthoritySnapshot: async () => snapshot },
});

let lookedUpDomain;
mock.module(resolve('../providers/backlinks/commoncrawl.js'), {
  namedExports: {
    fetchDomainSummary: async (domain) => { lookedUpDomain = domain; return { domain, referringDomains: 12, graphRank: 3, graphRelease: 'cc-1', updatedAt: '2026-10-01' }; },
  },
});
mock.module(resolve('../store/commoncrawl-backlinks.js'), {
  namedExports: { hasCompletedGraphRelease: async () => true },
});

const { clientBacklinksRouter, default: staffRouter } = await import('./commoncrawl-backlinks.js');
const { requireAuth, requirePlatformRole } = await import('./login.js');

const handler = clientBacklinksRouter.stack.find((l) => l.route?.path === '/backlinks/summary').route.stack.at(-1).handle;
const mockRes = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

beforeEach(() => { siteById = { id: 7, website_domain: 'https://www.my-site.com/' }; snapshot = null; lookedUpDomain = undefined; });

describe('client backlinks mirror', () => {
  test('requireAuth guards /backlinks only, and the staff router keeps its platform-admin gate', () => {
    const authLayer = clientBacklinksRouter.stack.find((l) => !l.route);
    assert.equal(authLayer.handle, requireAuth);
    assert.ok(authLayer.regexp.test('/backlinks/summary'));
    assert.ok(!authLayer.regexp.test('/commoncrawl-backlinks/summary'));
    const staffGate = staffRouter.stack.filter((l) => !l.route).map((l) => l.handle);
    assert.equal(staffGate[0], requireAuth);
    assert.equal(staffGate.length, 2, 'requireAuth + requirePlatformRole are still both on the staff router');
  });

  test('the domain is the session site\'s own, normalised, whatever ?domain= says', async () => {
    const res = mockRes();
    await handler({ siteId: 7, query: { domain: 'someone-elses-site.com' } }, res, () => {});
    assert.equal(lookedUpDomain, 'my-site.com');
    assert.equal(res.body.domain, 'my-site.com');
  });

  test('a project with no website domain gets an honest "insufficient-data", not another site\'s numbers', async () => {
    siteById = { id: 7, website_domain: null };
    const res = mockRes();
    await handler({ siteId: 7, query: { domain: 'someone-elses-site.com' } }, res, () => {});
    assert.equal(res.body.status, 'insufficient-data');
    assert.equal(lookedUpDomain, undefined);
  });
});

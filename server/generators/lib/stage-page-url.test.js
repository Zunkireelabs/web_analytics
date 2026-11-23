import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStylePageUrl, stageBranchOf } from './stage-page-url.js';

const site = (o = {}) => ({ repo_default_branch: 'main', pr_target_branch: 'staging', url_file_map: { siteRoot: { stageUrl: 'https://dev-web.mobilise.agency' } }, ...o });
const ok = (status = 200) => async () => ({ status });
const LIVE = 'https://mobilise.agency/blog/dark-social-attribution/?x=1';

describe('stageBranchOf', () => {
  test('a stage branch is one that differs from production; none, or the same name, is no stage', () => {
    assert.equal(stageBranchOf({ pr_target_branch: 'staging', repo_default_branch: 'main' }), 'staging');
    assert.equal(stageBranchOf({ pr_target_branch: 'main', repo_default_branch: 'main' }), null);
    assert.equal(stageBranchOf({ repo_default_branch: 'main' }), null);
  });
});

describe('resolveStylePageUrl', () => {
  test('a site with a stage branch and a stage site is judged on the same path there', async () => {
    const r = await resolveStylePageUrl(site(), LIVE, { fetchFn: ok(200) });
    assert.deepEqual(r, { url: 'https://dev-web.mobilise.agency/blog/dark-social-attribution/?x=1', source: 'stage' });
  });
  test('no recorded stage site, or no stage branch, keeps the live page', async () => {
    assert.equal((await resolveStylePageUrl(site({ url_file_map: { siteRoot: {} } }), LIVE, { fetchFn: ok() })).source, 'live');
    assert.equal((await resolveStylePageUrl(site({ pr_target_branch: null }), LIVE, { fetchFn: ok() })).source, 'live');
    assert.equal((await resolveStylePageUrl(null, LIVE, { fetchFn: ok() })).source, 'live');
  });
  test('a page that is not on the stage site yet falls back to live, and says why', async () => {
    const r = await resolveStylePageUrl(site(), LIVE, { fetchFn: ok(404) });
    assert.equal(r.source, 'live'); assert.match(r.reason, /not-on-stage \(404\)/); assert.equal(r.url, LIVE);
  });
  test('a stage site that is down falls back to live', async () => {
    const r = await resolveStylePageUrl(site(), LIVE, { fetchFn: async () => { throw new Error('ECONNREFUSED'); } });
    assert.equal(r.source, 'live'); assert.match(r.reason, /stage-unreachable/);
  });
  test('a page already on the stage site is used as it is, with no request', async () => {
    const r = await resolveStylePageUrl(site(), 'https://dev-web.mobilise.agency/services/', { fetchFn: async () => { throw new Error('must not fetch'); } });
    assert.deepEqual(r, { url: 'https://dev-web.mobilise.agency/services/', source: 'stage' });
  });
  test('an invalid stage URL or page URL never throws', async () => {
    assert.equal((await resolveStylePageUrl(site({ url_file_map: { siteRoot: { stageUrl: 'not a url' } } }), LIVE, { fetchFn: ok() })).source, 'live');
    assert.equal((await resolveStylePageUrl(site(), 'nope', { fetchFn: ok() })).source, 'live');
  });
});

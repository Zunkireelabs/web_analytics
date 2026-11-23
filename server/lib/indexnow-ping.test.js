import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pingIndexNowForDeployment } from './indexnow-ping.js';

const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const site = (over = {}) => ({ id: 3, website_domain: 'example.com', indexnow_key: KEY, url_file_map: { siteRoot: { indexnowDir: 'public' } }, ...over });
function mk({ s = site(), pages = ['/a/', 'https://example.com/b/'], submit } = {}) {
  const calls = { query: [], submit: [], record: [] };
  return {
    calls,
    deps: {
      getSiteById: async () => s,
      query: async (sql, params) => { calls.query.push(params); return { rows: pages.map((page) => ({ page })) }; },
      submit: submit || (async (a) => { calls.submit.push(a); return { ok: true, status: 200, submitted: a.urls.length, reason: 'Accepted.' }; }),
      record: async (id, r) => { calls.record.push([id, r]); },
    },
  };
}
const dep = { id: 44, pr_number: 17 };

describe('pingIndexNowForDeployment', () => {
  test('submits the pages the deployment\'s own drafts changed, as full URLs on the site\'s host, with the key and its location', async () => {
    const t = mk(); const r = await pingIndexNowForDeployment(3, dep, t.deps);
    assert.equal(r.ok, true);
    assert.deepEqual(t.calls.query[0], [3, 17], 'only this project\'s drafts, only this deployment\'s PR');
    assert.deepEqual(t.calls.submit[0], { host: 'example.com', key: KEY, urls: ['https://example.com/a/', 'https://example.com/b/'], keyLocation: `https://example.com/${KEY}.txt` });
    assert.equal(t.calls.record[0][0], 44);
  });
  test('a project that never opted in (no key, or no folder) is skipped with no request at all', async () => {
    for (const s of [site({ indexnow_key: null }), site({ url_file_map: {} })]) {
      const t = mk({ s }); assert.deepEqual(await pingIndexNowForDeployment(3, dep, t.deps), { skipped: 'not set up' });
      assert.equal(t.calls.submit.length + t.calls.query.length, 0);
    }
  });
  test('a deployment with no recorded PR or no changed pages sends nothing', async () => {
    assert.deepEqual(await pingIndexNowForDeployment(3, { id: 1, pr_number: null }, mk().deps), { skipped: 'no changed pages recorded' });
    assert.deepEqual(await pingIndexNowForDeployment(3, dep, mk({ pages: [] }).deps), { skipped: 'no changed pages recorded' });
  });
  test('NEVER throws: a failing submit, lookup or record is a result, and the verification that called it carries on', async () => {
    const boom = mk({ submit: async () => { throw new Error('network'); } });
    assert.deepEqual(await pingIndexNowForDeployment(3, dep, boom.deps), { ok: false, reason: 'ping failed' });
    const noDb = mk(); noDb.deps.query = async () => { throw new Error('db down'); };
    assert.deepEqual(await pingIndexNowForDeployment(3, dep, noDb.deps), { ok: false, reason: 'ping failed' });
    const noRecord = mk(); noRecord.deps.record = async () => { throw new Error('write failed'); };
    assert.equal((await pingIndexNowForDeployment(3, dep, noRecord.deps)).ok, true, 'the ping still counts when only the record failed');
  });
  test('a rejection from IndexNow is recorded as it came back', async () => {
    const t = mk({ submit: async () => ({ ok: false, status: 403, submitted: 0, reason: 'Rejected: the key is not valid' }) });
    const r = await pingIndexNowForDeployment(3, dep, t.deps);
    assert.equal(r.ok, false); assert.deepEqual(t.calls.record[0][1].status, 403);
  });
});

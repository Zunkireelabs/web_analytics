import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
let site; let ensured;
mock.module(resolve('../store/read.js'), { namedExports: { getSiteById: async () => site } });
mock.module(resolve('../agents/lib/site-domain.js'), { namedExports: { knownDomain: (s) => s?.website_domain || null } });
mock.module(resolve('../store/indexnow.js'), { namedExports: { ensureIndexNowKey: async (id) => { ensured.push(id); return KEY; } } });
const { generate, meta } = await import('./indexnow.js');
const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

beforeEach(() => { ensured = []; site = { id: 7, website_domain: 'example.com', url_file_map: { siteRoot: { indexnowDir: 'public' } } }; });

describe('indexnow generator', () => {
  test('drafts the key file: its name, its repo path under the configured folder, and that it contains only the key', async () => {
    const { content, summary } = await generate({ siteId: 7 });
    assert.deepEqual(content, { key: KEY, fileName: `${KEY}.txt`, path: `public/${KEY}.txt`, fileContent: KEY, host: 'example.com', keyLocation: `https://example.com/${KEY}.txt` });
    assert.equal(summary, `IndexNow key file ${KEY}.txt`);
    assert.deepEqual(ensured, [7], 'the key is minted and saved for THIS project');
  });
  test('refuses, with a plain reason, a site with no folder for the file; nothing is minted', async () => {
    site = { id: 7, website_domain: 'example.com', url_file_map: {} };
    await assert.rejects(generate({ siteId: 7 }), (e) => e.status === 400 && /siteRoot\.indexnowDir/.test(e.message) && e.userFacing === true);
    assert.deepEqual(ensured, []);
  });
  test('a site that does not exist is a 404', async () => { site = null; await assert.rejects(generate({ siteId: 9 }), (e) => e.status === 404); });
  test('a folder at the repo root works (no folder prefix)', async () => {
    site.url_file_map.siteRoot.indexnowDir = '/';
    assert.equal((await generate({ siteId: 7 })).content.path, `${KEY}.txt`);
  });
  test('a registered generator with the id the rest of the system uses', () => { assert.equal(meta.id, 'indexnow'); assert.deepEqual(meta.recommendationTags, []); });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { indexNowDir, indexNowTargetPath } from './indexnow-file.js';
import { guardSiteRootWrite } from './site-root-write-guard.js';

const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const site = (dir) => ({ url_file_map: { siteRoot: dir === undefined ? {} : { indexnowDir: dir } } });

describe('indexNowTargetPath', () => {
  test('the configured folder plus <key>.txt; slashes around the folder are tidied', () => {
    assert.equal(indexNowTargetPath(site('public'), KEY), `public/${KEY}.txt`);
    assert.equal(indexNowTargetPath(site('/static/root/'), KEY), `static/root/${KEY}.txt`);
    assert.equal(indexNowTargetPath(site('/'), KEY), `${KEY}.txt`);
  });
  test('no folder configured, or no valid key: null, never a guess', () => {
    assert.equal(indexNowTargetPath(site(undefined), KEY), null);
    assert.equal(indexNowTargetPath(site('   '), KEY), null);
    assert.equal(indexNowTargetPath(site(42), KEY), null);
    assert.equal(indexNowTargetPath({}, KEY), null);
    assert.equal(indexNowTargetPath(site('public'), undefined), null);
  });
  test('a key can never add a path segment: anything but letters, digits and dashes is refused', () => {
    for (const bad of ['../../etc/passwd', 'a/b/c/d/e/f/g/h', '..%2f..%2fsecret', 'key with space', 'x.txt/../y12345678', 'short']) assert.equal(indexNowTargetPath(site('public'), bad), null, bad);
  });
  test('indexNowDir', () => { assert.equal(indexNowDir(site('public')), 'public'); assert.equal(indexNowDir(site(undefined)), null); });
});

describe('guardSiteRootWrite kind: indexnow', () => {
  const path = `public/${KEY}.txt`;
  test('a missing file may be created', async () => assert.deepEqual(await guardSiteRootWrite({ path, kind: 'indexnow', readFile: async () => null }), { ok: true, mode: 'create' }));
  test('a file that already exists is refused (the work is done), never overwritten', async () => {
    const r = await guardSiteRootWrite({ path, kind: 'indexnow', readFile: async () => ({ content: KEY }) });
    assert.deepEqual([r.ok, r.reason], [false, 'file-exists']);
    assert.match(r.error, /already set up/);
  });
  test('it reads only the one path (no sibling-template probing for a key file)', async () => {
    const read = []; await guardSiteRootWrite({ path, kind: 'indexnow', readFile: async (p) => { read.push(p); return null; } });
    assert.deepEqual(read, [path]);
  });
});

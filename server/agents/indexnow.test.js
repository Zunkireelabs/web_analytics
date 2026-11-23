import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { run, checkKeyFile, meta } from './indexnow.js';

const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const site = (over = {}) => ({ id: 1, website_domain: 'example.com', url_file_map: { siteRoot: { indexnowDir: 'public' } }, indexnow_key: null, ...over });
const go = (s, state) => run({ siteId: 1, deps: { getSiteById: async () => s, checkKeyFile: async () => state } });

describe('indexnow agent', () => {
  test('a project not set up (no folder recorded, or no domain) is said plainly and raises nothing', async () => {
    for (const s of [site({ url_file_map: {} }), site({ website_domain: null, gsc_property: null })]) {
      const r = await go(s, 'live'); assert.equal(r.status, 'insufficient-data'); assert.match(r.message, /not set up/); assert.equal(r.facts, null);
    }
  });
  test('no key yet: recommends the key file draft, as a low-priority action on the indexnow generator', async () => {
    const r = await go(site(), 'unused');
    assert.equal(r.status, 'ok');
    const [f] = r.facts.findings;
    assert.equal(f.id, 'indexnow:site'); assert.equal(f.priority, 'low');
    assert.equal(f.recommendedAction.generatorId, 'indexnow'); assert.equal(f.recommendedAction.params.page, 'https://example.com/');
    assert.equal(f.evidence.keyMinted, false);
  });
  test('a key whose file is missing is recommended again; one that is live is done; one that cannot be reached is "cannot tell", never a finding', async () => {
    assert.equal((await go(site({ indexnow_key: KEY }), 'missing')).facts.findings.length, 1);
    assert.equal((await go(site({ indexnow_key: KEY }), 'live')).facts.findings.length, 0);
    assert.equal((await go(site({ indexnow_key: KEY }), 'unreachable')).facts.findings.length, 0);
  });
  test('the live file is only looked for once a key exists', async () => {
    let asked = 0; const s = site();
    await run({ siteId: 1, deps: { getSiteById: async () => s, checkKeyFile: async () => { asked += 1; return 'live'; } } });
    assert.equal(asked, 0);
  });
  test('registered as a technical agent that needs a public site', () => { assert.equal(meta.id, 'indexnow'); assert.deepEqual(meta.requiresCapabilities, ['public-web']); });
});

describe('checkKeyFile', () => {
  const resp = (status, text = '') => async () => ({ res: { status, text: async () => text } });
  test('live only when the file is served and holds exactly the key (whitespace around it is fine)', async () => {
    assert.equal(await checkKeyFile('example.com', KEY, { follow: resp(200, `${KEY}\n`) }), 'live');
    assert.equal(await checkKeyFile('example.com', KEY, { follow: resp(200, 'something else') }), 'missing');
    assert.equal(await checkKeyFile('example.com', KEY, { follow: resp(200, `${KEY} and more`) }), 'missing');
  });
  test('404 and 410 mean missing; any other status, or a failure, means cannot tell', async () => {
    assert.equal(await checkKeyFile('example.com', KEY, { follow: resp(404) }), 'missing');
    assert.equal(await checkKeyFile('example.com', KEY, { follow: resp(410) }), 'missing');
    assert.equal(await checkKeyFile('example.com', KEY, { follow: resp(503) }), 'unreachable');
    assert.equal(await checkKeyFile('example.com', KEY, { follow: async () => { throw new Error('blocked'); } }), 'unreachable');
  });
  test('asks for https://<host>/<key>.txt', async () => {
    let url; await checkKeyFile('example.com', KEY, { follow: async (u) => { url = u.href; return { res: { status: 404 } }; } });
    assert.equal(url, `https://example.com/${KEY}.txt`);
  });
});

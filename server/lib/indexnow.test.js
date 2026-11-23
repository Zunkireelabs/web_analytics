import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateIndexNowKey, isValidIndexNowKey, keyFileName, keyFileContent, cleanUrlList, submitIndexNow, MAX_URLS_PER_REQUEST } from './indexnow.js';

const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('key', () => {
  test('generated keys are valid, 32 hex characters, and different each time', () => {
    const a = generateIndexNowKey(); const b = generateIndexNowKey();
    assert.match(a, /^[0-9a-f]{32}$/); assert.ok(isValidIndexNowKey(a)); assert.notEqual(a, b);
  });
  test('validity: 8-128 letters, digits, dashes; nothing else', () => {
    for (const k of ['abcdefgh', 'A-b-1-2-3-4', 'x'.repeat(128)]) assert.equal(isValidIndexNowKey(k), true, k);
    for (const k of ['short', 'x'.repeat(129), 'has space here', 'bad/char1234', '', null, undefined, 12345678]) assert.equal(isValidIndexNowKey(k), false, String(k));
  });
  test('the key file is <key>.txt and contains only the key', () => { assert.equal(keyFileName(KEY), `${KEY}.txt`); assert.equal(keyFileContent(KEY), KEY); });
});

describe('cleanUrlList', () => {
  test('keeps this host (www or not), drops other hosts, junk, non-http, fragments and duplicates', () => {
    const r = cleanUrlList('example.com', ['https://example.com/a', 'https://www.example.com/b#top', 'https://example.com/a', 'https://other.com/x', 'not a url', 'ftp://example.com/f', '  https://example.com/c  ']);
    assert.deepEqual(r.urls, ['https://example.com/a', 'https://www.example.com/b', 'https://example.com/c']);
    assert.deepEqual(r.dropped, { otherHost: 1, invalid: 2, duplicate: 1, overLimit: 0 });
  });
  test('a subdomain is not the host', () => assert.deepEqual(cleanUrlList('example.com', ['https://blog.example.com/x']).urls, []));
  test('capped at the protocol limit', () => {
    const many = Array.from({ length: MAX_URLS_PER_REQUEST + 5 }, (_, i) => `https://example.com/p${i}`);
    const r = cleanUrlList('example.com', many);
    assert.equal(r.urls.length, MAX_URLS_PER_REQUEST); assert.equal(r.dropped.overLimit, 5);
  });
});

describe('submitIndexNow', () => {
  const ok = (status = 200) => { const calls = []; return { calls, fetchImpl: async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { status }; } }; };

  test('posts the documented JSON to the endpoint and reports how many were submitted', async () => {
    const f = ok(200);
    const r = await submitIndexNow({ host: 'example.com', key: KEY, urls: ['https://example.com/a', 'https://example.com/b'], fetchImpl: f.fetchImpl });
    assert.deepEqual(r, { ok: true, status: 200, submitted: 2, reason: 'Accepted.', dropped: { otherHost: 0, invalid: 0, duplicate: 0, overLimit: 0 } });
    assert.equal(f.calls[0].url, 'https://api.indexnow.org/IndexNow');
    assert.equal(f.calls[0].init.method, 'POST');
    assert.match(f.calls[0].init.headers['Content-Type'], /application\/json/);
    assert.deepEqual(f.calls[0].body, { host: 'example.com', key: KEY, urlList: ['https://example.com/a', 'https://example.com/b'] });
  });
  test('sends keyLocation only when given', async () => {
    const f = ok();
    await submitIndexNow({ host: 'example.com', key: KEY, urls: ['https://example.com/a'], keyLocation: `https://example.com/${KEY}.txt`, fetchImpl: f.fetchImpl });
    assert.equal(f.calls[0].body.keyLocation, `https://example.com/${KEY}.txt`);
  });
  test('202 counts as accepted', async () => assert.equal((await submitIndexNow({ host: 'example.com', key: KEY, urls: ['https://example.com/a'], fetchImpl: ok(202).fetchImpl })).ok, true));
  test('each rejection says what it means, and submits nothing', async () => {
    for (const [status, re] of [[400, /malformed/], [403, /key is not valid/], [422, /does not belong/], [429, /too many/], [500, /Unexpected response \(500\)/]]) {
      const r = await submitIndexNow({ host: 'example.com', key: KEY, urls: ['https://example.com/a'], fetchImpl: ok(status).fetchImpl });
      assert.equal(r.ok, false, String(status)); assert.equal(r.submitted, 0); assert.match(r.reason, re, String(status)); assert.equal(r.status, status);
    }
  });
  test('refuses before any request: no host, a bad key, no usable URLs', async () => {
    const f = ok();
    assert.match((await submitIndexNow({ key: KEY, urls: ['https://example.com/a'], fetchImpl: f.fetchImpl })).reason, /No host/);
    assert.match((await submitIndexNow({ host: 'example.com', key: 'bad key', urls: ['https://example.com/a'], fetchImpl: f.fetchImpl })).reason, /key is missing or not valid/);
    assert.match((await submitIndexNow({ host: 'example.com', key: KEY, urls: ['https://other.com/a'], fetchImpl: f.fetchImpl })).reason, /No URLs on this host/);
    assert.equal(f.calls.length, 0);
  });
  test('a network failure or timeout is a result, never a throw', async () => {
    const down = await submitIndexNow({ host: 'example.com', key: KEY, urls: ['https://example.com/a'], fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    assert.deepEqual([down.ok, down.status, down.reason], [false, null, 'Could not reach IndexNow.']);
    const slow = await submitIndexNow({ host: 'example.com', key: KEY, urls: ['https://example.com/a'], fetchImpl: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); } });
    assert.match(slow.reason, /did not answer in time/);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { serveDist, pickEncoding } from './static-assets.js';

test('pickEncoding prefers brotli, then gzip', () => {
  assert.equal(pickEncoding('gzip, deflate, br'), 'br');
  assert.equal(pickEncoding('gzip'), 'gzip');
  assert.equal(pickEncoding(''), 'identity');
  assert.equal(pickEncoding(undefined), 'identity');
});

async function withServer(fn) {
  const dist = mkdtempSync(join(tmpdir(), 'dist-'));
  mkdirSync(join(dist, 'assets'));
  const js = 'console.log("hello");'.repeat(200);
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), js);
  writeFileSync(join(dist, 'index.html'), '<html></html>');
  const site = serveDist(dist);
  const app = express();
  app.use(site.assets); app.use(site.rest); app.get('*', site.page);
  const server = app.listen(0);
  try { await fn(`http://127.0.0.1:${server.address().port}`, js); } finally { server.close(); }
}

test('built assets are compressed and cached for a year', async () => {
  await withServer(async (base, js) => {
    const br = await fetch(`${base}/assets/app-abc123.js`, { headers: { 'accept-encoding': 'br' } });
    assert.equal(br.headers.get('content-encoding'), 'br');
    assert.match(br.headers.get('cache-control'), /immutable/);
    assert.equal(await br.text(), js); // fetch decodes it, so equal text proves the encoding round-trips

    const gz = await fetch(`${base}/assets/app-abc123.js`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(gz.headers.get('content-encoding'), 'gzip');
    assert.equal(await gz.text(), js);

    const plain = await fetch(`${base}/assets/app-abc123.js`, { headers: { 'accept-encoding': 'identity' } });
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.equal(await plain.text(), js);
  });
});

test('a repeat visit gets 304, and the page itself is never cached', async () => {
  await withServer(async (base) => {
    const first = await fetch(`${base}/assets/app-abc123.js`);
    const again = await fetch(`${base}/assets/app-abc123.js`, { headers: { 'if-none-match': first.headers.get('etag') } });
    assert.equal(again.status, 304);
    const page = await fetch(`${base}/anything`);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    assert.equal(await page.text(), '<html></html>');
  });
});

test('paths cannot escape the build folder', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/assets/..%2F..%2Fetc%2Fpasswd.js`);
    assert.ok(!(await r.text()).includes('root:'));
  });
});

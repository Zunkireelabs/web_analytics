import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSecurityHeaders, findHeaderCandidates, validateHeaders } from './host-headers-writer.js';

const H = [{ name: 'X-Frame-Options', value: 'SAMEORIGIN' }, { name: 'X-Content-Type-Options', value: 'nosniff' }];
const run = (files, contents, headers = H) => planSecurityHeaders({ files, read: async (p) => contents[p] ?? null, headers });

test('vercel.json: adds a headers entry, keeps the rest of the file', async () => {
  const r = await run(['vercel.json'], { 'vercel.json': '{\n  "cleanUrls": true\n}\n' });
  assert.equal(r.ok, true);
  const j = JSON.parse(r.newContent);
  assert.equal(j.cleanUrls, true);
  assert.deepEqual(j.headers[0].headers.map((h) => h.key), ['X-Frame-Options', 'X-Content-Type-Options']);
  assert.ok(r.newContent.endsWith('\n'));
});
test('vercel.json: never overrides a header it already sets, adds only the missing', async () => {
  const cur = JSON.stringify({ headers: [{ source: '/(.*)', headers: [{ key: 'x-frame-options', value: 'DENY' }] }] });
  const r = await run(['vercel.json'], { 'vercel.json': cur });
  assert.deepEqual(r.added, ['X-Content-Type-Options']);
  assert.ok(!r.newContent.includes('SAMEORIGIN'));
});
test('vercel.json: all present -> already-exists, not a rewrite', async () => {
  const cur = JSON.stringify({ headers: [{ source: '/(.*)', headers: H.map((h) => ({ key: h.name, value: 'x' })) }] });
  assert.equal((await run(['vercel.json'], { 'vercel.json': cur })).reason, 'already-exists');
});
test('vercel.json that is not JSON is refused', async () => {
  assert.equal((await run(['vercel.json'], { 'vercel.json': '{nope' })).ok, false);
});
test('netlify.toml: marker block appended, and re-running replaces it instead of duplicating', async () => {
  const a = await run(['netlify.toml'], { 'netlify.toml': '[build]\n  publish = "dist"\n' });
  assert.equal(a.ok, true);
  assert.match(a.newContent, /\[\[headers\]\]\n {2}for = "\/\*"/);
  assert.match(a.newContent, /publish = "dist"/);
  const b = await run(['netlify.toml'], { 'netlify.toml': a.newContent }, [H[0]]);
  assert.equal(b.ok, true);
  assert.equal((b.newContent.match(/SEOAI:SECURITY-HEADERS:START/g) || []).length, 1);
  assert.ok(!b.newContent.includes('X-Content-Type-Options'));
});
test('_headers file (Netlify / Cloudflare Pages)', async () => {
  const r = await run(['public/_headers'], { 'public/_headers': '/assets/*\n  Cache-Control: max-age=1\n' });
  assert.equal(r.ok, true);
  assert.match(r.newContent, /\/\*\n {2}X-Frame-Options: SAMEORIGIN/);
  assert.match(r.newContent, /Cache-Control: max-age=1/);
});
test('.htaccess (Apache)', async () => {
  const r = await run(['.htaccess'], { '.htaccess': 'RewriteEngine On\n' });
  assert.match(r.newContent, /<IfModule mod_headers.c>\n {2}Header always set X-Frame-Options "SAMEORIGIN"/);
});
test('next.config: spliced into an existing headers() array; refused for static export or no headers()', async () => {
  const ok = await run(['next.config.js'], { 'next.config.js': 'module.exports = {\n  async headers() {\n    return [\n    ];\n  },\n};\n' });
  assert.equal(ok.ok, true);
  assert.match(ok.newContent, /source: "\/\(\.\*\)", headers: \[\{ key: "X-Frame-Options"/);
  assert.equal((await run(['next.config.js'], { 'next.config.js': 'module.exports = { output: "export" }' })).reason, 'no-editable-headers-file');
  assert.equal((await run(['next.config.js'], { 'next.config.js': 'module.exports = {}' })).ok, false);
});
test('a repo with no known mechanism is refused with a plain reason', async () => {
  const r = await run(['index.html'], {});
  assert.equal(r.reason, 'no-headers-mechanism');
});
test('Vercel wins over next.config; unsafe header values are refused', async () => {
  assert.equal(findHeaderCandidates(['next.config.js', 'vercel.json'])[0].format, 'vercel');
  assert.equal(validateHeaders([{ name: 'X-A', value: 'a"b' }]).ok, false);
  assert.equal(validateHeaders([]).reason, 'no-headers');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { planRedirect, validateRedirect, findRedirectCandidates, toPath } from './redirect-writer.js';

const run = (files, contents, from = 'https://x.com/old-page/', to = 'https://x.com/new-page') =>
  planRedirect({ files, read: async (p) => contents[p] ?? null, from, to });

test('toPath strips host, query, trailing slash', () => {
  assert.equal(toPath('https://x.com/a/b/?q=1#h'), '/a/b');
  assert.equal(toPath('/a/'), '/a');
});

test('validateRedirect refuses unsafe chars, root and self redirects', () => {
  assert.equal(validateRedirect('/a b', '/c').reason, 'unsafe-path');
  assert.equal(validateRedirect('/a;rm', '/c').reason, 'unsafe-path');
  assert.equal(validateRedirect('/a\n/b', '/c').reason, 'unsafe-path');
  assert.equal(validateRedirect('/', '/c').reason, 'refuse-root');
  assert.equal(validateRedirect('/a', '/a/').reason, 'self-redirect');
  assert.equal(validateRedirect('/a', '/b').ok, true);
});

test('netlify _redirects: rule goes on top; duplicate refused', async () => {
  const r = await run(['public/_redirects'], { 'public/_redirects': '/* /index.html 200\n' });
  assert.equal(r.ok, true);
  assert.equal(r.newContent, '/old-page /new-page 301\n/* /index.html 200\n');
  const dup = await run(['_redirects'], { _redirects: '/old-page /x 301\n' });
  assert.equal(dup.reason, 'already-exists');
});

test('vercel.json: adds permanent redirect, keeps indent and other keys', async () => {
  const r = await run(['vercel.json'], { 'vercel.json': '{\n  "cleanUrls": true\n}\n' });
  assert.equal(r.ok, true);
  const j = JSON.parse(r.newContent);
  assert.equal(j.cleanUrls, true);
  assert.deepEqual(j.redirects[0], { source: '/old-page', destination: '/new-page', permanent: true });
  assert.ok(r.newContent.endsWith('\n'));
  assert.equal((await run(['vercel.json'], { 'vercel.json': '{bad' })).reason, 'no-editable-redirect-file');
});

test('nginx: inserts a location block before the first location', async () => {
  const conf = 'server {\n    listen 80;\n    location / {\n        try_files $uri =404;\n    }\n}\n';
  const r = await run(['nginx/static.conf'], { 'nginx/static.conf': conf });
  assert.equal(r.ok, true);
  assert.match(r.newContent, /location = \/old-page \{\n\s+return 301 \/new-page;\n\s+\}/);
  assert.ok(r.newContent.indexOf('location = /old-page') < r.newContent.indexOf('location / {'));
  const none = await run(['nginx/a.conf'], { 'nginx/a.conf': 'server { listen 80; }\n' });
  assert.equal(none.ok, false);
});

test('next.config: static export is refused, plain redirects() is edited', async () => {
  const exp = await run(['next.config.ts'], { 'next.config.ts': 'export default { output: "export" };' });
  assert.equal(exp.ok, false);
  assert.match(exp.error, /output: "export"/);
  const src = 'export default {\n  async redirects() {\n    return [\n      { source: "/a", destination: "/b", permanent: true },\n    ];\n  },\n};\n';
  const r = await run(['next.config.js'], { 'next.config.js': src });
  assert.equal(r.ok, true);
  assert.match(r.newContent, /\{ source: "\/old-page", destination: "\/new-page", permanent: true \},\n\s+\{ source: "\/a"/);
  const noRedirects = await run(['next.config.js'], { 'next.config.js': 'export default {};' });
  assert.equal(noRedirects.ok, false);
});

test('priority: nginx beats static-export next.config; nothing supported -> refusal', async () => {
  const files = ['next.config.ts', 'nginx/static.conf'];
  assert.deepEqual(findRedirectCandidates(files).map((c) => c.format), ['nginx', 'next-config']);
  const r = await run(files, {
    'next.config.ts': 'export default { output: "export" };',
    'nginx/static.conf': 'location / { }\n',
  });
  assert.equal(r.ok, true);
  assert.equal(r.format, 'nginx');
  const none = await run(['src/app/page.tsx'], {});
  assert.equal(none.reason, 'no-redirect-mechanism');
});

test('htaccess: Redirect 301 line added', async () => {
  const r = await run(['.htaccess'], { '.htaccess': 'RewriteEngine On\n' });
  assert.equal(r.newContent, 'Redirect 301 /old-page /new-page\nRewriteEngine On\n');
});

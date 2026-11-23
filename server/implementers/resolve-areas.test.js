import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The real GitHub client cannot be imported under the module-mock loader (a dependency quirk), so it is stubbed with every export name it has.
const rel = (p) => new URL(p, import.meta.url);
const names = (p) => [...readFileSync(rel(p), 'utf8').matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
const stub = (p) => Object.fromEntries(names(p).map((n) => [n, async () => { throw new Error(`${n} must not be reached`); }]));
mock.module(rel('../github/client.js').href, { namedExports: stub('../github/client.js') });
mock.module(rel('../llm.js').href, { namedExports: stub('../llm.js') });

const { resolveImplementerForApply } = await import('./resolve.js');
const { areaNameOf } = await import('./lib/site-areas.js');

const nextMeta = { 'meta-title': { id: 'nextjs-metadata-export' } };
const site = {
  id: 8872, repo_owner: 'o', repo_name: 'r', repo_default_branch: 'main',
  url_file_map: { areas: [
    { name: 'business', include: ['/businesses'], override: { mounts: [{ prefix: '/businesses' }], pages: { '/pricing': { file: 'marketing/src/pricing.njk' } } } },
    { name: 'marketplace', include: [], exclude: ['/businesses'], override: { pages: { '/search': { file: 'src/app/search/page.tsx', adapters: nextMeta } } } },
  ] },
};
const draft = (page) => ({ action_type: 'meta-title', content: { page } });

test('the adapter is chosen from the draft\'s own area: a marketplace page gets its adapter', async () => {
  const r = await resolveImplementerForApply(site, draft('https://zennly.io/search'));
  assert.equal(r.implementerId, 'adapter:nextjs-metadata-export');
});

test('a business page, whose area declares no adapter, gets the default writer, not the marketplace adapter', async () => {
  const r = await resolveImplementerForApply(site, draft('https://zennly.io/businesses/pricing'));
  assert.equal(r.implementerId, 'backend');
});

test('the implementer it returns is handed the same area view when it runs', async () => {
  const r = await resolveImplementerForApply(site, draft('https://zennly.io/businesses/pricing'));
  let seen = null;
  const spy = { ...r.implementer, preview: async (s) => { seen = areaNameOf(s); return { ok: true }; } };
  const { areaAwareImplementer } = await import('./lib/site-areas.js');
  await areaAwareImplementer(spy).preview(site, draft('https://zennly.io/businesses/pricing'));
  assert.equal(seen, 'business');
});

test('a site without areas resolves exactly as before', async () => {
  const plain = { id: 1, repo_owner: 'o', repo_name: 'r', url_file_map: { pages: { '/x': { file: 'x.html', adapters: nextMeta } } } };
  const r = await resolveImplementerForApply(plain, draft('https://a.com/x'));
  assert.equal(r.implementerId, 'adapter:nextjs-metadata-export');
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSiteConfig, buildAuditEvent, runConfigAuditForAllSites } from './config-audit.js';
import { eventKeyFor, COOLDOWN_DAYS } from '../notifications/alert-gate.js';
import { IN_APP_ONLY_TYPES } from '../store/notifications.js';

const tree = ['src/app/a/page.tsx', 'src/app/[slug]/page.tsx', 'src/content/posts/x.json', 'src/data/manifest.json', 'public/sitemap.xml', 'src/app/layout.tsx'];
const site = (map) => ({ id: 7, url_file_map: map });

describe('analyzeSiteConfig: configured paths against the real tree', () => {
  test('a clean config has no findings', () => {
    assert.deepEqual(analyzeSiteConfig(site({
      pages: { '/a': { file: 'src/app/a/page.tsx' } },
      newContentTargets: { 'blog-outline': { dir: 'src/content/posts', manifestFile: 'src/data/manifest.json' } },
      siteRoot: { sitemap: 'public/sitemap.xml', layoutTemplate: 'src/app/layout.tsx' },
    }), tree), []);
  });
  test('stale file, shared template without an adapter, missing dir, manifest and site-root file are each reported', () => {
    const f = analyzeSiteConfig(site({
      pages: { '/gone': { file: 'src/app/gone/page.tsx' }, '/shared': { file: 'src/app/[slug]/page.tsx' } },
      newContentTargets: { 'blog-outline': { dir: 'src/nowhere', manifestFile: 'src/data/missing.json' } },
      siteRoot: { robotsTxt: 'public/robots.txt', sitemap: 'public/sitemap.xml' },
    }), tree).map((x) => x.code).sort();
    assert.deepEqual(f, ['missing-content-dir', 'missing-manifest', 'missing-site-root-file', 'shared-template-page', 'stale-page-file']);
  });
  test('a shared template WITH an adapter is not flagged; a Set or an array tree both work; an empty config is clean', () => {
    assert.deepEqual(analyzeSiteConfig(site({ pages: { '/s': { file: 'src/app/[slug]/page.tsx', adapters: { faq: { id: 'x' } } } } }), new Set(tree)), []);
    assert.deepEqual(analyzeSiteConfig(site({}), tree), []);
    assert.deepEqual(analyzeSiteConfig({ id: 1 }, tree), []);
  });
});

describe('audit event', () => {
  const f = [{ code: 'stale-page-file', detail: '/x is mapped to y, which does not exist on the default branch.' }];
  test('bell only, medium, names the problem, stable identity per client, weekly cooldown, never counts as the day\'s email', () => {
    const e = buildAuditEvent(9, f);
    assert.deepEqual(e.channels, ['in-app']); assert.match(e.title, /1 mapping problem found/); assert.match(e.body, /stale page file/);
    assert.equal(eventKeyFor(e), 'insight:config-audit:9'); assert.equal(COOLDOWN_DAYS['config-audit'], 7); assert.ok(IN_APP_ONLY_TYPES.includes('config-audit'));
  });
  test('no findings -> no event', () => assert.equal(buildAuditEvent(1, []), null));
});

describe('runConfigAuditForAllSites', () => {
  const rows = [
    { id: 1, url_file_map: { pages: { '/a': { file: 'src/app/a/page.tsx' } } } },          // clean
    { id: 2, url_file_map: { pages: { '/g': { file: 'nope.tsx' } } } },                      // flagged
    { id: 3, url_file_map: { pages: { '/g': { file: 'nope.tsx' } } } },                      // partial tree: must stay silent
    { id: 4, url_file_map: {} },                                                             // GitHub error: must stay silent
  ];
  test('flags only real problems; a truncated tree or an unreachable GitHub invents nothing; one failure never stops the others', async () => {
    const delivered = [];
    const t = await runConfigAuditForAllSites({
      query: async () => ({ rows }),
      loadTree: async (s) => { if (s.id === 4) throw new Error('boom'); return { files: tree, truncated: s.id === 3 }; },
      deliver: async (id, events) => { delivered.push([id, events[0].type]); },
    });
    assert.deepEqual(delivered, [[2, 'config-audit']]);
    assert.deepEqual(t, { sites: 4, flagged: 1, unreadable: 2, clean: 1 });
  });
});

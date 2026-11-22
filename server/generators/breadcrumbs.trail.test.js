import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { stubOpenAI } from '../test-support/stub-openai.js';
import { strictExports } from '../test-support/strict-exports.js';

const resolve = (p) => new URL(p, import.meta.url).href;
stubOpenAI(mock);
let site; let analysis; let analyzeOk = true;
const real = await import('../agents/lib/page-content.js');
mock.module(resolve('../agents/lib/page-content.js'), { namedExports: { ...real, analyzePageUrl: async () => (analyzeOk ? { ok: true, analysis } : { ok: false, error: 'x' }) } });
mock.module(resolve('../store/read.js'), { namedExports: await strictExports(resolve('../store/read.js'), { getSiteById: async () => site }) });
const { generate, cleanTitle } = await import('./breadcrumbs.js');

const live = (set) => ({ liveStatus: async (u) => set.has(u) });
const names = (r) => r.content.jsonLd.itemListElement.map((i) => [i.name, i.item]);

describe('breadcrumbs trail only lists real pages', () => {
  test('a 404 ancestor (/category) is skipped; Home and the page itself stay', async () => {
    site = { name: 'Admizz Education', website_domain: 'admizzeducation.com', url_file_map: { pages: { '/category/australia': { file: 'x.tsx' } } } };
    analysis = { title: 'Australia Archives - Admizz Education', schemaTypes: [] }; analyzeOk = true;
    const r = await generate({ siteId: 1, params: { page: 'https://admizzeducation.com/category/australia' } }, live(new Set()));
    assert.deepEqual(names(r), [['Home', 'https://admizzeducation.com/'], ['Australia Archives', 'https://admizzeducation.com/category/australia']]);
  });
  test('a live ancestor is kept; positions are consecutive', async () => {
    site = { name: 'Zennly', website_domain: 'zennly.io', url_file_map: { pages: { '/businesses/privacy-policy': { file: 'p.njk' } } } };
    analysis = { title: 'Privacy Policy — Zennly', schemaTypes: [] };
    const r = await generate({ siteId: 1, params: { page: 'https://zennly.io/businesses/privacy-policy' } }, live(new Set(['https://zennly.io/businesses'])));
    assert.deepEqual(r.content.jsonLd.itemListElement.map((i) => i.position), [1, 2, 3]);
    assert.equal(r.content.jsonLd.itemListElement[1].name, 'Businesses');
    assert.equal(r.content.jsonLd.itemListElement[2].name, 'Privacy Policy');
  });
  test('an unreadable page falls back to the slug for the last crumb, never to nothing', async () => {
    site = { name: 'A', website_domain: 'a.com', url_file_map: { pages: { '/x-y': { file: 'f' } } } }; analyzeOk = false;
    const r = await generate({ siteId: 1, params: { page: 'https://a.com/x-y' } }, live(new Set()));
    assert.equal(names(r).at(-1)[0], 'X Y');
  });
});

describe('breadcrumbs on a shared template', () => {
  test('Astro and Eleventy shared templates are also template edits, not refusals', async () => {
    analyzeOk = true; analysis = { title: 'T', schemaTypes: [] };
    site = { name: 'A', website_domain: 'a.com', url_file_map: { patterns: [{ match: '^/blog/[^/]+$', file: 'src/pages/blog/[slug].astro' }] } };
    assert.equal((await generate({ siteId: 1, params: { page: 'https://a.com/blog/x' } }, live(new Set()))).content.templateEdit.file, 'src/pages/blog/[slug].astro');
    site = { name: 'A', website_domain: 'a.com', url_file_map: { patterns: [{ match: '^/solutions/[^/]+/?$', file: 'src/_includes/solution-detail.njk' }] } };
    assert.equal((await generate({ siteId: 1, params: { page: 'https://a.com/solutions/x/' } }, live(new Set()))).content.templateEdit.file, 'src/_includes/solution-detail.njk');
  });
  test('a Next.js app-router template becomes ONE template edit (no static trail), carrying the route file and origin', async () => {
    site = { name: 'A', website_domain: 'a.com', url_file_map: { patterns: [{ match: '^/category/[a-z-]+$', file: 'src/app/category/[slug]/page.tsx' }] } };
    analyzeOk = true; analysis = { title: 'T', schemaTypes: [] };
    const r = await generate({ siteId: 1, params: { page: 'https://a.com/category/uk' } }, live(new Set()));
    assert.deepEqual(r.content.templateEdit, { file: 'src/app/category/[slug]/page.tsx', origin: 'https://a.com', pagePath: '/category/uk' });
    assert.equal(r.content.jsonLd, undefined);
  });
  test('a shared template of a stack with no adapter yet is parked as needs-input with the reason', async () => {
    site = { name: 'A', website_domain: 'a.com', url_file_map: { patterns: [{ match: '^/city/[a-z-]+$', file: 'app/views/city.html.erb' }] } };
    await assert.rejects(() => generate({ siteId: 1, params: { page: 'https://a.com/city/x' } }, live(new Set())), (e) => e.needsInput === true && /shared-template/.test(e.reason));
  });
  test('a pattern with one file per URL is fine', async () => {
    site = { name: 'A', website_domain: 'a.com', url_file_map: { patterns: [{ match: '^/blog/([a-z-]+)$', file: 'src/blog/$1.njk' }] } };
    const r = await generate({ siteId: 1, params: { page: 'https://a.com/blog/post-one' } }, live(new Set()));
    assert.equal(names(r).at(-1)[1], 'https://a.com/blog/post-one');
  });
});

describe('cleanTitle', () => {
  test('strips the site-name suffix', () => {
    assert.equal(cleanTitle('Cookie Policy | Zennly', 'Zennly'), 'Cookie Policy');
    assert.equal(cleanTitle('Privacy Policy — Zennly', 'Zennly'), 'Privacy Policy');
  });
  test('decodes &amp; and rejects empty or oversized titles', () => {
    assert.equal(cleanTitle('Salon Management Software: What It Is &amp; How It Works | Zennly', 'Zennly'), 'Salon Management Software: What It Is & How It Works');
    assert.equal(cleanTitle('', 'x'), null);
    assert.equal(cleanTitle('x'.repeat(200), 'y'), null);
  });
});

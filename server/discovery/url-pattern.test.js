import test from 'node:test';
import assert from 'node:assert/strict';
import { planUrlPattern, planPageEntries } from './url-pattern.js';

// Shapes copied from production (Zennly, 2026-11-19): a map with a few explicit blog entries and no pattern, and the repo's real file names.
const siteMap = { pages: { '/about': { file: 'src/about.njk' }, '/blog/salon-management-software': { file: 'src/blog/salon-management-software.njk' } } };
const repoFiles = ['src/about.njk', 'src/blog.njk', 'src/blog/salon-management-software.njk', 'src/blog/barbershop-booking-app-nepal.njk', 'src/blog/best-spa-software-nepal.njk', 'src/solutions.njk'];
const pages = [
  'https://zennly.io/about', 'https://zennly.io/blog/salon-management-software',
  'https://zennly.io/blog/barbershop-booking-app-nepal/', 'https://zennly.io/blog/best-spa-software-nepal', 'https://zennly.io/solutions/',
];
const base = { siteMap, match: '^/blog/([^/]+)/?$', file: 'src/blog/$1.njk', pages, repoFiles, host: 'zennly.io' };

test('maps the unmapped blog pages (trailing slash or not), and leaves explicit entries and other pages alone', () => {
  const r = planUrlPattern(base);
  assert.equal(r.ok, true);
  assert.deepEqual(r.newlyMapped.map((x) => x.page), ['https://zennly.io/blog/barbershop-booking-app-nepal/', 'https://zennly.io/blog/best-spa-software-nepal']);
  assert.equal(r.newlyMapped[0].file, 'src/blog/barbershop-booking-app-nepal.njk');
  assert.equal(r.alreadyMapped, 2);                               // /about and the explicit blog entry keep their own entries; /solutions/ matches nothing here
  assert.deepEqual(r.nextMap.patterns, [{ match: '^/blog/([^/]+)/?$', file: 'src/blog/$1.njk' }]);
  assert.deepEqual(siteMap.patterns, undefined);                  // the input map is never changed
});

test('one page that would map to a file that does not exist refuses the whole pattern', () => {
  const r = planUrlPattern({ ...base, pages: [...pages, 'https://zennly.io/blog/no-such-post'] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not exist in the repository, e\.g\. https:\/\/zennly\.io\/blog\/no-such-post -> src\/blog\/no-such-post\.njk/);
});

test('the same pattern twice, an invalid regex, a file that ignores the capture group, and a path outside the repo are refused', () => {
  const twice = { ...siteMap, patterns: [{ match: '^/blog/([^/]+)/?$', file: 'src/blog/$1.njk' }] };
  assert.match(planUrlPattern({ ...base, siteMap: twice }).reason, /already exists/);
  assert.match(planUrlPattern({ ...base, match: '^/blog/([^/]+' }).reason, /not a valid regular expression/);
  assert.match(planUrlPattern({ ...base, file: 'src/blog/index.njk' }).reason, /does not use it/);
  assert.match(planUrlPattern({ ...base, file: '../etc/$1' }).reason, /relative path/);
  assert.match(planUrlPattern({ ...base, file: '/abs/$1.njk' }).reason, /relative path/);
});

test('a pattern that maps nothing new says so instead of writing an empty change', () => {
  const r = planUrlPattern({ ...base, pages: ['https://zennly.io/about', 'https://zennly.io/blog/salon-management-software'] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /maps no page that is not already mapped/);
});

// ---- replacing a pattern that points at the wrong file (SuperRank, 2026-11-19) ----
// Real shapes: every /blog/<slug> pointed at ONE shared Astro template, while the title and body of each post live in src/content/blog/<slug>.md.
const srMap = { pages: { '/pricing': { file: 'src/pages/pricing.astro' } }, patterns: [{ match: '^/blog/([^/]+)/?$', file: 'src/pages/blog/[slug].astro' }] };
const srFiles = ['src/pages/pricing.astro', 'src/pages/blog/[slug].astro', 'src/content/blog/aeo-for-local-businesses.md', 'src/content/blog/a-60-day-plan-to-grow-ai-search-visibility.md'];
const srPages = ['https://superrank.si/pricing', 'https://superrank.si/blog/aeo-for-local-businesses', 'https://superrank.si/blog/a-60-day-plan-to-grow-ai-search-visibility'];

test('replace: the blog pattern is pointed at each post\'s own markdown file; explicit pages are untouched', () => {
  const r = planUrlPattern({ siteMap: srMap, match: '^/blog/([^/]+)/?$', file: 'src/content/blog/$1.md', pages: srPages, repoFiles: srFiles, host: 'superrank.si', replace: true });
  assert.equal(r.ok, true);
  assert.equal(r.replaced, 'src/pages/blog/[slug].astro');
  assert.deepEqual(r.newlyMapped.map((x) => x.file), ['src/content/blog/aeo-for-local-businesses.md', 'src/content/blog/a-60-day-plan-to-grow-ai-search-visibility.md']);
  assert.equal(r.nextMap.patterns.length, 1);                                   // replaced, not duplicated
  assert.equal(srMap.patterns[0].file, 'src/pages/blog/[slug].astro');          // the input is never changed
});

test('replace: refused when one post has no markdown file, when nothing would change, or when there is nothing to replace', () => {
  const miss = planUrlPattern({ siteMap: srMap, match: '^/blog/([^/]+)/?$', file: 'src/content/blog/$1.md', pages: [...srPages, 'https://superrank.si/blog/a-post-with-no-file'], repoFiles: srFiles, host: 'superrank.si', replace: true });
  assert.equal(miss.ok, false);
  assert.match(miss.reason, /a-post-with-no-file -> src\/content\/blog\/a-post-with-no-file\.md/);
  const already = { ...srMap, patterns: [{ match: '^/blog/([^/]+)/?$', file: 'src/content/blog/$1.md' }] };
  assert.match(planUrlPattern({ siteMap: already, match: '^/blog/([^/]+)/?$', file: 'src/content/blog/$1.md', pages: srPages, repoFiles: srFiles, host: 'superrank.si', replace: true }).reason, /already points at this file/);
  assert.match(planUrlPattern({ siteMap: srMap, match: '^/blog/([^/]+)/?$', file: 'src/pages/blog/[slug].astro', pages: srPages, repoFiles: srFiles, replace: true }).reason, /does not use it/);   // a shared template is not something this tool sets
  assert.match(planUrlPattern({ siteMap: srMap, match: '^/news/([^/]+)/?$', file: 'x/$1.md', pages: srPages, repoFiles: srFiles, replace: true }).reason, /no pattern with this match to replace/);
  assert.match(planUrlPattern({ siteMap: srMap, match: '^/blog/([^/]+)/?$', file: 'src/content/blog/$1.md', pages: srPages, repoFiles: srFiles }).reason, /already exists/);
});

// ---- exact pages (MOBILISE home page and contact page, real file names from the repo) ----
const mobMap = { pages: { '/services': { file: 'src/services/index.njk' } } };
const mobFiles = ['src/index.njk', 'src/contact/index.njk', 'src/services/index.njk'];

test('exact pages: the home page and contact page are added; existing entries are never overwritten', () => {
  const r = planPageEntries({ siteMap: mobMap, entries: [{ path: '/', file: 'src/index.njk' }, { path: '/contact', file: 'src/contact/index.njk' }], repoFiles: mobFiles });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.nextMap.pages), ['/services', '/', '/contact']);
  assert.equal(mobMap.pages['/'], undefined);
  assert.match(planPageEntries({ siteMap: mobMap, entries: [{ path: '/services', file: 'src/index.njk' }], repoFiles: mobFiles }).reason, /will not overwrite/);
});

test('exact pages: a file that does not exist, a bad path, or a path outside the repo is refused', () => {
  assert.match(planPageEntries({ siteMap: mobMap, entries: [{ path: '/about', file: 'src/about.njk' }], repoFiles: mobFiles }).reason, /does not exist in the repository/);
  assert.match(planPageEntries({ siteMap: mobMap, entries: [{ path: 'about', file: 'src/index.njk' }], repoFiles: mobFiles }).reason, /must start with \//);
  assert.match(planPageEntries({ siteMap: mobMap, entries: [{ path: '/x', file: '../secret' }], repoFiles: mobFiles }).reason, /relative path/);
});

import { planPatternLineKeys } from './url-pattern.js';
test('planPatternLineKeys sets the key on one pattern only and keeps the site-wide key', () => {
  const siteMap = { defaults: { placements: { 'meta-title': { lineKeys: { title: 'headline' } } } }, patterns: [{ match: '^/blog/([^/]+)/?$', file: 'src/content/blog/$1.md' }, { match: '^/x/([^/]+)/?$', file: 'src/x/$1.md' }] };
  const r = planPatternLineKeys({ siteMap, match: '^/blog/([^/]+)/?$', lineKeys: { description: 'excerpt' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.nextMap.patterns[0].placements['meta-title'].lineKeys, { title: 'headline', description: 'excerpt' });
  assert.equal(r.nextMap.patterns[1].placements, undefined);
  assert.equal(r.nextMap.patterns[0].file, 'src/content/blog/$1.md');
  assert.equal(planPatternLineKeys({ siteMap: r.nextMap, match: '^/blog/([^/]+)/?$', lineKeys: { description: 'excerpt' } }).ok, false);
  assert.equal(planPatternLineKeys({ siteMap, match: '^/nope$', lineKeys: { description: 'excerpt' } }).ok, false);
  assert.equal(planPatternLineKeys({ siteMap, match: '^/blog/([^/]+)/?$', lineKeys: { robots: 'x' } }).ok, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { runSiteReadiness } from './run.js';
import { layoutDerivesHead, classifyGaps, groupGaps } from './stacks.js';

const quiet = { log() {}, error() {} };

// Real excerpt: Zunkireelabs/superrank-web src/layouts/Layout.astro lines 55-63 and 72 (2026-11-19): the layout builds the head from props.
const ASTRO_LAYOUT = `<title>{title}</title>
<meta name="description" content={description}>
{noindex ? <meta name="robots" content="noindex"> : <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">}
{!noindex && <link rel="canonical" href={canonical}>}
{!noindex && <link rel="alternate" hreflang="en" href={canonical}>}
{!noindex && <link rel="alternate" hreflang="x-default" href={canonical}>}
<meta property="og:title" content={ogTitle}>
<meta property="og:description" content={ogDescription}>
<meta property="og:url" content={canonical}>
<meta name="twitter:title" content={ogTitle}>`;

// A small fake project is a Map of path -> content; the repo tree is its keys. Shapes are copied from the three real repositories.
function project(files, over = {}) {
  const saved = { map: null };
  const deps = {
    learn: async () => ({ ok: true, technology: { framework: { name: over.stack || 'Eleventy (11ty)' } } }),
    refreshPages: async () => {},
    listPages: async () => over.pages,
    repoTree: async () => ({ files: Object.keys(files), truncated: false }),
    readFile: async (s, p) => files[p] ?? null,
    saveMap: async (s, m) => { saved.map = m; },
    reloadSite: async (s) => (over.reload ? over.reload(saved.map) : { ...s, url_file_map: saved.map }),
    designState: async () => over.design || { state: 'none' },
    queueDesign: async () => { saved.queued = true; return true; },
    markerTypes: async () => over.types || ['meta-title', 'open-graph', 'canonical'],
    hostOf: () => over.host,
  };
  return { deps, saved };
}

// ---- Eleventy (MOBILISE shape): JSON front matter, head include per page, collections under src/<section>/<slug>/index.njk ----
const E_PAGE = (include, title) => `---\n{\n  "layout": "layouts/base.njk",\n  "headInclude": "${include}",\n  "title": "${title}",\n  "description": "About ${title}"\n}\n---\n<main></main>\n`;
const E_HEAD = (url) => `<title>{{ title | escape }}</title>\n    <link rel="canonical" href="${url}">\n    <meta property="og:title" content="T">\n    <meta name="twitter:card" content="summary">\n    <meta property="og:image" content="https://x/i.jpg">\n`;
const ELEVENTY = {
  'src/index.njk': E_PAGE('heads/index.njk', 'Home'), 'src/_includes/heads/index.njk': E_HEAD('https://m.agency/'),
  'src/contact/index.njk': E_PAGE('heads/contact-index.njk', 'Contact'), 'src/_includes/heads/contact-index.njk': E_HEAD('https://m.agency/contact/'),
  'src/blog/a/index.njk': E_PAGE('heads/blog-a-index.njk', 'A'), 'src/_includes/heads/blog-a-index.njk': E_HEAD('https://m.agency/blog/a/'),
  'src/blog/b/index.njk': E_PAGE('heads/blog-b-index.njk', 'B'), 'src/_includes/heads/blog-b-index.njk': E_HEAD('https://m.agency/blog/b/'),
};
const E_PAGES = ['https://m.agency/', 'https://m.agency/contact/', 'https://m.agency/blog/a/', 'https://m.agency/blog/b/'];
const E_SITE = { id: 8874, name: 'MOBILISE', repo_owner: 'o', repo_name: 'r', repo_default_branch: 'staging', website_domain: 'm.agency', url_file_map: { pages: {} } };

test('Eleventy, nothing mapped: the repository alone is enough to map every page, adopt every head, and place title, description, open-graph and canonical on all of them', async () => {
  const { deps, saved } = project(ELEVENTY, { pages: E_PAGES, host: 'm.agency' });
  const r = await runSiteReadiness(E_SITE, { deps, log: quiet });                  // check only
  assert.equal(r.stack, 'Eleventy (11ty)');
  assert.equal(r.steps.mapping.unmapped.length, 0);
  assert.deepEqual(r.gate.openGaps, []);
  assert.equal(r.gate.markersComplete, true);
  assert.equal(r.plan.files.length, 8);                                              // 4 page files + 4 head files
  assert.equal(saved.map, null);                                                      // check-only wrote nothing
  assert.equal(saved.queued, undefined);
  assert.equal(r.ready, false);                                                       // design capture not done yet: markers complete is not the same as ready
  assert.equal(r.design.state, 'none');
});

test('apply: the mapping is saved and read back, the design capture is queued, and a second run changes nothing', async () => {
  const { deps, saved } = project(ELEVENTY, { pages: E_PAGES, host: 'm.agency' });
  const r = await runSiteReadiness(E_SITE, { apply: true, deps, log: quiet });
  assert.equal(r.steps.mapping.saved, true);
  assert.ok(saved.map.patterns.some((p) => p.match === '^/blog/([^/]+)/?$' && p.file === 'src/blog/$1/index.njk'));
  assert.equal(saved.queued, true);
  assert.equal(r.design.queuedNow, true);
  const again = project(ELEVENTY, { pages: E_PAGES, host: 'm.agency' });
  const r2 = await runSiteReadiness({ ...E_SITE, url_file_map: saved.map }, { apply: true, deps: again.deps, log: quiet });
  assert.equal(r2.steps.mapping.changed, false);
  assert.equal(again.saved.map, null);                                                // nothing to save the second time
});

test('apply: if the saved map does not read back as planned, the old map is restored and the run says so', async () => {
  const { deps, saved } = project(ELEVENTY, { pages: E_PAGES, host: 'm.agency', reload: () => ({ ...E_SITE, url_file_map: { pages: {} } }) });
  const writes = [];
  const origSave = deps.saveMap; deps.saveMap = async (s, m) => { writes.push(m); await origSave(s, m); };
  const r = await runSiteReadiness(E_SITE, { apply: true, deps, log: quiet });
  assert.ok(r.steps.mapping.rolledBack.count > 0);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], E_SITE.url_file_map);                                   // the second write put the old map back
  assert.equal(r.ready, false);
});

// ---- Astro (SuperRank shape): props on the layout tag, a content collection for the blog, a layout that builds Open Graph and canonical ----
const A_PAGE = (title) => `---\nimport Layout from '../layouts/Layout.astro';\n---\n<Layout title="${title}" description="About ${title}.">\n<main></main>\n</Layout>\n`;
const ASTRO = {
  'src/layouts/Layout.astro': ASTRO_LAYOUT,
  'src/pages/index.astro': A_PAGE('Home'), 'src/pages/pricing.astro': A_PAGE('Pricing'),
  'src/content/blog/first-post.md': '---\ntitle: "First post"\nexcerpt: "An excerpt"\n---\nBody.\n', 'src/content/blog/second-post.md': '---\ntitle: "Second"\nexcerpt: "x"\n---\nBody.\n',
  'src/pages/blog/[slug].astro': '---\nimport Layout from "../../layouts/Layout.astro";\n---\n<Layout title={post.title} description={post.excerpt}></Layout>\n',
};
const A_PAGES = ['https://s.si/', 'https://s.si/pricing', 'https://s.si/blog/first-post', 'https://s.si/blog/second-post'];
const A_SITE = { id: 8871, name: 'SuperRank', repo_owner: 'o', repo_name: 'r', repo_default_branch: 'main', website_domain: 's.si', url_file_map: { pages: {}, siteRoot: { layoutTemplate: 'src/layouts/Layout.astro' } } };

test('Astro: pages map to their own files and the blog to the content collection (never the shared [slug].astro); title and description are placed as attribute markers', async () => {
  const { deps } = project(ASTRO, { pages: A_PAGES, host: 's.si', stack: 'Astro', types: ['meta-title', 'open-graph', 'canonical'] });
  const r = await runSiteReadiness(A_SITE, { deps, log: quiet });
  assert.equal(r.steps.mapping.unmapped.length, 0);
  assert.ok(r.steps.mapping.notes.some((n) => /pattern \^\/blog\/\(\[\^\/\]\+\)\/\?\$ -> src\/content\/blog\/\$1\.md/.test(n)));
  const home = r.plan.files.find((f) => f.path === 'src/pages/index.astro');
  assert.match(home.content, /title=\{\/\* SEOAI:TITLE \*\/ "Home"\}/);
  assert.match(home.content, /description=\{\/\* SEOAI:METADESCRIPTION \*\/ "About Home\."\}/);
  assert.match(r.plan.files.find((f) => f.path === 'src/content/blog/first-post.md').content, /title: "First post" # SEOAI:TITLE/);
});

test('Astro: open-graph and canonical are "derived by the shared layout", a stated reason, because the layout builds them from props; the blog description is a named gap (it is the excerpt)', async () => {
  const { deps } = project(ASTRO, { pages: A_PAGES, host: 's.si', stack: 'Astro' });
  const r = await runSiteReadiness(A_SITE, { deps, log: quiet });
  const na = Object.fromEntries(r.gate.notApplicable.map((g) => [g.marker, g]));
  assert.equal(na.OPENGRAPH.reason, 'derived-by-the-shared-layout');
  assert.equal(na.CANONICAL.reason, 'derived-by-the-shared-layout');
  assert.deepEqual(r.gate.openGaps.map((g) => [g.marker, g.reason]), [['METADESCRIPTION', 'description-lives-in-the-excerpt-field']]);   // the ONLY open gap, named
  assert.equal(r.gate.openGaps[0].pages, 2);
  assert.equal(r.gate.markersComplete, false);                                        // not hidden: the gate says so
});

test('a page whose title is an expression is an OPEN gap with that reason; it never counts as placed or as not applicable', async () => {
  const files = { ...ASTRO, 'src/pages/odd.astro': '---\nconst t = "x";\n---\n<Layout title={t} description="d">\n</Layout>\n' };
  const { deps } = project(files, { pages: [...A_PAGES, 'https://s.si/odd'], host: 's.si', stack: 'Astro', types: ['meta-title'] });
  const r = await runSiteReadiness(A_SITE, { deps, log: quiet });
  assert.ok(r.gate.openGaps.some((g) => g.marker === 'TITLE' && g.reason === 'title-is-an-expression' && g.examples.includes('https://s.si/odd')));
});

test('a page with no template file anywhere is reported as unmapped with the reason, and the gate stays closed', async () => {
  const { deps } = project(ELEVENTY, { pages: [...E_PAGES, 'https://m.agency/features/booking/'], host: 'm.agency' });
  const r = await runSiteReadiness(E_SITE, { deps, log: quiet });
  assert.deepEqual(r.steps.mapping.unmapped.map((u) => u.page), ['https://m.agency/features/booking/']);
  assert.equal(r.gate.markersComplete, false);
});

test('no repository: nothing is attempted', async () => {
  const r = await runSiteReadiness({ id: 1, name: 'x' }, { deps: {}, log: quiet });
  assert.equal(r.reason, 'no-repository-connected');
  assert.equal(r.ready, false);
});

test('layoutDerivesHead reads the layout\'s own text: real SuperRank lines derive both; a layout with hard-coded tags derives neither', () => {
  assert.deepEqual(layoutDerivesHead(ASTRO_LAYOUT), { OPENGRAPH: true, CANONICAL: true });
  assert.deepEqual(layoutDerivesHead('<link rel="canonical" href="https://x.com/">\n<meta property="og:title" content="Fixed title">'), { OPENGRAPH: false, CANONICAL: false });
  assert.deepEqual(layoutDerivesHead(null), { OPENGRAPH: false, CANONICAL: false });
});

test('classifyGaps only excuses head markers, and only for head-related reasons; groupGaps counts pages and keeps examples', () => {
  const gaps = [
    { page: 'p1', marker: 'OPENGRAPH', reason: 'no-head-region' }, { page: 'p2', marker: 'OPENGRAPH', reason: 'tag-more-than-once' },
    { page: 'p1', marker: 'TITLE', reason: 'no-front-matter' }, { page: 'p3', marker: 'CANONICAL', reason: 'not-placed' },
  ];
  const { open, notApplicable } = classifyGaps(gaps, { layoutDerives: { OPENGRAPH: true, CANONICAL: true } });
  assert.deepEqual(notApplicable.map((g) => g.page), ['p1', 'p3']);
  assert.deepEqual(open.map((g) => `${g.page}:${g.marker}`), ['p2:OPENGRAPH', 'p1:TITLE']);       // a real defect and a real title gap stay open
  assert.deepEqual(groupGaps(gaps)[0], { marker: 'OPENGRAPH', reason: 'no-head-region', count: 1, examples: ['p1'], pages: 1 });
});


test('an owner exclusion turns a gap into a stated not-applicable with the owner\'s reason, and only for the pages and marker it names', async () => {
  const site = { ...A_SITE, url_file_map: { ...A_SITE.url_file_map, siteRoot: { ...A_SITE.url_file_map.siteRoot, readiness: { exclusions: [{ marker: 'METADESCRIPTION', match: '^/blog/', reason: 'the description is the post excerpt, which also shows on blog cards' }] } } } };
  const { deps } = project(ASTRO, { pages: A_PAGES, host: 's.si', stack: 'Astro' });
  const r = await runSiteReadiness(site, { deps, log: quiet });
  assert.deepEqual(r.gate.openGaps, []);
  assert.equal(r.gate.markersComplete, true);
  const ex = r.gate.notApplicable.find((g) => g.marker === 'METADESCRIPTION');
  assert.equal(ex.reason, 'excluded by the owner: the description is the post excerpt, which also shows on blog cards');
  assert.equal(ex.pages, 2);
  // a rule that names another marker or other pages excuses nothing
  const wrong = { ...site, url_file_map: { ...site.url_file_map, siteRoot: { ...site.url_file_map.siteRoot, readiness: { exclusions: [{ marker: 'TITLE', match: '^/blog/', reason: 'x' }, { marker: 'METADESCRIPTION', match: '^/docs/', reason: 'y' }] } } } };
  assert.equal((await runSiteReadiness(wrong, { deps: project(ASTRO, { pages: A_PAGES, host: 's.si', stack: 'Astro' }).deps, log: quiet })).gate.markersComplete, false);
});

test('a section generated by a pagination template is named, not reported as "no file"', async () => {
  const files = { ...ELEVENTY, 'src/nepal/city-pages.njk': '---\npagination:\n  data: cities\n  size: 1\n  alias: city\npermalink: "/nepal/{{ city.slug }}/"\nlayout: base.njk\n---\n<main></main>\n' };
  const { deps } = project(files, { pages: [...E_PAGES, 'https://m.agency/nepal/pokhara/'], host: 'm.agency' });
  const r = await runSiteReadiness(E_SITE, { deps, log: quiet });
  assert.match(r.steps.mapping.unmapped[0].reason, /^generated-by-a-template \(src\/nepal\/city-pages\.njk: one page per data item/);
});

test('the layout\'s own description key is read and saved as the site-wide alias, so a site that uses metaDescription gets that marker placed', async () => {
  const files = {
    'src/_includes/base.njk': '---\n---\n<head>{% include "_head-meta.njk" %}</head>{{ content | safe }}',
    'src/_includes/_head-meta.njk': '{% set pageDescription = metaDescription or site.defaultDescription %}\n<title>{{ title }}</title>\n<meta name="description" content="{{ pageDescription }}" />\n<link rel="canonical" href="{{ pageUrl }}" />\n<meta property="og:title" content="{{ title }}" />\n',
    'src/a.njk': '---\nlayout: base.njk\ntitle: "A"\nmetaDescription: "About A"\n---\n<main></main>\n',
  };
  const site = { id: 8872, name: 'Zennly', repo_owner: 'o', repo_name: 'r', repo_default_branch: 'main', website_domain: 'z.io', url_file_map: { pages: { '/a': { file: 'src/a.njk' } } } };
  const { deps } = project(files, { pages: ['https://z.io/a'], host: 'z.io' });
  const r = await runSiteReadiness(site, { deps, log: quiet });
  assert.deepEqual(r.nextMap.defaults.placements['meta-title'].lineKeys, { description: 'metaDescription' });
  assert.match(r.plan.files[0].content, /^metaDescription: "About A" # SEOAI:METADESCRIPTION$/m);
  assert.deepEqual(r.gate.openGaps, []);
  assert.deepEqual(r.gate.notApplicable.map((g) => g.marker).sort(), ['CANONICAL', 'OPENGRAPH']);
});

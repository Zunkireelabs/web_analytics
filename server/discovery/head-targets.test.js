import test from 'node:test';
import assert from 'node:assert/strict';
import { planHeadTargets, headIncludeOf } from './head-targets.js';
import { resolveActionFile, resolveFile } from '../implementers/lib/url-file-map.js';

// Real shapes: mobilise-website-11ty page front matter (JSON-style) and head include names, 2026-11-19.
const PAGE = (include) => `---\n{\n  "layout": "layouts/base.njk",\n  "headInclude": "${include}",\n  "title": "T",\n  "description": "D"\n}\n---\n<main></main>\n`;
const HEAD_WITH_TAGS = '<title>{{ title | escape }}</title>\n    <link rel="canonical" href="https://mobilise.agency/services/">\n    <meta property="og:title" content="X">\n    <meta name="twitter:card" content="summary">\n';
const HEAD_NO_TAGS = '<title>{{ title | escape }}</title>\n<meta charset="UTF-8">\n';
const store = {
  'src/services/index.njk': PAGE('heads/services-index.njk'),
  'src/careers/index.njk': PAGE('heads/careers-index.njk'),
  'src/terms/index.njk': PAGE('heads/missing-index.njk'),
  'src/blog/index.njk': '---\ntitle: "No include here"\n---\nx\n',
  'src/_includes/heads/services-index.njk': HEAD_WITH_TAGS,
  'src/_includes/heads/careers-index.njk': HEAD_NO_TAGS,
};
const siteMap = { pages: { '/services': { file: 'src/services/index.njk' }, '/careers': { file: 'src/careers/index.njk' }, '/terms': { file: 'src/terms/index.njk' }, '/blog': { file: 'src/blog/index.njk' } } };
const input = { siteMap, host: 'mobilise.agency', repoFiles: Object.keys(store).concat(['src/_includes/heads/careers-index.njk']), readFile: async (p) => store[p] ?? null,
  pages: ['https://mobilise.agency/services/', 'https://mobilise.agency/careers/', 'https://mobilise.agency/terms/', 'https://mobilise.agency/blog/', 'https://mobilise.agency/unmapped/'] };

test('reads the head include from JSON or YAML front matter', () => {
  assert.equal(headIncludeOf(PAGE('heads/a.njk')), 'heads/a.njk');
  assert.equal(headIncludeOf('---\nheadInclude: heads/b.njk\ntitle: x\n---\n'), 'heads/b.njk');
  assert.equal(headIncludeOf('---\ntitle: x\n---\n'), null);
  assert.equal(headIncludeOf('no front matter'), null);
});

test('only a page whose head file exists and holds adoptable tags is configured; every other page is reported with its reason', async () => {
  const r = await planHeadTargets(input);
  assert.equal(r.ok, true);
  assert.deepEqual(r.configured.map((c) => [c.page, c.types]), [['https://mobilise.agency/services/', ['open-graph', 'canonical']]]);
  const why = Object.fromEntries(r.skipped.map((s) => [s.page, s.reason]));
  assert.match(why['https://mobilise.agency/terms/'], /does not exist in the repository/);
  assert.match(why['https://mobilise.agency/blog/'], /names no head include/);
  assert.match(why['https://mobilise.agency/unmapped/'], /no template file mapped/);
  assert.ok(r.skipped.some((s) => s.page.endsWith('/careers/') && /nothing-to-adopt/.test(s.reason)));   // head file exists but has no tags to adopt
});

test('the new map sends open-graph and canonical to the head file, keeps everything else on the page file, and never changes the input', async () => {
  const r = await planHeadTargets(input);
  const site = { website_domain: 'mobilise.agency', url_file_map: r.nextMap };
  assert.equal(resolveActionFile(site, 'https://mobilise.agency/services/', 'open-graph'), 'src/_includes/heads/services-index.njk');
  assert.equal(resolveActionFile(site, 'https://mobilise.agency/services/', 'canonical'), 'src/_includes/heads/services-index.njk');
  assert.equal(resolveActionFile(site, 'https://mobilise.agency/services/', 'meta-title'), 'src/services/index.njk');
  assert.equal(resolveFile(site, 'https://mobilise.agency/services/'), 'src/services/index.njk');
  assert.equal(siteMap.pages['/services'].placements, undefined);
});

test('a page that already has a configured file keeps it, and a run that changes nothing says so', async () => {
  const first = await planHeadTargets(input);
  const again = await planHeadTargets({ ...input, siteMap: first.nextMap });
  assert.equal(again.ok, false);
  assert.match(again.reason, /no page could be pointed at a head file/);
});

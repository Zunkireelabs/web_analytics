import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAstroPagination } from './astro-recipe.js';

// The shape of a real Astro blog listing (SuperRank's, before it was paginated): a collection sorted newest first, a featured post, the rest in a grid,
// literal title/description wrapped in SEOAI attribute markers, and a group of SEOAI content markers at the end.
const LISTING = `---
import Layout from '../../layouts/Layout.astro';
import PostCard from '../../components/PostCard.astro';
import { getCollection } from 'astro:content';

// Newest first. The rest of the posts fill the grid.
const posts = (await getCollection('blog')).sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
const featured = posts.find((p) => p.data.featured) ?? posts[0];
const rest = posts.filter((p) => p !== featured);
---
<Layout title={/* SEOAI:TITLE */ "The Blog | Acme"} description={/* SEOAI:METADESCRIPTION */ "All about Acme."} bodyClass="page-blog">
<main>
<h1>The Blog</h1>
<p>Stay with us for the rest of the story.</p>
{featured && (
<section class="b-feat"><PostCard post={featured} featured /></section>
)}
<section class="b-list">
  <div class="frame"><div class="b-grid">{rest.map((post) => <PostCard post={post} />)}</div></div>
</section>
<!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END -->

<!-- SEOAI:SCHEMA:START --><!-- SEOAI:SCHEMA:END -->
</main>
</Layout>
`;
const run = (over = {}) => planAstroPagination({ source: LISTING, sourcePath: 'src/pages/blog/index.astro', basePath: '/blog', buttonClass: 'btn', currentClass: 'btn on', trailingSlash: 'never', ...over });

test('slices the list, adds the pager after its container, per-page meta by spread, markers on page 1 only', () => {
  const r = run();
  assert.equal(r.ok, true);
  assert.match(r.after, /const restAll = posts\.filter\(\(p\) => p !== featuredAll\);/);
  assert.match(r.after, /const rest = restAll\.slice\(\(pagerPage - 1\) \* pagerSize, pagerPage \* pagerSize\);/);
  assert.match(r.after, /const featured = pagerPage === 1 \? featuredAll : undefined;/);
  assert.ok(r.after.indexOf('const featured = pagerPage') > r.after.indexOf('const restAll'), 'the page-1 constant is defined after what it reads');
  // the SEOAI-edited title/description literals are untouched
  assert.ok(r.after.includes('title={/* SEOAI:TITLE */ "The Blog | Acme"} description={/* SEOAI:METADESCRIPTION */ "All about Acme."} bodyClass="page-blog" {...pagerMeta}>'));
  assert.match(r.after, /<\/div>\n {2}\{pagerTotal > 1 && \(\n {2}<nav class="blog-pager"/);
  assert.match(r.after, /\{pagerPage === 1 && \(<Fragment><!-- SEOAI:FAQ:START -->[\s\S]*<!-- SEOAI:SCHEMA:END --><\/Fragment>\)\}/);
  assert.ok(r.after.includes('{rest.map((post) => <PostCard post={post} />)}'), 'the list markup is unchanged');
  assert.match(r.after, /<a class="btn" href=\{pagerHref\(pagerPage - 1\)\} rel="prev">Newer posts<\/a>/);
  assert.match(r.after, /<a class="btn" href=\{pagerHref\(pagerPage \+ 1\)\} rel="next">Older posts<\/a>/);
  assert.match(r.after, /<span class="btn on" aria-current="page">/);
});
test('the new route renders the same page for pages 2..N, counting posts with the listing\'s own statements', () => {
  const r = run();
  const [route] = r.extraFiles;
  assert.equal(route.path, 'src/pages/blog/page/[page].astro');
  assert.match(route.after, /import Listing from '\.\.\/index\.astro';/);
  assert.match(route.after, /import \{ getCollection \} from 'astro:content';/);
  assert.match(route.after, /const posts = \(await getCollection\('blog'\)\)\.sort/);
  assert.match(route.after, /const rest = posts\.filter\(\(p\) => p !== featured\);/);
  assert.match(route.after, /Math\.ceil\(rest\.length \/ 12\)/);
  assert.match(route.after, /<Listing pagerPage=\{pagerPage\} \/>/);
});
test('title and description of pages 2+ keep the brand suffix; page 1 is not changed', () => {
  const r = run();
  assert.match(r.after, /title: "The Blog" \+ ', Page ' \+ pagerPage \+ " \| Acme"/);
  assert.match(r.after, /description: "All about Acme\." \+ ' \(Page ' \+ pagerPage \+ '\)'/);
});
test('trailingSlash always puts the slash in every link', () => {
  assert.match(run({ trailingSlash: 'always' }).after, /"\/blog\/" : "\/blog" \+ '\/page\/' \+ n \+ "\/"/);
});
test('a listing at src/pages/blog.astro gets its route in src/pages/blog/page', () => {
  const r = run({ sourcePath: 'src/pages/blog.astro' });
  assert.equal(r.extraFiles[0].path, 'src/pages/blog/page/[page].astro');
  assert.match(r.extraFiles[0].after, /import Listing from '\.\.\/\.\.\/blog\.astro';/);
});
test('refuses: list used elsewhere, helper-built list, section that cannot be page-1-only, existing route, wrong place, dynamic title', () => {
  const swap = (a, b) => ({ source: LISTING.replace(a, b) });
  assert.equal(run(swap('{rest.map(', '{rest.length}{rest.map(')).reason, 'list-used-elsewhere');
  assert.equal(run(swap("const rest = posts.filter((p) => p !== featured);", "const rest = sortByDate(posts.filter((p) => p !== featured));")).reason, 'list-needs-helpers');
  assert.equal(run(swap('{featured && (', '{<b>{featured.id}</b>}{featured && (')).reason, 'page-one-section-not-optional');
  assert.equal(run({ existingFiles: ['src/pages/blog/page/[page].astro'] }).reason, 'route-exists');
  assert.equal(run({ sourcePath: 'src/pages/news/index.astro' }).reason, 'route-mismatch');
  assert.equal(run({ sourcePath: 'src/pages/[lang]/blog.astro', basePath: '/[lang]/blog' }).reason, 'not-a-static-page');
  assert.equal(run(swap('title={/* SEOAI:TITLE */ "The Blog | Acme"}', 'title={pageTitle}')).reason, 'title-not-literal');
  assert.equal(run(swap('{rest.map((post) => <PostCard post={post} />)}', '<PostCard post={rest[0]} />')).reason, 'no-list-map');
  assert.equal(run({ source: 'no frontmatter' }).reason, 'no-frontmatter');
});
test('prose and comments that merely mention the list name are not references', () => {
  assert.equal(run().ok, true);   // the fixture has "the rest of the posts" in a comment and "the rest of the story" in the template
});
test('markers split into separate groups are refused rather than moved', () => {
  const split = LISTING.replace('<!-- SEOAI:SCHEMA:START -->', '<p>keep</p><!-- SEOAI:SCHEMA:START -->');
  assert.equal(run({ source: split }).reason, 'markers-not-together');
});
test('a listing with no featured section and no markers is paginated without extras', () => {
  const plain = `---
import { getCollection } from 'astro:content';
import Layout from '../../layouts/Layout.astro';
const posts = (await getCollection('blog')).sort((a, b) => b.data.date - a.data.date);
---
<Layout title="Blog" description="Posts">
<ul>{posts.map((p) => <li>{p.data.title}</li>)}</ul>
</Layout>
`;
  const r = planAstroPagination({ source: plain, sourcePath: 'src/pages/blog/index.astro', basePath: '/blog' });
  assert.equal(r.ok, true);
  assert.ok(r.after.includes('const postsAll = (await getCollection'));
  assert.ok(!r.after.includes('Fragment'));
  assert.match(r.notes.join(' '), /no SEOAI content markers/);
});

test('a list cut to its first few posts in the frontmatter is refused (a teaser, not the blog list)', () => {
  const r = run({ source: LISTING.replace('const rest = posts.filter((p) => p !== featured);', 'const rest = posts.filter((p) => p !== featured).slice(0, 6);') });
  assert.equal(r.reason, 'list-is-truncated');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planNextjsPagination } from './nextjs-recipe.js';

// The shape of an App Router blog listing: metadata object, an async server component that loads and sorts posts, a featured post shown only when
// present, the rest in a grid, and a group of SEOAI content markers. The same page was built with Next 16 + output: "export" and passed the
// pagination acceptance test (see the recipe's notes in the commit).
const PAGE = `import Link from "next/link";
import type { Metadata } from "next";
import { getPosts } from "@/lib/posts";
import PostCard from "./PostCard";

export const metadata: Metadata = {
  title: "The Blog | Acme",
  description: "Everything we know about Acme, newest first.",
  alternates: {
    canonical: "https://acme.test/blog",
  },
};

export default async function BlogPage() {
  const all = await getPosts();
  const posts = [...all].sort((a, b) => b.date.localeCompare(a.date));
  const featured = posts[0];
  const rest = posts.slice(1);

  return (
    <main>
      <h1>The Blog</h1>
      <p>Let&apos;s read the rest of the story together.</p>
      {featured && (
        <section className="feat">
          <PostCard post={featured} />
        </section>
      )}
      <section className="list">
        <div className="grid">
          {rest.map((post) => (
            <PostCard key={post.slug} post={post} />
          ))}
        </div>
      </section>
      <p><Link href="/">Home</Link></p>
      {/* SEOAI:FAQ:START */}{/* SEOAI:FAQ:END */}
    </main>
  );
}
`;
const run = (over = {}) => planNextjsPagination({ source: PAGE, sourcePath: 'src/app/blog/page.tsx', basePath: '/blog', buttonClass: 'btn', currentClass: 'btn on', nextMajor: 16, ...over });
const swap = (a, b) => ({ source: PAGE.replace(a, b) });

test('moves the body into a shared component with the slice, the pager and an exported loader; page.tsx keeps its metadata byte for byte', () => {
  const r = run();
  assert.equal(r.ok, true);
  assert.ok(r.after.includes(PAGE.slice(PAGE.indexOf('export const metadata'), PAGE.indexOf('};\n', PAGE.indexOf('export const metadata')) + 2)), 'metadata is byte for byte');
  assert.match(r.after, /<PaginatedListing pagerPage=\{1\} \/>/);
  const shared = r.extraFiles.find((f) => f.path === 'src/app/blog/PaginatedListing.tsx').after;
  assert.match(shared, /export async function loadListing\(\) \{\n  const all = await getPosts\(\);\n  const posts = \[\.\.\.all\]\.sort/);
  assert.match(shared, /return \{ all, posts, rest \};/);
  assert.match(shared, /export default async function BlogPage\(\{ pagerPage = 1 \}: \{ pagerPage\?: number \}\)/);
  assert.match(shared, /const \{ posts, rest: restAll \} = await loadListing\(\);/);
  assert.match(shared, /const rest = restAll\.slice\(\(pagerPage - 1\) \* PAGE_SIZE, pagerPage \* PAGE_SIZE\);/);
  assert.match(shared, /const featuredAll = posts\[0\];\n  const featured = pagerPage === 1 \? featuredAll : undefined;/);
  assert.ok(!shared.includes('export const metadata') && !shared.includes('import type { Metadata }'));
  assert.ok(shared.includes('{rest.map((post) => ('), 'the list markup is unchanged');
  assert.match(shared, /<\/div>\n {8}\{pagerTotal > 1 && \(\n {8}<nav className="blog-pager"/);
  assert.match(shared, /<Link className="btn" href=\{pagerHref\(pagerPage - 1\)\} rel="prev">Newer posts<\/Link>/);
  assert.match(shared, /<span key=\{n\} className="btn on" aria-current="page">/);
  assert.match(shared, /\{pagerPage === 1 && \(<>\{\/\* SEOAI:FAQ:START \*\/\}\{\/\* SEOAI:FAQ:END \*\/\}<\/>\)\}/);
  assert.equal((shared.match(/import Link from "next\/link";/g) || []).length, 1, 'no second Link import');
});
test('pages 2+: static params from the same loader, their own title, description and canonical, params awaited on Next 15+', () => {
  const route = run().extraFiles.find((f) => f.path === 'src/app/blog/page/[page]/page.tsx').after;
  assert.match(route, /const \{ rest \} = await loadListing\(\);/);
  assert.match(route, /Math\.ceil\(rest\.length \/ PAGE_SIZE\)/);
  assert.match(route, /title: "The Blog" \+ ", Page " \+ page \+ " \| Acme"/);
  assert.match(route, /canonical: "https:\/\/acme\.test\/blog" \+ "\/page\/" \+ page/);
  assert.match(route, /params: Promise<\{ page: string \}>/);
  assert.match(route, /<PaginatedListing pagerPage=\{Number\(page\)\} \/>/);
  const old = run({ nextMajor: 14 }).extraFiles[1].after;
  assert.match(old, /params: \{ page: string \}/);
  assert.ok(!old.includes('await params'));
});
test('Link is added when the page does not import it; trailingSlash is carried into links and canonical', () => {
  const noLink = PAGE.replace('import Link from "next/link";\n', '').replace('<p><Link href="/">Home</Link></p>', '<p>Home</p>');
  const r = run({ source: noLink, trailingSlash: true });
  const shared = r.extraFiles[0].after;
  assert.equal((shared.match(/import Link from "next\/link";/g) || []).length, 1);
  assert.match(shared, /"\/blog\/" : "\/blog" \+ "\/page\/" \+ n \+ "\/"/);
  assert.match(r.extraFiles[1].after, /"\/page\/" \+ page \+ "\/"/);
});
test('plain JavaScript pages get no type syntax', () => {
  const js = PAGE.replace('import type { Metadata } from "next";\n', '').replace('export const metadata: Metadata', 'export const metadata').replace(/\(a, b\) =>/, '(a, b) =>');
  const r = planNextjsPagination({ source: js, sourcePath: 'app/blog/page.js', basePath: '/blog' });
  assert.equal(r.ok, true);
  assert.ok(r.extraFiles.every((f) => f.path.endsWith('.jsx')));
  assert.match(r.extraFiles[0].after, /\(\{ pagerPage = 1 \}\)/);
  assert.ok(!/: number|Promise</.test(r.extraFiles[0].after + r.extraFiles[1].after));
});
test('refuses what it cannot move safely, each with its own reason', () => {
  assert.equal(run({ source: `"use client";\n${PAGE}` }).reason, 'client-component');
  assert.equal(run(swap('export default async function BlogPage()', 'export const revalidate = 60;\nexport default async function BlogPage()')).reason, 'other-exports');
  assert.equal(run(swap('BlogPage()', 'BlogPage({ searchParams }: { searchParams: Promise<{ q: string }> })')).reason, 'page-takes-props');
  assert.equal(run(swap('{rest.map(', '{rest.length}{rest.map(')).reason, 'list-used-elsewhere');
  assert.equal(run(swap('{rest.map((post) => (\n            <PostCard key={post.slug} post={post} />\n          ))}', '<PostCard post={rest[0]} />')).reason, 'no-list-map');
  assert.equal(run(swap('const rest = posts.slice(1);', 'const rest = posts.slice(1);\n  const count = posts.length;\n  const label = `${count} posts`;')).ok, true);
  assert.equal(run(swap('{featured && (', '<b>{featured.title}</b>{featured && (')).reason, 'page-one-section-not-optional');
  assert.equal(run(swap('title: "The Blog | Acme",', 'title: siteTitle,')).reason, 'metadata-uses-imports');
  assert.equal(run({ source: PAGE.replace(/export const metadata[\s\S]*?\n};\n/, '') }).reason, 'no-metadata');
  assert.equal(run({ existingFiles: ['src/app/blog/page/[page]/page.tsx'] }).reason, 'route-exists');
  assert.equal(run({ sourcePath: 'src/pages/blog/index.tsx' }).reason, 'not-an-app-router-page');
  assert.equal(run({ sourcePath: 'src/app/[lang]/blog/page.tsx', basePath: '/[lang]/blog' }).reason, 'dynamic-route');
  assert.equal(run({ sourcePath: 'src/app/news/page.tsx' }).reason, 'route-mismatch');
  assert.equal(run({ source: 'export default function {' }).reason, 'unparseable');
  assert.equal(run(swap('<div className="grid">', '<div className="grid"><h2>More</h2>')).reason, 'list-not-alone');
});
test('a list used by a nested client component is not an App Router listing this recipe can slice (no .map in the page)', () => {
  const clientList = PAGE.replace(/\{rest\.map\([\s\S]*?\)\)\}/, '<MoreArticles posts={rest} />');
  assert.equal(run({ source: clientList }).reason, 'no-list-map');
});

test('a teaser list (first few posts) with the rest behind a client-side "load more" is refused, not "paginated" into one page', () => {
  const teaser = `import { getPosts } from "@/lib/posts";
import type { Metadata } from "next";
import PostCard from "./PostCard";
import MoreArticles from "./MoreArticles";

export const metadata: Metadata = { title: "Blogs | Acme", description: "Posts.", alternates: { canonical: "https://acme.test/blogs" } };

export default async function BlogsPage() {
  const posts = await getPosts();
  const latestPosts = posts.slice(0, 6);
  const remainingPosts = posts.slice(6);
  return (
    <main>
      <section>
        <div className="grid">
          {latestPosts.map((post) => (
            <PostCard key={post.slug} post={post} />
          ))}
        </div>
      </section>
      {remainingPosts.length > 0 && <MoreArticles posts={remainingPosts} />}
    </main>
  );
}
`;
  const r = planNextjsPagination({ source: teaser, sourcePath: 'src/app/blogs/page.tsx', basePath: '/blogs', nextMajor: 16 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'list-is-truncated');
  assert.match(r.error, /slice\(0, 6\)/);
  assert.match(r.error, /load more/);
});

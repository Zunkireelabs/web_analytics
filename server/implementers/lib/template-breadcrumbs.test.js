import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { injectTemplateBreadcrumbs, routeFromAppFile, routeFromAstroFile, hasTemplateBreadcrumbs, templateBreadcrumbAdapterFor, endOfOpeningTag } from './template-breadcrumbs.js';

const CATEGORY = `import Link from "next/link";

export default async function CategoryPage({ params }: PageProps) {
  const { slug } = await params;
  const categories = getAllCategories();
  const category = categories.find((c) => c.slug.current === slug);
  const categoryName = category?.title || slug;

  return (
    <main>
      {/* ===== HERO ===== */}
      <section>
        <h1 className="text-3xl">
          {categoryName}
        </h1>
      </section>
    </main>
  );
}
`;
const ctx = { filePath: 'src/app/category/[slug]/page.tsx', origin: 'https://admizzeducation.com', pagePath: '/category/australia' };

describe('routeFromAppFile', () => {
  test('dynamic segment becomes a template variable and a matching regex', () => {
    const r = routeFromAppFile('src/app/category/[slug]/page.tsx');
    assert.equal(r.urlTemplate, '/category/${slug}'); assert.deepEqual(r.params, ['slug']);
    assert.ok(r.pathRegex.test('/category/uk')); assert.ok(!r.pathRegex.test('/blogs/uk'));
  });
  test('route groups are dropped; catch-all and non-page files are refused', () => {
    assert.equal(routeFromAppFile('src/app/(site)/about/page.tsx').urlTemplate, '/about');
    assert.equal(routeFromAppFile('src/app/docs/[...path]/page.tsx'), null);
    assert.equal(routeFromAppFile('src/components/x.tsx'), null);
  });
});

describe('injectTemplateBreadcrumbs', () => {
  test('builds the trail from the route parameter and the heading variable: nothing hard-coded to one page', () => {
    const r = injectTemplateBreadcrumbs(CATEGORY, ctx);
    assert.equal(r.ok, true);
    assert.match(r.newContent, /name: categoryName, item: `https:\/\/admizzeducation\.com\/category\/\$\{slug\}`/);
    assert.match(r.newContent, /name: "Home", item: "https:\/\/admizzeducation\.com\/"/);
    assert.ok(!/australia/i.test(r.newContent));
    // placed inside <main>, before the existing content, which is untouched
    assert.ok(r.newContent.indexOf('BreadcrumbList') > r.newContent.indexOf('<main>'));
    assert.ok(r.newContent.indexOf('BreadcrumbList') < r.newContent.indexOf('===== HERO'));
    assert.ok(r.newContent.includes(CATEGORY.slice(CATEGORY.indexOf('{/* ===== HERO'))));
  });
  test('the result is idempotent: a second application is an already-applied no-op', () => {
    const once = injectTemplateBreadcrumbs(CATEGORY, ctx);
    assert.equal(injectTemplateBreadcrumbs(once.newContent, ctx).reason, 'already-applied');
    assert.equal(hasTemplateBreadcrumbs(once.newContent), true);
  });
  test('an existing BreadcrumbSchema component also counts as already done', () => {
    assert.equal(injectTemplateBreadcrumbs(CATEGORY.replace('<main>', '<main><BreadcrumbSchema items={[]} />'), ctx).reason, 'already-applied');
  });
  test('refuses when the route parameter is not read in the template', () => {
    const r = injectTemplateBreadcrumbs(CATEGORY.replace('const { slug } = await params;', ''), ctx);
    assert.equal(r.ok, false); assert.match(r.reason, /route-param-not-in-scope/);
  });
  test('refuses when the heading is not a plain variable (never guesses a name)', () => {
    const r = injectTemplateBreadcrumbs(CATEGORY.replace('{categoryName}', 'Category archive'), ctx);
    assert.match(r.reason, /no-heading-variable/);
  });
  test('refuses when the heading variable is not declared in the file', () => {
    const r = injectTemplateBreadcrumbs(CATEGORY.replace('const categoryName = category?.title || slug;', ''), ctx);
    assert.match(r.reason, /heading-variable-not-declared/);
  });
  test('refuses a page that the template does not render, a non-app-router file and a hostile origin', () => {
    assert.match(injectTemplateBreadcrumbs(CATEGORY, { ...ctx, pagePath: '/blogs/x' }).reason, /route-mismatch/);
    assert.match(injectTemplateBreadcrumbs('<main/>', { ...ctx, filePath: 'src/x.rb' }).reason, /stack-unsupported/);
    assert.match(injectTemplateBreadcrumbs(CATEGORY, { ...ctx, origin: 'https://a.com/`${evil}' }).reason, /bad-origin/);
  });
  test('works with a member-expression heading such as {post.title}', () => {
    const src = CATEGORY.replace('{categoryName}', '{category.title}').replace('const categoryName = category?.title || slug;', 'const category = x;');
    const r = injectTemplateBreadcrumbs(src, ctx);
    assert.equal(r.ok, true); assert.match(r.newContent, /name: category\.title,/);
  });
});

const ASTRO = `---
import Layout from '../../layouts/Layout.astro';
export async function getStaticPaths() {
  return posts.map((post) => ({ params: { slug: post.id }, props: { post } }));
}
const { post } = Astro.props;
const { title, excerpt } = post.data;
---
<Layout title={title.length <= 48 ? \`\${title} | Site\` : title} description={excerpt}>
<main class="article">
  <h1 class="h">{title}</h1>
  <p>Body</p>
</main>
</Layout>
`;
const astroCtx = { filePath: 'src/pages/blog/[slug].astro', origin: 'https://superrank.si', pagePath: '/blog/some-post' };

describe('astro adapter', () => {
  test('only dynamic pages are shared templates', () => {
    assert.ok(routeFromAstroFile('src/pages/blog/[slug].astro').pathRegex.test('/blog/x'));
    assert.equal(routeFromAstroFile('src/pages/about.astro'), null);
    assert.equal(routeFromAstroFile('src/pages/docs/[...path].astro'), null);
    assert.equal(templateBreadcrumbAdapterFor('src/pages/blog/[slug].astro').id, 'astro');
  });
  test('uses the page URL and the frontmatter heading variable; placed first inside <main>', () => {
    const r = injectTemplateBreadcrumbs(ASTRO, astroCtx);
    assert.equal(r.ok, true, r.error);
    assert.ok(r.newContent.includes('name: title, item: new URL(Astro.url.pathname.replace(/(?:\\/index)?\\.html$/, ""), "https://superrank.si").href'), 'page URL with any .html / index suffix removed');
    assert.ok(r.newContent.indexOf('BreadcrumbList') > r.newContent.indexOf('<main class="article">'));
    assert.ok(r.newContent.indexOf('BreadcrumbList') < r.newContent.indexOf('<h1'));
    assert.ok(!/some-post/.test(r.newContent));
  });
  test('without <main>, goes inside the first wrapping component even when its attributes contain > and <=', () => {
    const r = injectTemplateBreadcrumbs(ASTRO.replace('<main class="article">', '<section>').replace('</main>', '</section>'), astroCtx);
    assert.equal(r.ok, true, r.error);
    const at = r.newContent.indexOf('BreadcrumbList');
    assert.ok(at > r.newContent.indexOf('description={excerpt}>'), 'inside <Layout>, after its (expression-heavy) opening tag');
    assert.ok(at < r.newContent.indexOf('<section>'));
  });
  test('idempotent, and refuses honestly when the heading is not a declared variable', () => {
    const once = injectTemplateBreadcrumbs(ASTRO, astroCtx);
    assert.equal(injectTemplateBreadcrumbs(once.newContent, astroCtx).reason, 'already-applied');
    assert.match(injectTemplateBreadcrumbs(ASTRO.replace('const { title, excerpt } = post.data;', 'const excerpt = 1;'), astroCtx).reason, /heading-variable-not-declared/);
    assert.match(injectTemplateBreadcrumbs(ASTRO.replace('{title}</h1>', 'Posts</h1>'), astroCtx).reason, /no-heading-variable/);
  });
  test('endOfOpeningTag skips > inside expressions and quotes', () => {
    const src = '<Layout a={x >= 1 ? "a>b" : y} b="c>d">rest';
    assert.equal(src.slice(0, endOfOpeningTag(src, 0)), '<Layout a={x >= 1 ? "a>b" : y} b="c>d">');
  });
});

const NJK = `---
layout: base.njk
---
{% from "schema/x.njk" import y %}
<main>
  <h1 class="t">{{ feature.name }}</h1>
</main>
`;
describe('eleventy / nunjucks adapter', () => {
  const ctxN = { filePath: 'src/_includes/feature-detail.njk', origin: 'https://zennly.io' };
  test('uses page.url and the heading variable, after the front matter', () => {
    const r = injectTemplateBreadcrumbs(NJK, ctxN);
    assert.equal(r.ok, true, r.error);
    assert.match(r.newContent, /"name": feature\.name \| striptags, "item": "https:\/\/zennly\.io" \+ page\.url/);
    assert.ok(r.newContent.startsWith('---\nlayout: base.njk\n---\n'));
  });
  test('prefers the site\'s own site.url when the template already uses it', () => {
    const r = injectTemplateBreadcrumbs(NJK.replace('<main>', '<main><a href="{{ site.url }}/x">x</a>'), ctxN);
    assert.match(r.newContent, /"item": site\.url \+ "\/"/);
    assert.ok(!r.newContent.includes('https://zennly.io'));
  });
  test('an existing breadcrumbSchema macro call counts as done; a non-variable heading is refused', () => {
    assert.equal(injectTemplateBreadcrumbs(NJK + '{{ breadcrumbSchema([]) }}', ctxN).reason, 'already-applied');
    assert.match(injectTemplateBreadcrumbs(NJK.replace('{{ feature.name }}', 'Features'), ctxN).reason, /no-heading-variable/);
  });
});

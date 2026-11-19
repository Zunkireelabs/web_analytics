import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectInsertionPoint, detectWithTrustedContainer, isJsxFile, isHtmlLikeFile, isVueFile, isSvelteFile } from './structural-detect.js';

describe('file-type routing', () => {
  test('isJsxFile / isHtmlLikeFile', () => {
    assert.equal(isJsxFile('src/pages/about.tsx'), true);
    assert.equal(isJsxFile('src/pages/about.jsx'), true);
    assert.equal(isJsxFile('src/pages/about.astro'), false);
    assert.equal(isHtmlLikeFile('src/pages/about.astro'), true);
    assert.equal(isHtmlLikeFile('src/pages/about.njk'), true);
    assert.equal(isHtmlLikeFile('src/pages/about.tsx'), false);
    // Broadened server-rendered template coverage — same DOM detector, no
    // bespoke per-framework parser (parse5 treats their directive syntax as
    // inert text; see detectHtmlContainer's comment).
    assert.equal(isHtmlLikeFile('templates/post.jinja2'), true);
    assert.equal(isHtmlLikeFile('templates/post.j2'), true);
    assert.equal(isHtmlLikeFile('app/views/post.html.erb'), true);
    assert.equal(isHtmlLikeFile('resources/views/post.blade.php'), true);
    assert.equal(isHtmlLikeFile('templates/post.twig'), true);
    assert.equal(isHtmlLikeFile('public/post.php'), true);
    assert.equal(isVueFile('src/pages/Post.vue'), true);
    assert.equal(isSvelteFile('src/routes/Post.svelte'), true);
  });

  test('plain .md/.mdx is a first-class detector (EOF is genuinely safe there), not a bare "no strategy" pass-through', () => {
    const thin = detectInsertionPoint('# Hello', 'content/post.md');
    assert.equal(thin.ok, false);
    assert.equal(thin.reason, 'no-markdown-body');

    const real = detectInsertionPoint('# Hello\n\n' + 'word '.repeat(20), 'content/post.mdx');
    assert.equal(real.ok, true);
    assert.equal(real.fileKind, 'markdown');
    assert.equal(real.insertBeforeOffset, ('# Hello\n\n' + 'word '.repeat(20)).length);
  });

  test('a genuinely unrecognized extension falls through to DOM structure, then Markdown, before giving up', () => {
    const domShaped = detectInsertionPoint('<main><p>' + 'z'.repeat(50) + '</p></main>', 'page.gohtml');
    assert.equal(domShaped.ok, true);
    assert.equal(domShaped.containerDescription, 'main');

    const proseShaped = detectInsertionPoint('---\ntitle: x\n---\n' + 'word '.repeat(20), 'page.tmpl');
    assert.equal(proseShaped.ok, true);
    assert.equal(proseShaped.fileKind, 'markdown');
  });

  test('a known component-shaped extension never falls back to EOF on its own detector\'s failure', () => {
    const result = detectInsertionPoint('export default function getData() { return { props: {} }; }\n', 'getServerSideProps.tsx');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-jsx-return-found');
  });
});

describe('HTML-like templates (Astro/.njk/.html)', () => {
  test('finds <main> with substantial text and returns the offset right before its closing tag', () => {
    const file = '<html><body><header>nav</header><main><h1>Title</h1><p>' + 'x'.repeat(60) + '</p></main><footer>f</footer></body></html>';
    const result = detectInsertionPoint(file, 'src/pages/about.astro');
    assert.equal(result.ok, true);
    assert.equal(result.containerDescription, 'main');
    const before = file.slice(0, result.insertBeforeOffset);
    const after = file.slice(result.insertBeforeOffset);
    assert.ok(before.endsWith('</p>'));
    assert.ok(after.startsWith('</main>'));
  });

  test('skips an empty/near-empty <main> wrapper (e.g. a client-rendered app shell) rather than matching it', () => {
    const file = '<html><body><main id="root"></main></body></html>';
    const result = detectInsertionPoint(file, 'index.html');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-confident-html-container');
  });

  test('falls back to article when there is no main', () => {
    const file = '<body><article><p>' + 'y'.repeat(60) + '</p></article></body>';
    const result = detectInsertionPoint(file, 'post.njk');
    assert.equal(result.ok, true);
    assert.equal(result.containerDescription, 'article');
  });
});

describe('Astro', () => {
  test('finds <main> in an .astro file with real frontmatter script fences and {expr} interpolation', () => {
    const file = '---\nconst title = "Hi";\n---\n<html><body><main><h1>{title}</h1><p>' + 'a'.repeat(60) + '</p></main></body></html>';
    const result = detectInsertionPoint(file, 'src/pages/blog/post.astro');
    assert.equal(result.ok, true);
    assert.equal(result.fileKind, 'html');
    assert.equal(result.containerDescription, 'main');
  });
});

describe('Flask/FastAPI (Jinja2)', () => {
  test('detects <article> in a Flask-style Jinja2 template with {% %}/{{ }} interleaved', () => {
    const file = '{% extends "base.html" %}\n{% block content %}\n<article><h1>{{ post.title }}</h1><p>' + 'b'.repeat(60) + '</p></article>\n{% endblock %}';
    const result = detectInsertionPoint(file, 'templates/post.jinja2');
    assert.equal(result.ok, true);
    assert.equal(result.containerDescription, 'article');
  });
});

describe('Eleventy/Jekyll layout-referencing content fragments', () => {
  test('a front-matter layout: reference with no <main>/<article> of its own is EOF-safe (the layout owns the real document)', () => {
    const file = '---\nlayout: service.njk\ntitle: "App Development"\n---\n\n<section class="py-12"><h2>Heading</h2><p>' + 'x'.repeat(60) + '</p></section>';
    const result = detectInsertionPoint(file, 'src/pages/services/app-development.njk');
    assert.equal(result.ok, true);
    assert.equal(result.fileKind, 'html-fragment');
    assert.equal(result.insertBeforeOffset, file.length);
  });

  test('prefers a real <main> inside the file over the fragment fallback when both are present', () => {
    const file = '---\nlayout: service.njk\n---\n<main><p>' + 'y'.repeat(60) + '</p></main>';
    const result = detectInsertionPoint(file, 'src/pages/services/full-doc.njk');
    assert.equal(result.ok, true);
    assert.equal(result.fileKind, 'html');
    assert.equal(result.containerDescription, 'main');
  });

  test('refuses when there is no layout: front matter at all (not a fragment, just a broken/empty document)', () => {
    const file = '<html><body><main id="root"></main></body></html>';
    const result = detectInsertionPoint(file, 'index.html');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-confident-html-container');
  });
});

describe('Server-rendered template languages (Jinja/Django, ERB, Blade, Twig, PHP)', () => {
  test('detects <main> inside a Jinja/Django template with {% %} directives interleaved', () => {
    const file = '<html><body>{% block content %}<main><h1>{{ title }}</h1><p>' + 'x'.repeat(60) + '</p></main>{% endblock %}</body></html>';
    const result = detectInsertionPoint(file, 'templates/post.jinja2');
    assert.equal(result.ok, true);
    assert.equal(result.containerDescription, 'main');
  });

  test('detects <article> inside a Rails ERB template with <%= %> interleaved', () => {
    const file = '<body><article><h1><%= @post.title %></h1><p>' + 'y'.repeat(60) + '</p></article></body>';
    const result = detectInsertionPoint(file, 'app/views/posts/show.html.erb');
    assert.equal(result.ok, true);
    assert.equal(result.containerDescription, 'article');
  });

  test('detects <main> inside a Laravel Blade template with @directives interleaved', () => {
    const file = '@extends(\'layouts.app\')\n@section(\'content\')\n<main><p>' + 'z'.repeat(60) + '</p></main>\n@endsection';
    const result = detectInsertionPoint(file, 'resources/views/post.blade.php');
    assert.equal(result.ok, true);
    assert.equal(result.containerDescription, 'main');
  });
});

describe('Vue SFC / Svelte', () => {
  test('finds <main> inside a Vue SFC\'s <template> block, ignoring <script>/<style>', () => {
    const file = '<template>\n  <main><p>' + 'a'.repeat(60) + '</p></main>\n</template>\n<script>export default { data() { return { main: 1 } } }</script>\n<style>main { color: red; }</style>';
    const result = detectInsertionPoint(file, 'src/pages/Post.vue');
    assert.equal(result.ok, true);
    assert.equal(result.fileKind, 'vue');
    assert.equal(result.containerDescription, 'main');
    const before = file.slice(0, result.insertBeforeOffset);
    assert.ok(before.trimEnd().endsWith('</p>'));
  });

  test('finds <article> in a Svelte component\'s markup, ignoring <script>', () => {
    const file = '<script>\n  export let post;\n</script>\n<article><p>' + 'b'.repeat(60) + '</p></article>';
    const result = detectInsertionPoint(file, 'src/routes/Post.svelte');
    assert.equal(result.ok, true);
    assert.equal(result.fileKind, 'svelte');
    assert.equal(result.containerDescription, 'article');
  });

  test('refuses a Vue SFC with no real <template> block', () => {
    const file = '<script>export default {}</script>';
    const result = detectInsertionPoint(file, 'Empty.vue');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-template-block');
  });
});

describe('JSX/TSX (React/Next.js)', () => {
  test('finds a <main> element inside the returned JSX tree', () => {
    const file = 'export default function Page() {\n  return (\n    <div>\n      <Header />\n      <main>\n        <h1>Hi</h1>\n      </main>\n    </div>\n  );\n}\n';
    const result = detectInsertionPoint(file, 'src/pages/about.tsx');
    assert.equal(result.ok, true);
    assert.equal(result.containerDescription, '<main>');
    const before = file.slice(0, result.insertBeforeOffset);
    assert.ok(before.trimEnd().endsWith('</h1>'));
  });

  test('falls back to the component\'s own root element when no <main>/<article> is present', () => {
    const file = 'export default function Page() {\n  return (\n    <div className="page">\n      <p>hello</p>\n    </div>\n  );\n}\n';
    const result = detectInsertionPoint(file, 'page.jsx');
    assert.equal(result.ok, true);
    assert.match(result.containerDescription, /component's own returned root element/);
  });

  test('picks the default export when local helper components share the file', () => {
    // Live on site 1: src/app/[slug]/page.tsx defines 4 JSX-returning
    // functions and refused as ambiguous every day. The default export IS
    // the framework's answer to "which one is the route's component".
    const file = 'function Icon() { return <svg><path /></svg>; }\n' +
      'export default function Page() { return <main><p>hi</p></main>; }\n';
    const result = detectInsertionPoint(file, 'page.tsx');
    assert.equal(result.ok, true);
  });

  test('picks the default export when it is exported by name further down the file', () => {
    const file = 'function Icon() { return <svg><path /></svg>; }\n' +
      'function Page() { return <main><p>hi</p></main>; }\n' +
      'export default Page;\n';
    const result = detectInsertionPoint(file, 'page.tsx');
    assert.equal(result.ok, true);
  });

  test('an inline .map() arrow inside the page is not a rival component', () => {
    // The widest real-world case: any list-rendering page returns JSX from an
    // implicit-return arrow, which counted as a second "component" and made
    // the whole file ambiguous.
    const file = 'export default function Page({ items }) {\n' +
      '  return <main><ul>{items.map((i) => <li key={i}>{i}</li>)}</ul></main>;\n}\n';
    const result = detectInsertionPoint(file, 'page.tsx');
    assert.equal(result.ok, true);
    // Anchored to the page's own <main>, not to the <li> the arrow returns.
    assert.ok(file.slice(result.insertBeforeOffset).startsWith('</main>'));
  });

  test('still refuses when several components return JSX and none is the default export', () => {
    const file = 'export function Icon() { return <svg><path /></svg>; }\n' +
      'export function Page() { return <main><p>hi</p></main>; }\n';
    const result = detectInsertionPoint(file, 'page.tsx');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'multiple-jsx-returns-ambiguous');
  });

  test('still refuses when the page component itself has several returns (early loading/empty states)', () => {
    // Narrowing to the default export says which FUNCTION is the page; it
    // never says which of that function's branches is the real body.
    const file = 'export default function Page({ loading }) {\n' +
      '  if (loading) return <main><p>loading</p></main>;\n' +
      '  return <main><p>hi</p></main>;\n}\n';
    const result = detectInsertionPoint(file, 'page.tsx');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'multiple-jsx-returns-ambiguous');
  });

  test('refuses when nothing in the file returns JSX at all', () => {
    const file = 'export default function getData() { return { props: {} }; }\n';
    const result = detectInsertionPoint(file, 'getServerSideProps.tsx');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-jsx-return-found');
  });

  test('refuses on a self-closing root with nothing to insert into', () => {
    const file = 'export default function Page() { return <Layout />; }\n';
    const result = detectInsertionPoint(file, 'page.jsx');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'self-closing-root-no-body');
  });
});


// ---- a page with no <main> whose own source carries the footer (REAL: mobilise-website-11ty src/about-us/index.njk, 2026-11-19) ----
// Its JSON-style front matter holds "documentStart": "<!DOCTYPE html>\n<html lang=...>" (data, not a wrapper), it has sections but no <main>, and it ends with
// `<div id="footer-placeholder">{% include "components/footer.njk" %}</div>`. End of file would be BELOW the footer.
describe('last resort: place content just before the page footer', () => {
  const FM = `---
{
  "layout": "layouts/base.njk",
  "permalink": "/about-us/index.html",
  "headInclude": "heads/about-us-index.njk",
  "title": "About MOBILISE | Global B2B Marketing Agency",
  "bodyAttributes": " class=\"theme-black\"",
  "documentStart": "<!DOCTYPE html>\n<html lang=\"en\">\n\n",
  "headBodyGap": "\n\n",
  "documentEnd": "\n\n</html>\n",
  "description": "MOBILISE is a global B2B marketing agency based in Bangalore, serving enterprise technology and industrial brands across APAC, EMEA and the Americas.",
  "componentBase": "../"
}
---`;
  const TAIL = `        </div>
    </section>
    <section class="faq-sec" id="faq">
        <div class="container">
            <span class="eyebrow">FAQ</span>
            <h2>Frequently asked questions</h2>
<details><summary>What is MOBILISE?</summary><p>MOBILISE is a global B2B marketing agency built for technology, industrial and transformation-led brands, helping enterprise teams turn complex ideas into clear, credible and market-ready programs.</p></details>
<details><summary>When was MOBILISE founded?</summary><p>MOBILISE was founded in 2015.</p></details>
<details><summary>Where is MOBILISE based?</summary><p>MOBILISE is headquartered in Bangalore, India, with teams across Singapore, the Middle East and North America.</p></details>
<details><summary>How does MOBILISE win new clients?</summary><p>For over a decade, every client relationship has come through word of mouth, earned through disciplined delivery and technical fluency.</p></details>
<details><summary>What does MOBILISE deliver?</summary><p>Go-to-market planning, account-based marketing, content and creative, marketing automation, sales enablement, creative production and global marketing operations.</p></details>
        </div>
    </section>

    <section class="section cta-sec" data-theme="white">
        <div class="container">
            <div class="cta-box">
                <a href="../contact/" class="cta-title-link">
                    <h2 class="cta-title">Let’s make <br><span class="z">B2B interesting.</span></h2>
                </a>
                <p>Whether you’re scaling a regional launch or driving global demand, MOBILISE helps you move faster —
                    with clarity, confidence, and reliable delivery.</p>
                <div class="btn-group">
                    <a href="../contact/" class="btn btn-teal">Connect with us</a>
                </div>
            </div>
        </div>
    </section>

    <div id="footer-placeholder" data-rendered="true" data-path="../footer.html">{% include "components/footer.njk" %}</div>
`;
  const ABOUT = `${FM}\n\n    <section class="section hero-sec"><div class="container"><h1>About MOBILISE</h1><p>A global B2B marketing agency built for technology, industrial and professional services brands across the world.</p></div></section>\n${TAIL}`;

  test('resolves to the line just before the footer include, after the last section', () => {
    const r = detectInsertionPoint(ABOUT, 'src/about-us/index.njk');
    assert.equal(r.ok, true);
    assert.equal(r.fileKind, 'html-before-footer');
    const before = ABOUT.slice(0, r.insertBeforeOffset);
    const after = ABOUT.slice(r.insertBeforeOffset);
    assert.match(before.trimEnd(), /<\/section>$/);
    assert.match(after, /^\s*<div id="footer-placeholder"/);
  });

  test('the trusted-strategy path (another page on the same template) uses the same rule, not end of file', () => {
    const r = detectWithTrustedContainer(ABOUT, 'src/about-us/index.njk', 'html-before-footer', 'the page content, just before its footer');
    assert.equal(r.ok, true);
    assert.ok(r.insertBeforeOffset < ABOUT.indexOf('footer-placeholder'));
  });

  test('a page that already resolves through an earlier strategy is untouched by it (<main> present: the same answer as before)', () => {
    const withMain = '---\nlayout: base.njk\n---\n<main><h1>Title</h1><p>Plenty of real words here to be a substantial container for the detector.</p></main>\n<div id="footer-placeholder">{% include "components/footer.njk" %}</div>\n';
    const r = detectInsertionPoint(withMain, 'src/x/index.njk');
    assert.equal(r.ok, true);
    assert.notEqual(r.fileKind, 'html-before-footer');
  });

  test('refuses a full document, a page with no footer, and a footer with nothing substantial before it', () => {
    assert.notEqual(detectInsertionPoint('<html><body><div class="site-footer">f</div></body></html>', 'a.njk').fileKind, 'html-before-footer');
    assert.equal(detectInsertionPoint('---\n{}\n---\n<section><p>Some real content, but this page has no footer anywhere in its own source at all.</p></section>\n', 'a.njk').fileKind === 'html-before-footer', false);
    const thin = detectInsertionPoint('---\n{ "x": 1 }\n---\n<div id="footer">f</div>\n', 'a.njk');
    assert.equal(thin.ok, false);
  });

  test('the html tag inside the FRONT MATTER does not make the page a full document', () => {
    assert.match(FM, /<html lang=/);
    assert.equal(detectInsertionPoint(ABOUT, 'src/about-us/index.njk').ok, true);
  });
});

// ---- placement bugs found on real pages (zennly.io and mobilise.agency home pages, superrank.si product pages), 2026-11-19 ----
const long = 'A testimonial from a salon owner about how booking and daily reconciliation changed the way the whole business runs every day.';
const HOME_WITH_CARDS = `---
layout: base.njk
title: "Spa & Salon Booking Software in Nepal | Free Demo | Zennly"
---
<section class="v2-stories"><div class="v2-stories__viewport"><div class="v2-stories__track">
  <article class="v2-story"><img src="a.webp" alt="Spa owner"><div class="v2-story__txt"><span>${long}</span></div></article>
  <article class="v2-story"><img src="b.webp" alt="Studio manager"><div class="v2-story__txt"><span>${long}</span></div></article>
</div></div></section>
<section class="v2-section"><h2>Questions owners ask before they switch to one system for every branch</h2></section>
  {% include "_footer-v2.njk" %}
</div><!-- /#v2-root -->
`;

describe('cards and carousels are never the page container', () => {
  test('several <article> cards: not the container; the page resolves just before its footer instead', () => {
    const r = detectInsertionPoint(HOME_WITH_CARDS, 'src/index.njk');
    assert.equal(r.ok, true);
    assert.equal(r.fileKind, 'html-before-footer');
    assert.ok(r.insertBeforeOffset > HOME_WITH_CARDS.lastIndexOf('</article>'), 'after the last card');
    assert.ok(r.insertBeforeOffset <= HOME_WITH_CARDS.indexOf('{% include "_footer-v2.njk" %}'), 'not after the footer');
  });

  test('a single <article> inside a carousel track is not the container either', () => {
    const one = `<div class="v2-stories__track"><article class="v2-story"><p>${long}</p></article></div>\n{% include "_footer.njk" %}\n`;
    const r = detectInsertionPoint(`---\nlayout: base.njk\n---\n${one}`, 'a.njk');
    assert.notEqual(r.fileKind, 'html');
  });

  test('a lone <article> that is the page (a blog post) is still the container, exactly as before', () => {
    const post = `<main><article class="post"><p>${long}</p></article></main>`;
    const r = detectInsertionPoint(post, 'post.html');
    assert.equal(r.ok, true);
    assert.equal(r.containerDescription, 'main');
  });
});

describe('a layout fragment that carries its own footer', () => {
  test('is placed before that footer, not at the end of the file below it', () => {
    const frag = `---\nlayout: base.njk\n---\n<section><p>${long}</p></section>\n{% include "_footer-v2.njk" %}\n`;
    const r = detectInsertionPoint(frag, 'a.njk');
    assert.equal(r.fileKind, 'html-before-footer');
    assert.ok(r.insertBeforeOffset < frag.length);
  });

  test('a layout fragment with no footer of its own still resolves at the end of the file, as before', () => {
    const frag = `---\nlayout: base.njk\n---\n<section><p>${long}</p></section>\n`;
    const r = detectInsertionPoint(frag, 'a.njk');
    assert.equal(r.fileKind, 'html-fragment');
  });
});

// superrank.si/product/content-gaps, as it is in the repository
const ASTRO_PREBUILT = `---
import Layout from '../../layouts/Layout.astro';
import body from '../../product-pages/content-gaps.html?raw';
---
<Layout title="Content Gap Analysis for AI Search and SEO | SuperRank" description="Find the topics competitors rank and get cited for.">

<main>
<Fragment set:html={body} />
</main>

<Fragment slot="scripts">
<script src="../../scripts/product.js"></script>
</Fragment>
</Layout>
`;

describe('an Astro page whose <main> only renders a prebuilt body', () => {
  test('resolves inside <main>, after the body, on its own line', () => {
    const r = detectInsertionPoint(ASTRO_PREBUILT, 'src/pages/product/content-gaps.astro');
    assert.equal(r.ok, true);
    assert.equal(r.fileKind, 'astro-prebuilt-body');
    assert.ok(ASTRO_PREBUILT.slice(r.insertBeforeOffset).startsWith('</main>'));
    assert.ok(ASTRO_PREBUILT.slice(0, r.insertBeforeOffset).endsWith('<Fragment set:html={body} />\n'));
  });

  test('a <main> with real content of its own never takes this path', () => {
    const real = ASTRO_PREBUILT.replace('<Fragment set:html={body} />', `<h1>Content gaps</h1><p>${long}</p>`);
    const r = detectInsertionPoint(real, 'src/pages/product/content-gaps.astro');
    assert.equal(r.fileKind, 'html');
  });

  test('a <main> with a prebuilt body AND something else is refused, not guessed', () => {
    const mixed = ASTRO_PREBUILT.replace('<Fragment set:html={body} />', '<Fragment set:html={body} /><Newsletter />');
    assert.equal(detectInsertionPoint(mixed, 'src/pages/a.astro').ok, false);
  });

  test('only an .astro page', () => {
    assert.equal(detectInsertionPoint(ASTRO_PREBUILT, 'src/pages/a.njk').fileKind === 'astro-prebuilt-body', false);
  });

  test('the trusted path finds the same place again', () => {
    const r = detectWithTrustedContainer(ASTRO_PREBUILT, 'src/pages/x.astro', 'astro-prebuilt-body', 'main (its prebuilt body, after it)');
    assert.equal(r.ok, true);
  });
});

describe('the page footer is not any element that has "footer" in its class', () => {
  const SECTION = `---\nlayout: base.njk\n---\n<section class="v2-ind"><p>${long}</p><div class="v2-ind-footer"><a href="/solutions/">All solutions</a></div></section>\n<section class="v2-last"><p>${long}</p></section>\n  {% include "_footer-v2.njk" %}\n`;
  test('a section footer earlier on the page is skipped; the footer include closes the page', () => {
    const r = detectInsertionPoint(SECTION, 'src/index.njk');
    assert.equal(r.fileKind, 'html-before-footer');
    assert.ok(SECTION.slice(r.insertBeforeOffset).startsWith('  {% include "_footer-v2.njk" %}'));
  });
  test('a <footer> element is preferred over a class that only says footer, and the last one wins', () => {
    const c = `---\nlayout: base.njk\n---\n<section><p>${long}</p><footer class="card-meta">by us</footer></section>\n<section><p>${long}</p></section>\n<footer class="site">f</footer>\n`;
    const r = detectInsertionPoint(c, 'a.njk');
    assert.ok(c.slice(r.insertBeforeOffset).startsWith('<footer class="site">'));
  });
  test('with nothing stronger, an element whose class says footer is still used', () => {
    const c = `---\n{ "x": 1 }\n---\n<section><p>${long}</p></section>\n<div class="site-footer">f</div>\n`;
    assert.equal(detectInsertionPoint(c, 'a.njk').fileKind, 'html-before-footer');
  });
});

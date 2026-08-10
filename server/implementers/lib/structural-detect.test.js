import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectInsertionPoint, isJsxFile, isHtmlLikeFile, isVueFile, isSvelteFile } from './structural-detect.js';

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

  test('refuses when the file has more than one JSX-returning function (ambiguous which is "the page")', () => {
    const file = 'function Icon() { return <svg><path /></svg>; }\n' +
      'export default function Page() { return <main><p>hi</p></main>; }\n';
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

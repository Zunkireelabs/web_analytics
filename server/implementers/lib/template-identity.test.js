import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTemplateIdentity } from './template-identity.js';

describe('front-matter layout (Eleventy/Jekyll/Astro content collections)', () => {
  test('resolves a named layout id from front matter', () => {
    const file = '---\ntitle: Hello\nlayout: post\n---\n# Hello';
    assert.equal(resolveTemplateIdentity(file, 'content/blog/hello.md'), 'layout:post');
  });

  test('resolves a quoted layout path from front matter', () => {
    const file = '---\nlayout: "layouts/blog-post.njk"\n---\nBody';
    assert.equal(resolveTemplateIdentity(file, 'content/blog/hello.md'), 'layout:layouts/blog-post.njk');
  });

  test('returns null when there is no layout field', () => {
    const file = '---\ntitle: Hello\n---\n# Hello';
    assert.equal(resolveTemplateIdentity(file, 'content/blog/hello.md'), null);
  });
});

describe('{% extends %} (Jinja/Django/Nunjucks/Twig)', () => {
  test('resolves the extended base template', () => {
    const file = '{% extends "layouts/base.html" %}\n{% block content %}<p>hi</p>{% endblock %}';
    assert.equal(resolveTemplateIdentity(file, 'templates/post.jinja2'), 'extends:layouts/base');
  });
});

describe('@extends() (Laravel Blade)', () => {
  test('resolves the dot-namespaced parent view', () => {
    const file = "@extends('layouts.app')\n@section('content')<p>hi</p>@endsection";
    assert.equal(resolveTemplateIdentity(file, 'resources/views/post.blade.php'), 'extends:layouts/app');
  });
});

describe('JSX/TSX wrapping component import', () => {
  test('resolves a relative Layout import to a normalized, extension-stripped path', () => {
    const file = "import Layout from '../layouts/BlogPost';\nexport default function Page() {\n  return <Layout><main><p>hi</p></main></Layout>;\n}\n";
    assert.equal(resolveTemplateIdentity(file, 'src/pages/blog/post-1.tsx'), 'component:src/pages/layouts/BlogPost');
  });

  test('two separate pages importing the same layout from different directories resolve to the SAME identity', () => {
    const layoutImport = "import Layout from '../layouts/BlogPost';\nexport default function Page() {\n  return <Layout><main><p>hi</p></main></Layout>;\n}\n";
    const a = resolveTemplateIdentity(layoutImport, 'src/pages/blog/post-a.tsx');
    const b = resolveTemplateIdentity(layoutImport, 'src/pages/blog/post-b.tsx');
    assert.equal(a, b);
  });

  test('keeps a bare/aliased import specifier in its own namespace rather than guessing a real path', () => {
    const file = "import Layout from '@/layouts/BlogPost';\nexport default function Page() {\n  return <Layout><p>hi</p></Layout>;\n}\n";
    assert.equal(resolveTemplateIdentity(file, 'src/pages/blog/post-1.tsx'), 'component-alias:@/layouts/BlogPost');
  });

  test('returns null when the root element is an intrinsic tag, not a wrapping component', () => {
    const file = 'export default function Page() {\n  return <div><p>hi</p></div>;\n}\n';
    assert.equal(resolveTemplateIdentity(file, 'src/pages/about.tsx'), null);
  });

  test('returns null when there are multiple returned JSX roots (ambiguous)', () => {
    const file = 'function Icon() { return <svg />; }\nexport default function Page() { return <Layout><p>hi</p></Layout>; }\n';
    assert.equal(resolveTemplateIdentity(file, 'src/pages/about.tsx'), null);
  });
});

describe('Vue SFC / Svelte wrapping component import', () => {
  test('resolves a Vue SFC\'s outer <Layout> from its <script> import', () => {
    const file = "<template>\n  <Layout>\n    <main><p>hi</p></main>\n  </Layout>\n</template>\n<script>\nimport Layout from '../layouts/BlogPost.vue';\nexport default {};\n</script>\n";
    assert.equal(resolveTemplateIdentity(file, 'src/pages/Post.vue'), 'component:src/layouts/BlogPost');
  });

  test('resolves a Svelte component\'s outer <Layout> from its <script> import', () => {
    const file = "<script>\n  import Layout from '../layouts/BlogPost.svelte';\n</script>\n<Layout>\n  <p>hi</p>\n</Layout>\n";
    assert.equal(resolveTemplateIdentity(file, 'src/routes/Post.svelte'), 'component:src/layouts/BlogPost');
  });

  test('returns null when there is no wrapping component', () => {
    const file = '<template><main><p>hi</p></main></template>';
    assert.equal(resolveTemplateIdentity(file, 'src/pages/Post.vue'), null);
  });
});

describe('unrelated file kinds', () => {
  test('returns null for a plain HTML file with no framework layout signal', () => {
    const file = '<html><body><main><p>hi</p></main></body></html>';
    assert.equal(resolveTemplateIdentity(file, 'index.html'), null);
  });
});

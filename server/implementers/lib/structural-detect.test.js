import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectInsertionPoint, isJsxFile, isHtmlLikeFile } from './structural-detect.js';

describe('file-type routing', () => {
  test('isJsxFile / isHtmlLikeFile', () => {
    assert.equal(isJsxFile('src/pages/about.tsx'), true);
    assert.equal(isJsxFile('src/pages/about.jsx'), true);
    assert.equal(isJsxFile('src/pages/about.astro'), false);
    assert.equal(isHtmlLikeFile('src/pages/about.astro'), true);
    assert.equal(isHtmlLikeFile('src/pages/about.njk'), true);
    assert.equal(isHtmlLikeFile('src/pages/about.tsx'), false);
  });

  test('refuses a file type with no structural strategy (e.g. plain .md — EOF is already safe there)', () => {
    const result = detectInsertionPoint('# Hello', 'content/post.md');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unsupported-file-type');
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

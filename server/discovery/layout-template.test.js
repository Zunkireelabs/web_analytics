import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chooseLayoutTemplate, deriveLayoutTemplate, verifyLayoutFile, candidatePaths, looksLikeLayout } from './layout-template.js';

const HTML = '<!doctype html><html lang="en"><head><title>x</title></head><body><slot /></body></html>';
const site = (extra = {}) => ({ id: 1, repo_owner: 'o', repo_name: 'r', repo_default_branch: 'main', url_file_map: {}, ...extra });
const repo = (files) => ({
  fetchTree: async () => ({ files: Object.keys(files), truncated: false }),
  fetchFile: async (_s, path) => (path in files ? { content: files[path], sha: 'x' } : null),
});

describe('which files can be a layout', () => {
  test('only a file that renders both <html> and <head>', () => {
    assert.equal(looksLikeLayout(HTML), true);
    assert.equal(looksLikeLayout('<div>just a component</div>'), false);
    assert.equal(looksLikeLayout('<html><body></body></html>'), false);
  });
  test('build output, dependencies and tests are never candidates', () => {
    const got = candidatePaths(['src/layouts/Layout.astro', 'node_modules/x/index.html', 'dist/index.html', 'src/a.test.js', 'README.md', 'tests/page.html']);
    assert.deepEqual(got, ['src/layouts/Layout.astro']);
  });
});

describe('chooseLayoutTemplate', () => {
  test('the only file that renders html and head is the layout', () => {
    const r = chooseLayoutTemplate([{ path: 'src/layouts/Layout.astro', content: HTML }]);
    assert.equal(r.path, 'src/layouts/Layout.astro');
  });
  test("a framework's own root layout wins over other candidates", () => {
    const r = chooseLayoutTemplate([{ path: 'app/layout.tsx', content: HTML }, { path: 'components/Email.tsx', content: HTML }]);
    assert.equal(r.path, 'app/layout.tsx');
  });
  test('otherwise the layout most pages actually use, when clearly ahead', () => {
    const pages = ["import L from '../layouts/Base.astro'", "import L from '../layouts/Base.astro'", "import L from '../layouts/Base.astro'", "import B from '../layouts/Blog.astro'"];
    const r = chooseLayoutTemplate([{ path: 'src/layouts/Base.astro', content: HTML }, { path: 'src/layouts/Blog.astro', content: HTML }], pages);
    assert.equal(r.path, 'src/layouts/Base.astro');
  });
  test('refuses to pick when it cannot tell, and says which files it saw', () => {
    const pages = ["import L from '../layouts/A.astro'", "import L from '../layouts/B.astro'"];
    const r = chooseLayoutTemplate([{ path: 'src/layouts/A.astro', content: HTML }, { path: 'src/layouts/B.astro', content: HTML }], pages);
    assert.equal(r.path, null);
    assert.equal(r.reason, 'several-layouts-no-clear-owner');
    assert.deepEqual(r.options.sort(), ['src/layouts/A.astro', 'src/layouts/B.astro']);
  });
  test('no candidate at all is reported, not invented', () => {
    assert.deepEqual(chooseLayoutTemplate([]), { path: null, reason: 'no-file-renders-html-and-head' });
  });
});

describe('verifyLayoutFile', () => {
  test('accepts a file the viewport fixer can edit, with or without a viewport tag already there', () => {
    assert.equal(verifyLayoutFile(HTML), true);
    assert.equal(verifyLayoutFile(HTML.replace('<head>', '<head><meta name="viewport" content="width=device-width, initial-scale=1">')), true);
  });
  test('rejects a file with no head', () => {
    assert.equal(verifyLayoutFile('<html><body></body></html>'), false);
  });
});

describe('deriveLayoutTemplate (real flow, fake repo)', () => {
  test('finds the Astro layout from the repository alone', async () => {
    const r = await deriveLayoutTemplate(site(), repo({ 'src/layouts/Layout.astro': HTML, 'src/pages/index.astro': "import L from '../layouts/Layout.astro'", 'package.json': '{}' }));
    assert.equal(r.path, 'src/layouts/Layout.astro');
  });
  test('never replaces a layout a person already set', async () => {
    const r = await deriveLayoutTemplate(site({ url_file_map: { siteRoot: { layoutTemplate: 'custom/base.njk' } } }), { fetchTree: async () => { throw new Error('must not read the repo'); } });
    assert.deepEqual([r.path, r.kept], ['custom/base.njk', true]);
  });
  test('a project with no repo is not an error', async () => {
    assert.deepEqual(await deriveLayoutTemplate({ id: 1, url_file_map: {} }), { path: null, reason: 'no-repo-configured' });
  });
  test('two plausible layouts and no usage evidence leaves it unset', async () => {
    const r = await deriveLayoutTemplate(site(), repo({ 'src/layouts/A.astro': HTML, 'src/layouts/B.astro': HTML }));
    assert.equal(r.path, null);
  });
});

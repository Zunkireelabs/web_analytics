import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveRenderCapabilities, deriveNewContentTargets, deriveContentConfig, persistDerivedContentConfig,
} from './derive-repo-content-config.js';

function pageType({ directory, extensions, fileCount = 5, name }) {
  return { directory, name: name || directory, extensions, fileCount };
}

describe('deriveRenderCapabilities', () => {
  test('proves markdown:true only when the framework is Markdown-native AND the repo publishes .md pages', () => {
    const result = deriveRenderCapabilities({
      framework: { id: 'eleventy', name: 'Eleventy' },
      pageTypes: [pageType({ directory: 'src/blog', extensions: ['.md'] })],
    });
    assert.equal(result.renderCapabilities.extensions['.md'].markdown, true);
    assert.equal(result.markdownProven, true);
    assert.deepEqual(result.gaps, []);
  });

  test('never claims markdown:true for a non-Markdown-native framework, and reports the gap', () => {
    const result = deriveRenderCapabilities({
      framework: { id: 'nextjs', name: 'Next.js' },
      pageTypes: [pageType({ directory: 'content', extensions: ['.md'] })],
    });
    assert.equal(result.renderCapabilities.extensions['.md'].markdown, false);
    assert.equal(result.markdownProven, false);
    assert.equal(result.gaps.length, 1);
  });

  test('records non-Markdown extensions as markdown:false regardless of framework', () => {
    const result = deriveRenderCapabilities({
      framework: { id: 'eleventy', name: 'Eleventy' },
      pageTypes: [pageType({ directory: 'src/pages', extensions: ['.njk'] })],
    });
    assert.equal(result.renderCapabilities.extensions['.njk'].markdown, false);
  });

  test('never overwrites a hand-authored entry, even to widen it', () => {
    const result = deriveRenderCapabilities({
      framework: { id: 'eleventy', name: 'Eleventy' },
      pageTypes: [pageType({ directory: 'src/blog', extensions: ['.md'] })],
      existing: { generator: 'eleventy', extensions: { '.md': { markdown: false } }, overrides: { 'landing-page': { markdown: true } } },
    });
    assert.equal(result.renderCapabilities.extensions['.md'].markdown, false);
    assert.deepEqual(result.renderCapabilities.overrides, { 'landing-page': { markdown: true } });
  });

  test('no framework detected leaves everything markdown:false', () => {
    const result = deriveRenderCapabilities({ framework: null, pageTypes: [pageType({ directory: 'content', extensions: ['.md'] })] });
    assert.equal(result.renderCapabilities.extensions['.md'].markdown, false);
    assert.equal(result.markdownProven, false);
  });
});

describe('deriveNewContentTargets', () => {
  const rc = { extensions: { '.md': { markdown: true } } };

  test('picks the largest proven Markdown directory as the general target', () => {
    const result = deriveNewContentTargets({
      pageTypes: [
        pageType({ directory: 'src/pages', extensions: ['.md'], fileCount: 3 }),
        pageType({ directory: 'src/docs', extensions: ['.md'], fileCount: 10 }),
      ],
      renderCapabilities: rc,
    });
    assert.equal(result.newContentTargets['missing-page-create'].dir, 'src/docs');
    assert.equal(result.derived.find((d) => d.type === 'missing-page-create').dir, 'src/docs');
  });

  test('routes blog-outline to a directory named like a blog even when it is smaller', () => {
    const result = deriveNewContentTargets({
      pageTypes: [
        pageType({ directory: 'src/pages', extensions: ['.md'], fileCount: 20, name: 'pages' }),
        pageType({ directory: 'src/blog', extensions: ['.md'], fileCount: 4, name: 'blog' }),
      ],
      renderCapabilities: rc,
    });
    assert.equal(result.newContentTargets['blog-outline'].dir, 'src/blog');
    assert.equal(result.newContentTargets['landing-page'].dir, 'src/pages');
  });

  test('never overwrites an existing target', () => {
    const result = deriveNewContentTargets({
      pageTypes: [pageType({ directory: 'src/pages', extensions: ['.md'] })],
      renderCapabilities: rc,
      existing: { 'landing-page': { dir: 'src/hand-authored', extension: '.md' } },
    });
    assert.equal(result.newContentTargets['landing-page'].dir, 'src/hand-authored');
    assert.equal(result.derived.some((d) => d.type === 'landing-page'), false);
  });

  test('refuses to target a directory whose extension is not proven Markdown-safe', () => {
    const result = deriveNewContentTargets({
      pageTypes: [pageType({ directory: 'src/pages', extensions: ['.md'] })],
      renderCapabilities: { extensions: { '.md': { markdown: false } } },
    });
    assert.deepEqual(result.newContentTargets, {});
    assert.equal(result.gaps.length, 1);
  });

  test('refuses a mixed-extension directory even if one extension is Markdown-safe', () => {
    const result = deriveNewContentTargets({
      pageTypes: [pageType({ directory: 'src/pages', extensions: ['.md', '.njk'] })],
      renderCapabilities: rc,
    });
    assert.deepEqual(result.newContentTargets, {});
  });

  test('reports a clear gap, not a guess, when no directory is usable', () => {
    const result = deriveNewContentTargets({ pageTypes: [], renderCapabilities: rc });
    assert.deepEqual(result.newContentTargets, {});
    assert.match(result.gaps[0], /No directory/);
  });
});

describe('deriveContentConfig', () => {
  test('produces a patch only for what was actually derived', () => {
    const result = deriveContentConfig({
      technology: { framework: { id: 'eleventy', name: 'Eleventy' } },
      structure: { pageTypes: [pageType({ directory: 'src/blog', extensions: ['.md'], fileCount: 6 })] },
      existingUrlFileMap: {},
    });
    assert.ok(result.patch.renderCapabilities);
    assert.ok(result.patch.newContentTargets);
    assert.equal(result.patch.newContentTargets['blog-outline'].dir, 'src/blog');
  });

  test('empty patch and a gap when nothing is provable', () => {
    const result = deriveContentConfig({
      technology: { framework: { id: 'nextjs' } },
      structure: { pageTypes: [] },
      existingUrlFileMap: {},
    });
    assert.deepEqual(result.patch, {});
    assert.ok(result.gaps.length >= 0);
  });
});

describe('persistDerivedContentConfig', () => {
  test('merges the patch into the existing url_file_map and saves once', async () => {
    const saved = [];
    const site = { id: 8862, url_file_map: { pages: { '/': 'index.html' } } };
    const discovery = {
      technology: { framework: { id: 'eleventy', name: 'Eleventy' } },
      structure: { pageTypes: [pageType({ directory: 'src/blog', extensions: ['.md'], fileCount: 6 })] },
    };
    const result = await persistDerivedContentConfig(site, discovery, {
      saveConfig: async ({ siteId, urlFileMap }) => { saved.push({ siteId, urlFileMap }); return { id: siteId, url_file_map: urlFileMap }; },
    });
    assert.equal(result.applied, true);
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].urlFileMap.pages, { '/': 'index.html' });
    assert.ok(saved[0].urlFileMap.newContentTargets);
  });

  test('does not save when nothing could be derived', async () => {
    let called = false;
    const site = { id: 1, url_file_map: {} };
    const discovery = { technology: { framework: null }, structure: { pageTypes: [] } };
    const result = await persistDerivedContentConfig(site, discovery, { saveConfig: async () => { called = true; } });
    assert.equal(result.applied, false);
    assert.equal(called, false);
  });
});

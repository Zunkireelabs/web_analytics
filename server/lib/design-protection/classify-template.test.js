import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChange, visiblePart, filesChangeVisibleOutput, touchesSharedFiles, CONFIRMED_NOT_VISIBLE } from './classify-change.js';
import { templateKeyFor, referencePagesFor, stripPlatformMarkers, urlsForTemplateKey, absoluteUrls } from './template.js';

describe('visible vs not visible', () => {
  test('every content generator is visible: blog, FAQ, expanded content, tables, related links, breadcrumbs, new pages', () => {
    for (const g of ['blog-outline', 'faq', 'qa-content', 'expand-content', 'refresh-content', 'internal-links', 'breadcrumbs', 'comparison-table', 'landing-page', 'direct-answer', 'blog-image']) {
      const c = classifyChange({ generatorId: g });
      assert.equal(c.visible, true, g); assert.equal(c.source, 'generator', g);
    }
  });
  test('format kinds must copy an existing pattern; prose and articles do not', () => {
    assert.equal(classifyChange({ generatorId: 'faq' }).format, true);
    assert.equal(classifyChange({ generatorId: 'comparison-table' }).format, true);
    assert.equal(classifyChange({ generatorId: 'internal-links' }).format, true);
    assert.equal(classifyChange({ generatorId: 'breadcrumbs' }).format, true);
    assert.equal(classifyChange({ generatorId: 'blog-outline' }).format, false);
    assert.equal(classifyChange({ generatorId: 'expand-content' }).format, false);
  });
  test('the confirmed no-markup generators are not visible', () => {
    for (const g of ['meta-description', 'robots', 'sitemap', 'llms-txt', 'schema', 'canonical', 'alt-text']) assert.equal(classifyChange({ generatorId: g }).visible, false, g);
    assert.ok(CONFIRMED_NOT_VISIBLE.has('robots'));
  });
  test('an UNKNOWN generator is judged by default (deny-list, never an allow-list)', () => {
    const c = classifyChange({ generatorId: 'brand-new-generator' });
    assert.equal(c.visible, true); assert.equal(c.source, 'unknown-default');
    assert.equal(classifyChange({}).visible, true);
  });
  test('a meta-title change is visible exactly when the title is also the headline (the Zunkiree case)', () => {
    assert.equal(classifyChange({ generatorId: 'meta-title', titleIsHeadline: true }).visible, true);
    assert.equal(classifyChange({ generatorId: 'meta-title' }).visible, true, 'unknown => judged');
    assert.equal(classifyChange({ generatorId: 'meta-title', titleIsHeadline: false }).visible, false);
  });
  test('the stricter signal wins: a "schema" change whose files add a visible FAQ is visible', () => {
    const files = [{ path: 'src/a.md', before: '---\ntitle: A\n---\nBody', after: '---\ntitle: A\n---\nBody\n\n## FAQ\n\n**Q?** yes' }];
    const c = classifyChange({ generatorId: 'schema', files });
    assert.equal(c.visible, true); assert.equal(c.source, 'content'); assert.deepEqual(c.changedFiles, ['src/a.md']);
  });
  test('JSON-LD-only, head-only and hidden front-matter edits are not visible', () => {
    const html = (extra) => `<html><head><title>T</title>${extra}</head><body><h1>H</h1><p>Body</p></body></html>`;
    assert.deepEqual(filesChangeVisibleOutput([{ path: 'a.html', before: html(''), after: html('<script type="application/ld+json">{"@type":"Article"}</script><meta name="description" content="x">') }]), []);
    assert.deepEqual(filesChangeVisibleOutput([{ path: 'a.md', before: '---\ntitle: T\ndescription: old\n---\nBody', after: '---\ntitle: T\ndescription: a new description\nseoTitle: S\n---\nBody' }]), []);
    assert.equal(classifyChange({ generatorId: 'meta-description', files: [{ path: 'a.md', before: '---\ntitle: T\ndescription: a\n---\nB', after: '---\ntitle: T\ndescription: b\n---\nB' }] }).visible, false);
  });
  test('a changed headline in front matter IS visible; a new page file is visible', () => {
    assert.equal(filesChangeVisibleOutput([{ path: 'a.md', before: '---\ntitle: Old\n---\nB', after: '---\ntitle: New\n---\nB' }]).length, 1);
    assert.equal(filesChangeVisibleOutput([{ path: 'new.md', before: '', after: '---\ntitle: N\n---\nBody text' }]).length, 1);
  });
  test('SEOAI marker comments count (changing a marker block is changing visible output)', () => {
    assert.equal(visiblePart('<!-- SEOAI:FAQ:START --><p>x</p><!-- SEOAI:FAQ:END -->').includes('SEOAI:FAQ:START'), true);
  });
  test('shared files are recognised: layouts, partials, components, stylesheets; a page content file is not', () => {
    assert.deepEqual(touchesSharedFiles(['src/_includes/base.njk', 'src/blog/post.md', 'public/css/site.css', 'src/components/Faq.tsx', 'tailwind.config.js']).length, 4);
    assert.deepEqual(touchesSharedFiles(['src/blog/post.md', 'src/pages/about.md']), []);
  });
});

describe('template identity: this page\'s own template, never another', () => {
  const profile = {
    layoutGroups: { groups: [{ id: 'g1', sample: '/blog/a', members: ['/blog/a', '/blog/b', '/blog/c', '/blog/d'] }, { id: 'g2', sample: '/legal/privacy', members: ['/legal/privacy', '/legal/terms'] }] },
    pages: [{ url: 'https://x.test/blog/a', pageType: 'blog-article' }, { url: 'https://x.test/services/seo', pageType: 'service' }, { url: 'https://x.test/services/ads', pageType: 'service' }],
  };
  test('a surveyed page gets its layout group', () => {
    const t = templateKeyFor(profile, '/blog/b');
    assert.deepEqual([t.key, t.source], ['group:g1', 'layout-group']);
    assert.notEqual(templateKeyFor(profile, '/legal/terms').key, t.key, 'a legal page is a different template from a blog post');
  });
  test('an unsurveyed page falls back to its captured type + first path segment', () => {
    const t = templateKeyFor(profile, 'https://x.test/services/seo');
    assert.deepEqual([t.key, t.source], ['type:service:services', 'page-type']);
  });
  test('a page with no group, no capture and no type has NO template: no baseline can be assumed', () => {
    assert.equal(templateKeyFor(profile, '/mystery/page'), null);
    assert.equal(templateKeyFor(null, '/blog/a'), null);
    assert.equal(templateKeyFor(profile, null), null);
  });
  test('reference pages are of the same template only, the edited page excluded, capped', () => {
    const t = templateKeyFor(profile, '/blog/b');
    assert.deepEqual(referencePagesFor(t, { excludeUrl: '/blog/b', max: 3 }), ['/blog/a', '/blog/c', '/blog/d']);
    assert.ok(referencePagesFor(t).every((u) => u.startsWith('/blog/')));
    assert.deepEqual(referencePagesFor(null), []);
  });
  test('urlsForTemplateKey inverts the key, and absoluteUrls keeps only the project\'s own origin', () => {
    assert.deepEqual(urlsForTemplateKey(profile, 'group:g2'), ['/legal/privacy', '/legal/terms']);
    assert.deepEqual(urlsForTemplateKey(profile, 'type:service:services').length, 2);
    assert.deepEqual(urlsForTemplateKey(profile, 'nonsense'), []);
    assert.deepEqual(absoluteUrls(['/blog/a', 'https://other-client.test/blog/a', 'https://x.test/blog/b'], 'https://x.test'), ['https://x.test/blog/a', 'https://x.test/blog/b']);
    assert.deepEqual(absoluteUrls(['/a'], null), []);
  });
});

describe('platform output never counts as the site\'s design', () => {
  test('SEOAI block content is removed, the markers stay', () => {
    const html = '<p>real</p><!-- SEOAI:FAQ:START --><div class="text-2xl md:text-3xl">platform faq</div><!-- SEOAI:FAQ:END --><p>more</p>';
    const out = stripPlatformMarkers(html);
    assert.ok(!out.includes('text-2xl')); assert.ok(out.includes('<!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END -->')); assert.ok(out.includes('<p>real</p>') && out.includes('<p>more</p>'));
  });
  test('two different markers are stripped independently', () => {
    const out = stripPlatformMarkers('<!-- SEOAI:FAQ:START -->a<!-- SEOAI:FAQ:END -->mid<!-- SEOAI:INTERNALLINKS:START -->b<!-- SEOAI:INTERNALLINKS:END -->');
    assert.ok(!out.includes('>a<') && !out.includes('>b<') && out.includes('mid'));
  });
});

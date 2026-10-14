import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectTechnology, confidenceFromScore } from './detect-technology.js';
import { discoverPageStructure, classifyFile } from './discover-page-structure.js';
import { decideAutonomy } from './run-discovery.js';
import { resolveRoute } from './discover-routes.js';
import { __testables as autoCfg } from './auto-configure.js';
const { isProjectable, projectFinding, AUTO_WRITABLE } = autoCfg;

// The properties under test are the safety ones: that confidence comes from
// corroborating evidence rather than assertion, that blast radius — not
// confidence — decides what may be applied unattended, and that ambiguity is
// surfaced instead of resolved by picking a winner.

describe('detectTechnology', () => {
  const ELEVENTY = {
    files: ['.eleventy.js', 'package-lock.json', 'src/_includes/layouts/base.njk', 'src/_data/x.js', 'src/blog/a.md'],
    packageJsonRaw: JSON.stringify({ dependencies: { '@11ty/eleventy': '^3.1.2' }, scripts: { build: 'eleventy' } }),
  };

  test('identifies a framework from independent, corroborating evidence', () => {
    const t = detectTechnology(ELEVENTY);
    assert.equal(t.framework.id, 'eleventy');
    assert.equal(t.framework.confidence.level, 'high');
    const kinds = new Set(t.framework.evidence.map((e) => e.kind));
    assert.ok(kinds.has('dependency') && kinds.has('config-file'),
      'the verdict must rest on more than one kind of signal');
  });

  test('every piece of evidence names the file it came from', () => {
    // §8: a reader must be able to check the reasoning, not trust a number.
    for (const e of detectTechnology(ELEVENTY).framework.evidence) {
      assert.ok(e.source && e.detail, 'evidence must cite a source and say what it showed');
    }
  });

  test('conventional directories alone never outweigh a declared dependency', () => {
    // src/pages exists in Next.js, Astro and Eleventy repos alike — treating
    // that as proof would mislabel any repo that happens to use the name.
    const t = detectTechnology({ files: ['src/pages/a.njk', 'src/layouts/b.njk'], packageJsonRaw: null });
    assert.notEqual(t.framework?.confidence.level, 'high');
  });

  test('a genuinely ambiguous repo is reported as ambiguous, not silently resolved', () => {
    // A real mid-migration repo. Picking the higher score would produce
    // confident mappings against the wrong ecosystem.
    const t = detectTechnology({
      files: ['next.config.js', 'astro.config.mjs', 'src/pages/a.astro'],
      packageJsonRaw: JSON.stringify({ dependencies: { next: '14', astro: '4' } }),
    });
    assert.equal(t.framework.ambiguous, true);
    assert.ok(t.framework.alternatives.length > 0, 'the runner-up is never discarded');
  });

  test('a repo with no package.json still detects (Hugo/Jekyll are not Node projects)', () => {
    const t = detectTechnology({ files: ['_config.yml', '_layouts/default.html', '_posts/a.md'], packageJsonRaw: null });
    assert.equal(t.framework.id, 'jekyll');
  });

  test('confidence is a function of score, never asserted', () => {
    assert.equal(confidenceFromScore(9).level, 'high');
    assert.equal(confidenceFromScore(4).level, 'medium');
    assert.equal(confidenceFromScore(0).level, 'none');
  });
});

describe('discoverPageStructure', () => {
  const FILES = [
    'src/_includes/layouts/base.njk',
    'src/_includes/components/nav.njk',
    'src/_data/glossary.js',
    'src/blog/a.md', 'src/blog/b.md', 'src/blog/c.md', 'src/blog/d.md', 'src/blog/e.md',
    'src/pages/about.njk',
    'dist/index.html',
    'assets/logo.svg',
  ];
  const TEMPLATES = [{ id: 'nunjucks', extensions: ['.njk'] }, { id: 'markdown', extensions: ['.md'] }];

  test('separates shared infrastructure from page content — the blast-radius distinction', () => {
    const s = discoverPageStructure({ files: FILES, templateLanguages: TEMPLATES });
    const shared = s.sharedInfrastructure.map((x) => x.path);
    assert.ok(shared.includes('src/_includes/layouts/base.njk'));
    assert.ok(!shared.includes('src/blog/a.md'), 'a single post is not shared infrastructure');
  });

  test('shared infrastructure is always high risk and always needs confirmation', () => {
    // A layout edit can change hundreds of pages; it must never be low-risk.
    for (const s of discoverPageStructure({ files: FILES, templateLanguages: TEMPLATES }).sharedInfrastructure) {
      assert.equal(s.risk, 'high');
      assert.equal(s.requiresConfirmation, true);
    }
  });

  test('a repeating page family is recognised and scored above a one-off', () => {
    const s = discoverPageStructure({ files: FILES, templateLanguages: TEMPLATES });
    const blog = s.pageTypes.find((p) => p.directory === 'src/blog');
    assert.equal(blog.kind, 'repeating-family');
    assert.equal(blog.confidence.level, 'high');
    const pages = s.pageTypes.find((p) => p.directory === 'src/pages');
    assert.ok(pages.confidence.value < blog.confidence.value, 'one page is weaker evidence than five');
  });

  test('build output and assets are excluded from page discovery', () => {
    const s = discoverPageStructure({ files: FILES, templateLanguages: TEMPLATES });
    const all = s.pageTypes.flatMap((p) => p.files);
    assert.ok(!all.includes('dist/index.html'), 'generated output is not source');
    assert.ok(!all.some((f) => f.endsWith('.svg')));
  });

  test('classification is by path segment, not substring', () => {
    // "src/blog/includes-me.md" must not be mistaken for shared _includes.
    assert.equal(classifyFile('src/blog/includes-me.md', { templateExtensions: ['.md'] }).role, 'page-content');
  });
});

describe('decideAutonomy', () => {
  test('high confidence never licenses auto-applying a high-risk change', () => {
    // The core safety asymmetry: blast radius outranks certainty.
    const d = decideAutonomy({ confidence: 0.99, risk: 'high' });
    assert.equal(d.autoConfigure, false);
    assert.equal(d.status, 'needs_confirmation');
  });

  test('high confidence AND low risk configures automatically', () => {
    const d = decideAutonomy({ confidence: 0.95, risk: 'low' });
    assert.equal(d.autoConfigure, true);
    assert.equal(d.status, 'auto_configured');
  });

  test('medium confidence asks, regardless of low risk', () => {
    assert.equal(decideAutonomy({ confidence: 0.65, risk: 'low' }).autoConfigure, false);
  });

  test('no evidence stays unresolved rather than becoming a question', () => {
    assert.equal(decideAutonomy({ confidence: 0, risk: 'low' }).status, 'discovered');
  });
});

describe('resolveRoute', () => {
  test('a page\'s own permalink wins — directory names are not routes', () => {
    // src/pages/about.njk really publishes at /about/, not /pages/about/.
    const r = resolveRoute('src/pages/about.njk', { content: '---\nlayout: base.njk\npermalink: /about/\n---\nbody' });
    assert.equal(r.route, '/about/');
    assert.equal(r.via, 'front-matter');
    assert.equal(r.evidence[0].kind, 'front-matter-permalink');
  });

  test('a directory data file routes every file in that directory', () => {
    // The 22 blog posts never declare a permalink themselves.
    const defaults = new Map([['src/blog', { source: 'src/blog/blog.json', data: { permalink: '/blog/{{ page.fileSlug }}/' } }]]);
    const r = resolveRoute('src/blog/my-post.md', { content: '---\ntitle: X\n---\n', directoryDefaults: defaults });
    assert.equal(r.route, '/blog/my-post/');
    assert.equal(r.via, 'directory-data');
  });

  test('index files take their parent directory as slug', () => {
    const defaults = new Map([['src/blog', { source: 'src/blog/blog.json', data: { permalink: '/blog/{{ page.fileSlug }}/' } }]]);
    assert.equal(resolveRoute('src/blog/index.md', { content: '', directoryDefaults: defaults }).route, '/blog/blog/');
  });

  test('an unresolvable template is refused, never emitted literally', () => {
    // Publishing "{{ page.date }}" as a literal route would 404.
    const defaults = new Map([['src/x', { source: 'src/x/x.json', data: { permalink: '/{{ collections.weird }}/' } }]]);
    assert.equal(resolveRoute('src/x/a.md', { content: '', directoryDefaults: defaults }), null);
  });

  test('no permalink evidence anywhere means no route is claimed', () => {
    // §5: a route without repository evidence must not be invented.
    assert.equal(resolveRoute('src/pages/mystery.njk', { content: '---\ntitle: X\n---\n' }), null);
  });

  test('permalink: false means the page is not published', () => {
    assert.equal(resolveRoute('src/x/a.md', { content: '---\npermalink: false\n---\n' }), null);
  });
});

describe('auto-configure projection', () => {
  const family = (over = {}) => ({
    category: 'route-family', subject: 'src/blog', confidence: 0.95, risk: 'low',
    finding: { routePattern: '^/blog/([^/]+)/?$', templateFile: 'src/blog/$1.md', sampleRoutes: ['/blog/a/'], ...over },
  });

  test('refuses to project a high-risk finding no matter how confident', () => {
    const r = isProjectable({ confidence: 0.99, risk: 'high' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /blast radius/);
  });

  test('skips a family an existing configuration already resolves, even under a different regex', () => {
    // The real bug this caught: '^/blog/([^/]+)$' and '^/blog/([^/]+)/?$' are
    // different strings that resolve identically — comparing text appended a
    // redundant duplicate.
    const existing = { patterns: [{ match: '^/blog/([^/]+)$', file: 'src/blog/$1.md' }] };
    const p = projectFinding(family(), existing);
    assert.equal(p.skip, true);
    assert.match(p.reason, /already resolvable/);
  });

  test('projects into a genuinely empty configuration', () => {
    const p = projectFinding(family(), {});
    assert.equal(p.key, 'patterns');
    assert.deepEqual(p.next, [{ match: '^/blog/([^/]+)/?$', file: 'src/blog/$1.md' }]);
  });

  test('never overwrites a generator a human already recorded', () => {
    const p = projectFinding(
      { category: 'technology', finding: { id: 'eleventy' } },
      { renderCapabilities: { generator: 'astro' } }
    );
    assert.equal(p.skip, true);
  });

  test('only an allow-listed key may ever be written automatically', () => {
    // Layout templates, componentTemplates and build config must not appear.
    assert.deepEqual([...AUTO_WRITABLE].sort(), ['pages', 'patterns', 'renderCapabilities']);
  });

  test('static-routes projects exact pages{} entries, skipping any URL already resolvable', () => {
    const finding = {
      category: 'static-routes',
      finding: { routes: [{ route: '/about', file: 'src/app/about/page.tsx' }, { route: '/', file: 'src/app/page.tsx' }] },
    };
    const existing = { pages: { '/': { file: 'src/app/CUSTOM.tsx' } } };
    const p = projectFinding(finding, existing);
    assert.equal(p.key, 'pages');
    assert.deepEqual(p.next['/about'], { file: 'src/app/about/page.tsx' });
    assert.equal(p.next['/'].file, 'src/app/CUSTOM.tsx', 'an already-resolvable route must never be overwritten');
    assert.deepEqual(p.additions, [{ route: '/about', file: 'src/app/about/page.tsx' }]);
  });

  test('a component template language (jsx/tsx) is recorded as markdown: false, never left unset', () => {
    const p = projectFinding(
      { category: 'technology', finding: { id: 'nextjs', templateLanguages: [{ id: 'jsx' }] } },
      {}
    );
    assert.equal(p.key, 'renderCapabilities');
    assert.deepEqual(p.next.extensions['.tsx'], { markdown: false });
    assert.deepEqual(p.next.extensions['.jsx'], { markdown: false });
  });
});

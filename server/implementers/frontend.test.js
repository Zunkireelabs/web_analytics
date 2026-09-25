import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargetAndBody, FRONTEND_ACTION_TYPES, COMPLIANCE_ACTION_TYPES, computeGeneratedPostsManifestUpdate } from './frontend.js';

describe('resolveTargetAndBody — generation-time-prepared fast path', () => {
  test('a draft with rendered_body/target_file_path already set is returned verbatim, no recomputation', async () => {
    const draft = {
      action_type: 'privacy-policy',
      rendered_body: '---\ntitle: "Privacy Policy"\n---\n\n# Privacy Policy\n',
      target_file_path: 'src/pages/privacy-policy.njk',
      content: { headline: 'Privacy Policy' },
    };
    // No site.repo_owner/repo_name/url_file_map at all — if this fell
    // through to the real computation path it would throw/return not-ok.
    const result = await resolveTargetAndBody({}, draft);
    assert.equal(result.ok, true);
    assert.equal(result.filePath, 'src/pages/privacy-policy.njk');
    assert.equal(result.body, draft.rendered_body);
    assert.equal(result.contentFormat, 'markdown');
  });

  test('a draft with only one of the two prepared fields set falls through to real computation, not a broken fast path', async () => {
    const draft = { action_type: 'landing-page', rendered_body: 'some body', target_file_path: null, content: {} };
    const result = await resolveTargetAndBody({ url_file_map: {} }, draft);
    // Falls through to the real landing-page branch, which fails honestly
    // (no newContentTargets configured) rather than silently using a
    // half-prepared cache.
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-file-mapping');
  });

  test('a draft with neither prepared field set computes fresh, unaffected by the fast path', async () => {
    const draft = { action_type: 'blog-outline', content: { title: 'Hello' } };
    const result = await resolveTargetAndBody({ url_file_map: {} }, draft);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-file-mapping');
  });
});

// A site whose config says "wrap every new page in base.njk" — the setting
// that produced the original incident. Its real directories disagree: src/pages
// gets its layout from elsewhere and declares none, and /about is on page.njk.
const SITE = {
  id: 1,
  repo_owner: 'Zunkireelabs',
  repo_name: 'zunkireelabs-web',
  repo_default_branch: 'main',
  url_file_map: {
    pages: { '/about/': { file: 'src/pages/about.njk' } },
    siteRoot: { layoutTemplate: 'src/_includes/base.njk' },
    newContentTargets: {
      'landing-page': { dir: 'src/pages', extension: '.njk' },
      'privacy-policy': { dir: 'src/pages', extension: '.njk' },
      translation: {},
    },
  },
};

const REPO = {
  // Real pages, none declaring a layout: a directory data file supplies it.
  'src/pages/pricing.njk': '---\ntitle: "Pricing"\n---\n',
  'src/pages/contact.njk': '---\ntitle: "Contact"\n---\n',
  // Except /about, which is on its own layout — the translation fixture.
  'src/pages/about.njk': '---\nlayout: page.njk\npermalink: /about/\ntitle: "About"\n---\n',
};

// `cache: null` — these tests assert on repo reads, and a cache shared with
// another test file's fixtures would make that meaningless.
function repoDeps(files, counts = {}) {
  return {
    cache: null,
    getRepoTree: async () => { counts.tree = (counts.tree || 0) + 1; return { files: Object.keys(files), truncated: false }; },
    // { content, sha } — the REAL getFileContent contract (github/client.js),
    // not a bare string.
    getFileContent: async (_site, path) => {
      counts.reads = (counts.reads || 0) + 1;
      return files[path] === undefined ? null : { content: files[path], sha: 'sha-fake' };
    },
  };
}

function layoutOf(body) {
  const m = /^layout:\s*"?([^"\n]*)"?$/m.exec(body);
  return m ? m[1] : null;
}

// One bug, five net-new-content branches. blog-outline and direct-answer were
// fixed first; these are the three that were still resolving `layout` from
// per-site config and so still writing a page out of its own template.
describe('resolveTargetAndBody — layout comes from the repo, not from config', () => {
  test('landing-page declares no layout when the target directory\'s pages declare none', async () => {
    const draft = { action_type: 'landing-page', content: { headline: 'AI Consulting', sections: [] } };
    const result = await resolveTargetAndBody(SITE, draft, repoDeps(REPO));
    assert.equal(result.ok, true);
    assert.equal(result.filePath, 'src/pages/ai-consulting.njk');
    assert.equal(layoutOf(result.body), null, 'config would have written base.njk over the directory\'s own layout');
  });

  test('landing-page still falls back to the configured layout when nothing is readable', async () => {
    const draft = { action_type: 'landing-page', content: { headline: 'AI Consulting', sections: [] } };
    const result = await resolveTargetAndBody(SITE, draft, repoDeps({}));
    assert.equal(layoutOf(result.body), 'base.njk', 'no siblings is not evidence — keep today\'s behavior');
  });

  test('a translation inherits the layout of the exact page it translates', async () => {
    const draft = {
      action_type: 'translation',
      content: { page: 'https://example.com/about/', targetLanguage: 'Spanish', translatedTitle: 'Sobre nosotros', translatedContent: 'Hola' },
    };
    const result = await resolveTargetAndBody(SITE, draft, repoDeps(REPO));
    assert.equal(result.ok, true);
    assert.equal(result.filePath, 'src/pages/about.es.njk');
    // Not base.njk (config) and not null (what a majority vote over src/pages
    // would have said, since most pages there declare none) — /about's own.
    assert.equal(layoutOf(result.body), 'page.njk');
  });

  test('a translation whose source page is unreadable keeps the configured layout', async () => {
    const draft = {
      action_type: 'translation',
      content: { page: 'https://example.com/about/', targetLanguage: 'Spanish', translatedContent: 'Hola' },
    };
    const result = await resolveTargetAndBody(SITE, draft, repoDeps({}));
    assert.equal(layoutOf(result.body), 'base.njk');
  });

  test('a genuinely-new compliance page follows its directory, not the config', async () => {
    const draft = { action_type: 'privacy-policy', content: { headline: 'Privacy Policy', sections: [] } };
    const result = await resolveTargetAndBody(SITE, draft, repoDeps(REPO));
    assert.equal(result.ok, true);
    assert.equal(result.filePath, 'src/pages/privacy-policy.njk');
    assert.equal(layoutOf(result.body), null);
  });

  test('overwriting an EXISTING compliance page keeps that page\'s own front matter and reads no siblings', async () => {
    // The one case that must not change: a real, already-linked page's layout
    // and permalink win, and deriving a directory contract for it would be a
    // repo tree plus eight file reads spent on an answer nothing uses.
    const counts = {};
    const draft = {
      action_type: 'privacy-policy',
      content: { page: 'https://example.com/about/', headline: 'Privacy Policy', sections: [] },
    };
    const result = await resolveTargetAndBody(SITE, draft, repoDeps(REPO, counts));
    assert.equal(result.filePath, 'src/pages/about.njk');
    assert.equal(layoutOf(result.body), 'page.njk');
    assert.match(result.body, /permalink: "\/about\/"/);
    assert.equal(counts.tree, undefined, 'no directory sampling for an overwrite');
    assert.equal(counts.reads, 1, 'only the page being overwritten');
  });
});

describe('computeGeneratedPostsManifestUpdate — blog-outline generated-posts manifest', () => {
  const site = { url_file_map: { newContentTargets: { 'blog-outline': { manifestFile: 'src/data/generated-posts.json' } } } };
  const entry = { slug: 'my-new-post', title: 'My New Post', excerpt: 'x', imageUrl: null, imageAlt: null, publishedAt: '2026-09-15T00:00:00.000Z', href: '/blogs/my-new-post' };

  test('unconfigured site (no manifestFile) -> null, nothing to do', async () => {
    const result = await computeGeneratedPostsManifestUpdate({ url_file_map: {} }, entry, async () => null, 'main');
    assert.equal(result, null);
  });

  test('manifest file does not exist yet -> creates it with just this entry', async () => {
    const result = await computeGeneratedPostsManifestUpdate(site, entry, async () => null, 'main');
    assert.equal(result.ok, true);
    assert.equal(result.filePath, 'src/data/generated-posts.json');
    const parsed = JSON.parse(result.newContent);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].slug, 'my-new-post');
    assert.equal(parsed[0]._aiManaged, true);
  });

  test('appends to an existing manifest, hand-authored entries preserved untouched', async () => {
    const existing = JSON.stringify([
      { slug: 'hand-authored-post', title: 'Hand Authored' },
      { slug: 'older-generated-post', title: 'Older', _aiManaged: true },
    ]);
    const result = await computeGeneratedPostsManifestUpdate(site, entry, async () => ({ content: existing }), 'main');
    assert.equal(result.ok, true);
    const parsed = JSON.parse(result.newContent);
    assert.equal(parsed.length, 3);
    assert.ok(parsed.some((p) => p.slug === 'hand-authored-post' && !p._aiManaged));
    assert.ok(parsed.some((p) => p.slug === 'older-generated-post'));
    assert.ok(parsed.some((p) => p.slug === 'my-new-post'));
  });

  test('re-applying the SAME post (same slug) updates in place rather than duplicating', async () => {
    const existing = JSON.stringify([{ ...entry, title: 'Stale Title', _aiManaged: true }]);
    const result = await computeGeneratedPostsManifestUpdate(site, entry, async () => ({ content: existing }), 'main');
    assert.equal(result.ok, true);
    const parsed = JSON.parse(result.newContent);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].title, 'My New Post');
  });

  test('malformed existing manifest -> honest invalid-edit, never guesses', async () => {
    const result = await computeGeneratedPostsManifestUpdate(site, entry, async () => ({ content: '{ not an array' }), 'main');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid-edit');
  });

  test('a fresh parse of the written content succeeds — the write is valid JSON', async () => {
    const first = await computeGeneratedPostsManifestUpdate(site, entry, async () => null, 'main');
    const second = await computeGeneratedPostsManifestUpdate(
      site, { ...entry, slug: 'second-post', title: 'Second Post' },
      async () => ({ content: first.newContent }), 'main',
    );
    assert.equal(second.ok, true);
    assert.equal(JSON.parse(second.newContent).length, 2);
  });
});

// A Next.js App Router site (Admizz's shape): `filename` on a newContentTargets
// entry means "route by directory," same signal blog-outline already forks on.
const APP_ROUTER_SITE = {
  id: 2,
  repo_owner: 'Zunkireelabs',
  repo_name: 'admizz-web-dev',
  repo_default_branch: 'main',
  url_file_map: {
    pages: { '/about': { file: 'src/app/about/page.tsx' } },
    newContentTargets: {
      'direct-answer': { dir: 'src/app/answers', extension: '.tsx', filename: 'page.tsx', urlPattern: '/answers/{slug}' },
      translation: { dir: 'src/app', extension: '.tsx', filename: 'page.tsx' },
    },
  },
};

describe('resolveTargetAndBody — direct-answer/translation fork to the TSX (App Router) renderer', () => {
  test('direct-answer with `filename` configured returns JSX, importing GeneratedDirectAnswer', async () => {
    const draft = {
      action_type: 'direct-answer',
      content: { query: 'What GPA do I need to study in Canada?', directAnswer: 'A minimum GPA of 2.5 for most colleges.' },
    };
    const result = await resolveTargetAndBody(APP_ROUTER_SITE, draft);
    assert.equal(result.ok, true);
    assert.equal(result.contentFormat, 'jsx');
    assert.match(result.body, /import GeneratedDirectAnswer from "@\/components\/GeneratedDirectAnswer";/);
    assert.match(result.body, /alternates: \{ canonical: "\/answers\/what-gpa-do-i-need-to-study-in-canada" \}/);
  });

  test('direct-answer with no `filename` configured still returns markdown, unaffected', async () => {
    const site = { url_file_map: { newContentTargets: { 'direct-answer': { dir: 'src/answers', extension: '.md' } } } };
    const draft = { action_type: 'direct-answer', content: { query: 'What GPA?', directAnswer: 'A minimum GPA of 2.5.' } };
    const result = await resolveTargetAndBody(site, draft);
    assert.equal(result.ok, true);
    assert.equal(result.contentFormat, 'markdown');
  });

  test('translation with `filename` configured returns JSX, importing GeneratedTranslation, no canonical', async () => {
    const draft = {
      action_type: 'translation',
      content: { page: 'https://example.com/about', targetLanguage: 'French', translatedTitle: 'À propos', translatedContent: 'Bonjour' },
    };
    const result = await resolveTargetAndBody(APP_ROUTER_SITE, draft, repoDeps({ 'src/app/about/page.tsx': 'export default function Page() { return null; }' }));
    assert.equal(result.ok, true);
    assert.equal(result.contentFormat, 'jsx');
    assert.match(result.body, /import GeneratedTranslation from "@\/components\/GeneratedTranslation";/);
    assert.doesNotMatch(result.body, /alternates:/);
  });
});

describe('FRONTEND_ACTION_TYPES / COMPLIANCE_ACTION_TYPES', () => {
  test('FRONTEND_ACTION_TYPES matches meta.handles exactly', async () => {
    const { meta } = await import('./frontend.js');
    assert.deepEqual([...FRONTEND_ACTION_TYPES].sort(), [...meta.handles].sort());
  });

  test('every compliance action type is also a frontend action type', () => {
    for (const t of COMPLIANCE_ACTION_TYPES) assert.ok(FRONTEND_ACTION_TYPES.has(t), `${t} should be in FRONTEND_ACTION_TYPES`);
  });
});

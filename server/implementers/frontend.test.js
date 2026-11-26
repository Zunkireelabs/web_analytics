import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { apply, preview, resolveTargetAndBody, FRONTEND_ACTION_TYPES, COMPLIANCE_ACTION_TYPES, computeGeneratedPostsManifestUpdate, checkPostContract } from './frontend.js';

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

describe("checkPostContract — the client build's required post content", () => {
  const site = { url_file_map: { newContentTargets: { 'blog-outline': { postContract: { requiredContent: ['quickAnswer', 'faqItems', 'sources'] } } } } };
  test('missing items are named and the draft is refused', () => {
    const r = checkPostContract(site, { quickAnswer: 'too short' });
    assert.equal(r.ok, false); assert.equal(r.reason, 'draft-not-ready'); assert.match(r.error, /quickAnswer, faqItems, sources/);
  });
  test('complete content passes; sources must be https links; no contract configured -> ok', () => {
    const full = { quickAnswer: 'A real answer-first summary sentence.', faqItems: [{ question: 'Q?', answer: 'A.' }], sources: [{ label: 'GOV.UK', url: 'https://www.gov.uk/x' }] };
    assert.equal(checkPostContract(site, full).ok, true);
    assert.equal(checkPostContract(site, { ...full, sources: [{ label: 'x', url: 'http://insecure' }] }).ok, false);
    assert.equal(checkPostContract({ url_file_map: {} }, {}).ok, true);
  });
});

describe('computeGeneratedPostsManifestUpdate — blog-outline generated-posts manifest', () => {
  const site = { url_file_map: { newContentTargets: { 'blog-outline': { manifestFile: 'src/data/generated-posts.json' } } } };
  const entry = { slug: 'my-new-post', title: 'My New Post', excerpt: 'x', imageUrl: null, imageAlt: null, publishedAt: '2026-09-15T00:00:00.000Z', href: '/blogs/my-new-post' };

  test('unconfigured site (no manifestFile) -> null, nothing to do', async () => {
    const result = await computeGeneratedPostsManifestUpdate({ url_file_map: {} }, entry, async () => null, 'main');
    assert.equal(result, null);
  });

  test('manifest file missing -> REFUSED (never silently re-created as a one-entry file that drops every other post)', async () => {
    const result = await computeGeneratedPostsManifestUpdate(site, entry, async () => null, 'main');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid-edit');
  });

  test('manifest file missing + manifestMayBeCreated opt-in -> creates it with just this entry', async () => {
    const optIn = { url_file_map: { newContentTargets: { 'blog-outline': { manifestFile: 'src/data/generated-posts.json', manifestMayBeCreated: true } } } };
    const result = await computeGeneratedPostsManifestUpdate(optIn, entry, async () => null, 'main');
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

  test('slug equal to a HAND-AUTHORED manifest entry -> slug-conflict, nothing written', async () => {
    const existing = JSON.stringify([{ slug: 'my-new-post', title: 'Human wrote this' }]);
    const r = await computeGeneratedPostsManifestUpdate(site, entry, async () => ({ content: existing }), 'main');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'slug-conflict');
  });

  test('collisionChecks: an existing dedicated route or JSON post at the same slug -> slug-conflict; own file is exempt', async () => {
    const cfg = { url_file_map: { newContentTargets: { 'blog-outline': { manifestFile: 'm.json', collisionChecks: ['src/app/{slug}/page.tsx', 'src/content/blog/posts/{slug}.json'] } } } };
    const fetchWith = (present) => async (_s, path) => (present.includes(path) ? { content: '[]' } : null);
    const a = await computeGeneratedPostsManifestUpdate(cfg, entry, fetchWith(['m.json', 'src/app/my-new-post/page.tsx']), 'main');
    assert.equal(a.reason, 'slug-conflict');
    const b = await computeGeneratedPostsManifestUpdate(cfg, entry, fetchWith(['m.json', 'src/content/blog/posts/my-new-post.json']), 'main');
    assert.equal(b.reason, 'slug-conflict');
    const own = await computeGeneratedPostsManifestUpdate(cfg, entry, fetchWith(['m.json', 'src/app/my-new-post/page.tsx']), 'main', { ownFilePath: 'src/app/my-new-post/page.tsx' });
    assert.equal(own.ok, true);
  });

  test('manifestRequired: missing image/category/href is refused before any write; a failed category lookup is named', async () => {
    const cfg = { url_file_map: { newContentTargets: { 'blog-outline': { manifestFile: 'm.json', manifestRequired: ['imageUrl', 'categories', 'href'] } } } };
    const f = async () => ({ content: '[]' });
    const noImg = await computeGeneratedPostsManifestUpdate(cfg, { ...entry, categories: [{ slug: 'a', title: 'A' }] }, f, 'main');
    assert.equal(noImg.reason, 'draft-not-ready');
    assert.match(noImg.error, /imageUrl/);
    const noCat = await computeGeneratedPostsManifestUpdate(cfg, { ...entry, imageUrl: '/x.webp', categories: [] }, f, 'main', { categoriesLookupFailed: true });
    assert.equal(noCat.reason, 'draft-not-ready');
    assert.match(noCat.error, /category source could not be read/);
    const ok = await computeGeneratedPostsManifestUpdate(cfg, { ...entry, imageUrl: '/x.webp', categories: [{ slug: 'a', title: 'A' }] }, f, 'main');
    assert.equal(ok.ok, true);
  });

  test('a fresh parse of the written content succeeds — the write is valid JSON', async () => {
    const optIn = { url_file_map: { newContentTargets: { 'blog-outline': { manifestFile: 'src/data/generated-posts.json', manifestMayBeCreated: true } } } };
    const first = await computeGeneratedPostsManifestUpdate(optIn, entry, async () => null, 'main');
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

describe('apply — design completeness gate (DESIGN_GATE_FAIL_CLOSED)', () => {
  // The prepared-body fast path means apply() reaches the gate without any
  // repo access, so a refusal here is provably BEFORE anything is pushed.
  const draft = {
    action_type: 'blog-outline', finding_id: 'f',
    rendered_body: '---\ntitle: "x"\n---\nbody', target_file_path: 'src/blog/x.md', content: { title: 'x' },
  };
  const withFlag = async (fn) => {
    process.env.DESIGN_GATE_FAIL_CLOSED = 'true';
    try { return await fn(); } finally { delete process.env.DESIGN_GATE_FAIL_CLOSED; }
  };

  test('a site with no design profile at all is held, not shipped unguarded', async () => {
    // Today the integrity gate is skipped entirely when there is no usable
    // profile, so this case had no guard at all.
    const r = await withFlag(() => apply({ url_file_map: {} }, draft));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'design-incomplete');
    assert.match(r.error, /no-design-profile/);
    assert.equal(r.designAssessment.repairable, true);
  });

  test('a profile that lacks what the draft renders is held with the exact missing field', async () => {
    const site = { url_file_map: { siteRoot: { designProfile: { version: 2, typography: { body: 'b' } } } } };
    const r = await withFlag(() => apply(site, draft));
    assert.equal(r.reason, 'design-incomplete');
    assert.match(r.error, /typography\.heading\.item/);
  });
});

describe('preview — design gates run early, only when the approval flow asks for them', () => {
  const draft = {
    action_type: 'blog-outline', finding_id: 'f',
    rendered_body: '---\ntitle: "x"\n---\nbody text', target_file_path: 'src/blog/x.md', content: { title: 'x' },
  };
  const withFlag = async (fn) => {
    process.env.DESIGN_GATE_FAIL_CLOSED = 'true';
    try { return await fn(); } finally { delete process.env.DESIGN_GATE_FAIL_CLOSED; }
  };

  test('validateDesign: a gate failure comes back structured, with the reason code and the rendered markup, BEFORE anything is applied', async () => {
    const r = await withFlag(() => preview({ url_file_map: {} }, draft, { validateDesign: true }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'design-incomplete');
    assert.ok(Array.isArray(r.deviations));
    assert.match(r.draftHtml, /body text/);
  });

  test('without the option, preview never runs the gates (the Draft Preview panel stays fast)', async () => {
    const r = await withFlag(() => preview({ url_file_map: {} }, draft));
    assert.notEqual(r.reason, 'design-incomplete');
  });
});

// superrank-web (2026-11-23): a generated post named its summary `description` and had no author/category/cover, so the Astro content schema rejected it
// and the client's build stopped. A schema-validated site now gets its own key name, its configured defaults, or a clear refusal instead of a broken file.
describe('resolveTargetAndBody — a new post must satisfy the site\'s content schema', () => {
  const sibling = (cover) => ['---', 'title: "T"', 'excerpt: "E"', 'date: 2026-01-01', 'author: superrank-team', 'category: AEO Know-How', 'cover:', `  kind: ${cover}`, '---', '', 'Body'].join('\n');
  const ASTRO_REPO = {
    'src/content.config.ts': 'export const collections = {};',
    'src/content/blog/a.md': sibling('agent'), 'src/content/blog/b.md': sibling('agent'), 'src/content/blog/c.md': sibling('pills'),
  };
  const mkSite = (extra = {}) => ({ id: 9, repo_owner: 'o', repo_name: 'r', repo_default_branch: 'main', url_file_map: { newContentTargets: { 'blog-outline': { dir: 'src/content/blog', extension: '.md', ...extra } } } });
  const draft = { action_type: 'blog-outline', content: { title: 'A New Guide', metaDescription: 'A summary.', sections: [{ heading: 'One', body: 'Text.' }] } };


  test('without defaults the post takes author, category and a minimal cover from the site\'s OWN posts, and so builds (2026-11-25)', async () => {
    // Nothing is configured: the client's own team and categories are read from its posts, and a cover shape a real post already ships (`kind` only).
    const r = await resolveTargetAndBody(mkSite(), draft, repoDeps(ASTRO_REPO));
    assert.equal(r.ok, true, r.error);
    assert.match(r.body, /^author: "/m);
    assert.match(r.body, /^category: "/m);
    assert.match(r.body, /^cover:\n  kind: "/m);

  test('without defaults the post is refused for what the siblings do not agree on, naming the key and where to set it', async () => {
    // author and category are the same in every sibling, so the post reuses them (blog standard); the cover varies per post, so only it is missing.
    const r = await resolveTargetAndBody(mkSite(), draft, repoDeps(ASTRO_REPO));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'front-matter-incomplete');
    assert.match(r.error, /declares "cover",/);
    assert.doesNotMatch(r.error, /"author"/);
    assert.match(r.error, /newContentTargets\["blog-outline"\]\.frontMatterDefaults/);

  });

  test('with the site\'s defaults the post uses the siblings\' own `excerpt` key and carries every required key', async () => {
    const site = mkSite({ frontMatterDefaults: { author: 'superrank-team', category: 'AEO Know-How', cover: { kind: 'agent' } } });
    const r = await resolveTargetAndBody(site, draft, repoDeps(ASTRO_REPO));
    assert.equal(r.ok, true);
    assert.match(r.body, /^excerpt: "A summary\."$/m);
    assert.doesNotMatch(r.body, /^description:/m);
    assert.match(r.body, /^author: "superrank-team"$/m);
    assert.match(r.body, /^category: "AEO Know-How"$/m);
    assert.match(r.body, /^cover:\n  kind: "agent"$/m);
  });

  test('a site with no build-time schema is not refused for lacking keys its siblings share (zunkireelabs-web style)', async () => {
    const repo = {};
    for (const n of ['a', 'b', 'c']) repo[`src/blog/${n}.md`] = '---\ntitle: "T"\ndate: 2026-01-01\nauthorId: sadin\nreadTime: 9\n---\nBody';
    const site = { id: 1, repo_owner: 'o', repo_name: 'r', repo_default_branch: 'main', url_file_map: { newContentTargets: { 'blog-outline': { dir: 'src/blog', extension: '.md' } } } };
    const r = await resolveTargetAndBody(site, draft, repoDeps(repo));
    assert.equal(r.ok, true);
    assert.match(r.body, /^description: "A summary\."$/m);
  });
});

// MOBILISE (2026-11-23): cookie-policy was configured to land in docs/, so PR 12 added docs/cookie-policy-mobilise.md, which no build reads. The
// real location comes from the site's own legal pages.
describe('resolveTargetAndBody — a new legal page is placed beside the site\'s own legal pages', () => {
  const site = (cfg) => ({
    id: 8874, repo_owner: 'o', repo_name: 'r', repo_default_branch: 'main',
    url_file_map: {
      pages: { '/terms': { file: 'src/terms/index.njk' }, '/privacy-policy': { file: 'src/privacy-policy/index.njk' } },
      newContentTargets: { 'cookie-policy': cfg },
    },
  });
  const REPO_LEGAL = { 'src/privacy-policy/index.njk': '---\nlayout: base.njk\ntitle: "Privacy"\n---\nBody', 'src/terms/index.njk': '---\ntitle: "Terms"\n---\nBody' };
  const draft = { action_type: 'cookie-policy', content: { headline: 'Cookie Policy', metaTitle: 'Cookie Policy', sections: [{ heading: 'What are cookies', body: 'Small files.' }] } };

  test('a placeholder docs/ target is replaced by src/cookie-policy/index.njk, /cookie-policy/ and the neighbours\' layout', async () => {
    const r = await resolveTargetAndBody(site({ dir: 'docs', extension: '.md' }), draft, repoDeps(REPO_LEGAL));
    assert.equal(r.ok, true);
    assert.equal(r.filePath, 'src/cookie-policy/index.njk');
    assert.match(r.body, /^permalink: "\/cookie-policy\/"$/m);
    assert.match(r.body, /^layout: "base\.njk"$/m);
  });

  test('a site that configured a real directory keeps it', async () => {
    const r = await resolveTargetAndBody(site({ dir: 'src/pages', extension: '.njk' }), draft, repoDeps(REPO_LEGAL));
    assert.equal(r.ok, true);
    assert.equal(r.filePath, 'src/pages/cookie-policy.njk');
  });

  test('a cookie page that already exists at the derived path is not overwritten', async () => {
    const r = await resolveTargetAndBody(site({ dir: 'docs', extension: '.md' }), draft, repoDeps({ ...REPO_LEGAL, 'src/cookie-policy/index.njk': 'already here' }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'slug-conflict');
  });
});

describe('resolveTargetAndBody — a converted static site (newContentTargets["blog-outline"].mode = "clone-sibling")', () => {
  const REF = `---\n{\n  "layout": "layouts/base.njk",\n  "permalink": "/blog/old-ref/index.html",\n  "headInclude": "heads/blog-old-ref-index.njk",\n  "title": "Old Reference Guide | ACME", # SEOAI:TITLE\n  "documentStart": "<!DOCTYPE html>\\n<html lang=\\"en\\">\\n",\n  "description": "A reference description that must never leak into another post.", # SEOAI:METADESCRIPTION\n  "componentBase": "../../"\n}\n---\n<main class="blog-page"><article class="blog-article"><header class="blog-header"><h1>The reference headline</h1>\n<p>The reference lead sentence about one thing.</p><p class="article-meta"><time datetime="2024-05-22">May 22, 2024</time></p></header>\n<div class="blog-content"><p>Reference body.</p></div></article></main>\n`;
  const HEAD = '<title>{{ title }}</title><link rel="canonical" href="https://client.example/blog/old-ref/"><meta property="og:url" content="https://client.example/blog/old-ref/">';
  const FILES = { 'src/blog/old-ref/index.njk': REF, 'src/_includes/heads/blog-old-ref-index.njk': HEAD };
  const site = { id: 8874, name: 'MOBILISE', website_domain: 'client.example', repo_default_branch: 'main', url_file_map: { newContentTargets: { 'blog-outline': {
    mode: 'clone-sibling', dir: 'src/blog', filename: 'index.njk', extension: '.njk', urlPattern: '/blog/{slug}/', layout: null, referencePage: 'src/blog/old-ref/index.njk', headDir: 'src/_includes' } } } };
  const draft = { action_type: 'blog-outline', content: { title: 'Why Teams Stall', metaDescription: 'Why teams stall.', quickAnswer: 'A lead.', sections: [{ heading: 'One', body: 'Text.' }] } };
  const deps = { getFileContent: async (_s, p) => (p in FILES ? { content: FILES[p] } : null) };

  test('an approved draft becomes the page and its own head file, written as HTML, not as markdown or the Next.js writer', async () => {
    const r = await resolveTargetAndBody(site, draft, deps);
    assert.equal(r.ok, true);
    assert.equal(r.filePath, 'src/blog/why-teams-stall/index.njk');
    assert.equal(r.contentFormat, 'html-page');
    assert.match(r.body, /"permalink": "\/blog\/why-teams-stall\/index\.html"/); assert.match(r.body, /<h1>Why Teams Stall<\/h1>/); assert.doesNotMatch(r.body, /reference headline/);
    assert.deepEqual(r.extraFiles.map((f) => f.path), ['src/_includes/heads/blog-why-teams-stall-index.njk']);
  });
  test('the same draft on a site without that mode still takes its old path (nothing else changes)', async () => {
    const plain = { ...site, url_file_map: { newContentTargets: { 'blog-outline': { dir: 'src/blog', extension: '.md' } } } };
    const r = await resolveTargetAndBody(plain, draft, deps);
    assert.equal(r.ok, true); assert.equal(r.contentFormat, 'markdown'); assert.equal(r.filePath, 'src/blog/why-teams-stall.md');
  });
});

describe('resolveTargetAndBody — blog target in the wrong folder is refused (blog standard)', () => {
  const draft = { action_type: 'blog-outline', content: { title: 'Why Teams Stall', metaDescription: 'Why teams stall.', quickAnswer: 'A lead.', sections: [{ heading: 'One', body: 'Text.' }] } };
  const mkSite = (dir) => ({ id: 8864, name: 'Chayce', repo_owner: 'o', repo_name: 'r', repo_default_branch: 'main', url_file_map: { newContentTargets: { 'blog-outline': { dir, extension: '.md' } } } });
  const files = [...Array.from({ length: 9 }, (_, i) => `docs/note-${i}.md`), ...Array.from({ length: 30 }, (_, i) => `src/blog/post-${i}.md`)];
  const deps = { cache: null, getRepoTree: async () => ({ files }), getFileContent: async () => null };
  test('"docs" with the real posts in src/blog: refused, naming the folder to use, nothing written', async () => {
    const r = await resolveTargetAndBody(mkSite('docs'), draft, deps);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'blog-target-wrong-folder');
    assert.match(r.error, /src\/blog/);
  });
  test('the real blog folder passes the guard and the draft resolves', async () => {
    const r = await resolveTargetAndBody(mkSite('src/blog'), draft, deps);
    assert.equal(r.ok, true);
    assert.equal(r.filePath, 'src/blog/why-teams-stall.md');
  });
});

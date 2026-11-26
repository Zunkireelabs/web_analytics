import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findBareMarkupIssues, findBareNewPageMarkupIssues, articleHeadingStandard, headingsOf, headingStructureIssues } from './rendered-markup-guard.js';

const REAL_PROFILE = {
  typography: {
    body: 'text-lg text-gray-600 leading-relaxed',
    link: 'text-zunkiree-600 hover:underline',
    heading: { section: 'text-2xl font-bold text-gray-900' },
  },
  components: { list: { wrapper: 'space-y-2', item: 'flex gap-2' } },
};

describe('findBareMarkupIssues', () => {
  test('no-op for an actionType buildMergeValues has no HTML-rendering branch for', () => {
    const { issues } = findBareMarkupIssues('meta-title', { selectedTitle: 'Title' }, {}, REAL_PROFILE);
    assert.equal(issues.length, 0);
  });

  test('no-op with no design profile — nothing to check a bare tag against', () => {
    const { issues } = findBareMarkupIssues('expand-content', { sections: [{ heading: 'H', body: 'Body text.' }] }, {}, null);
    assert.equal(issues.length, 0);
  });

  test('no-op when the profile has no real typography.body evidence (a plain-css site, or a thin capture)', () => {
    const { issues } = findBareMarkupIssues('expand-content', { sections: [{ heading: 'H', body: 'Body text.' }] }, {}, { typography: {} });
    assert.equal(issues.length, 0);
  });

  test('a real captured template plus a real design profile grounds both heading and body prose — no issues', () => {
    const componentTemplates = {
      expandContent: { wrapper: '<div>\n{{ROWS}}\n</div>', row: '<h2 class="text-2xl font-bold text-gray-900">{{HEADING}}</h2>{{BODY}}' },
    };
    const { issues } = findBareMarkupIssues('expand-content', {
      sections: [{ heading: 'H', body: 'Body text with a [link](https://example.com) and\n\n- one\n- two' }],
    }, componentTemplates, REAL_PROFILE);
    assert.equal(issues.length, 0);
  });

  // DEFAULT_EXPAND_TEMPLATE (no componentTemplates.expandContent configured
  // and no card/projected variant available) is intentionally the platform's
  // own bare fallback markup, not a captured or projected one — so its own
  // <h2> heading IS a real, correctly-flagged finding here, distinct from
  // the body prose this guard's sibling fix (proseStyleFor) already grounds
  // regardless of which row template is in play.
  test('the platform default template\'s own bare heading is a real finding, not a false positive', () => {
    const { issues } = findBareMarkupIssues('expand-content', {
      sections: [{ heading: 'H', body: 'Body text.' }],
    }, {}, REAL_PROFILE);
    assert.equal(issues.length, 1);
    assert.match(issues[0].snippet, /<h2>/);
  });

  // proseStyleFor grounds the BODY of an expand-content row regardless of
  // componentTemplates, but the row's own HEADING still comes straight from
  // whatever template is configured — a captured/legacy template with a
  // classless heading tag is exactly the kind of gap this guard exists to
  // catch even though it isn't the specific bug already fixed.
  test('flags a bare heading from a configured template with no class on it, even though body prose is grounded', () => {
    const componentTemplates = {
      expandContent: { wrapper: '<div>\n{{ROWS}}\n</div>', row: '<h2>{{HEADING}}</h2><div>{{BODY}}</div>' },
    };
    const { issues } = findBareMarkupIssues('expand-content', {
      sections: [{ heading: 'H', body: 'Body text.' }],
    }, componentTemplates, REAL_PROFILE);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].patternId, 'bare-unstyled-markup');
    assert.equal(issues[0].blocking, true);
    assert.match(issues[0].snippet, /<h2>/);
  });

  test('a captured template with real classes on the heading silences the same case', () => {
    const componentTemplates = {
      expandContent: { wrapper: '<div>\n{{ROWS}}\n</div>', row: '<h2 class="text-2xl font-bold text-gray-900">{{HEADING}}</h2><div>{{BODY}}</div>' },
    };
    const { issues } = findBareMarkupIssues('expand-content', {
      sections: [{ heading: 'H', body: 'Body text.' }],
    }, componentTemplates, REAL_PROFILE);
    assert.equal(issues.length, 0);
  });

  test('a failed render (no sections) produces no issues — not this check\'s concern', () => {
    const { issues } = findBareMarkupIssues('expand-content', { sections: [] }, {}, REAL_PROFILE);
    assert.equal(issues.length, 0);
  });

  // The fallback path — fires even with NO typography evidence at all,
  // because it only needs the render to be internally inconsistent with
  // itself (a bare heading next to the template's own classed wrapper), not
  // external evidence of what the class SHOULD be. Confirmed live on site
  // 8864 (chayceproperties.com, 2026-09-20): exactly this shape shipped
  // because the profile's typography.body hadn't been derived yet, so the
  // evidence-based check above silently skipped every bare tag.
  test('with NO typography evidence, still flags a bare heading sitting inside an otherwise-classed template', () => {
    const componentTemplates = {
      expandContent: { wrapper: '<div class="container">\n{{ROWS}}\n</div>', row: '<section><h1>{{HEADING}}</h1><div>{{BODY}}</div></section>' },
    };
    const { issues } = findBareMarkupIssues('expand-content', {
      page: 'https://chayceproperties.com/bronze-essentials/', sections: [{ heading: 'H', body: 'Body text.' }],
    }, componentTemplates, null);
    // The row's bare <p> body picks up the same finding now that the
    // fallback isn't heading-only — see the broadened-coverage tests below.
    // What this test locks in is specifically the <h1>.
    const h1Issue = issues.find((i) => /<h1>/.test(i.snippet));
    assert.ok(h1Issue, 'expected a finding for the bare <h1>');
    assert.equal(h1Issue.patternId, 'bare-tag-inconsistent-styling');
    assert.equal(h1Issue.blocking, true);
  });

  test('with NO typography evidence, a UNIFORMLY bare render (nothing classed anywhere) is not flagged — nothing to contrast against', () => {
    const componentTemplates = {
      expandContent: { wrapper: '<div>\n{{ROWS}}\n</div>', row: '<h1>{{HEADING}}</h1><div>{{BODY}}</div>' },
    };
    const { issues } = findBareMarkupIssues('expand-content', {
      page: 'https://chayceproperties.com/bronze-essentials/', sections: [{ heading: 'H', body: 'Body text.' }],
    }, componentTemplates, null);
    assert.equal(issues.length, 0);
  });

  test('with NO typography evidence, a bare heading on a blog/legal (inline) page is never flagged — inheriting the article\'s own prose is the correct shape there', () => {
    const componentTemplates = {
      expandContent: { wrapper: '<div class="container">\n{{ROWS}}\n</div>', row: '<section><h1>{{HEADING}}</h1><div>{{BODY}}</div></section>' },
    };
    const { issues } = findBareMarkupIssues('expand-content', {
      page: 'https://chayceproperties.com/blog/some-post/', sections: [{ heading: 'H', body: 'Body text.' }],
    }, componentTemplates, null);
    assert.equal(issues.length, 0);
  });

  // The fallback is not heading-only: a comparison table rendered bare next
  // to a classed heading/wrapper is the same "internally inconsistent"
  // shape, and this platform's own comparison-content focus (expand-
  // content.js) can produce a table on any section.
  test('with NO typography evidence, a bare comparison table sitting next to a classed heading is also flagged', () => {
    const componentTemplates = {
      expandContent: { wrapper: '<div class="container">\n{{ROWS}}\n</div>', row: '<h2 class="home-h2">{{HEADING}}</h2><div>{{BODY}}</div>' },
    };
    const { issues } = findBareMarkupIssues('expand-content', {
      page: 'https://chayceproperties.com/packages/',
      sections: [{ heading: 'H', body: 'Body text.', table: [{ feature: 'Support', alternative: 'Basic', thisOption: 'Full' }] }],
    }, componentTemplates, null);
    assert.ok(issues.some((i) => i.patternId === 'bare-tag-inconsistent-styling' && /<table/.test(i.snippet)));
  });

  // Even on an inline (blog/legal) page, a bare table is still flagged —
  // only bare HEADING tags get the inline exemption there (they legitimately
  // inherit the article's own prose styling); a bare table never does.
  test('the inline exemption is heading-only — a bare table on a blog page is still flagged', () => {
    const componentTemplates = {
      expandContent: { wrapper: '<div class="container">\n{{ROWS}}\n</div>', row: '<h2 class="home-h2">{{HEADING}}</h2><div>{{BODY}}</div>' },
    };
    const { issues } = findBareMarkupIssues('expand-content', {
      page: 'https://chayceproperties.com/blog/some-post/',
      sections: [{ heading: 'H', body: 'Body text.', table: [{ feature: 'Support', alternative: 'Basic', thisOption: 'Full' }] }],
    }, componentTemplates, null);
    assert.ok(issues.some((i) => i.patternId === 'bare-tag-inconsistent-styling' && /<table/.test(i.snippet)));
  });

  test('one finding per distinct bare tag type per field, not one per occurrence', () => {
    const componentTemplates = {
      expandContent: { wrapper: '<div>\n{{ROWS}}\n</div>', row: '<h2>{{HEADING}}</h2><div>{{BODY}}</div>' },
    };
    const { issues } = findBareMarkupIssues('expand-content', {
      sections: [{ heading: 'H1', body: 'One.' }, { heading: 'H2', body: 'Two.' }, { heading: 'H3', body: 'Three.' }],
    }, componentTemplates, REAL_PROFILE);
    assert.equal(issues.length, 1, 'three bare <h2> occurrences collapse to one finding for the "expandedContent" field');
  });
});

// The other rendering path (newpage-render.js) — landing-page/blog-outline/
// direct-answer/translation/compliance pages, whose grounding
// (projectMarkdownTablesInBody/projectMarkdownProseInBody, wired via
// wrapInSiteProse) already existed before this guard did. Note: under
// CORRECT operation, whenever the profile has both typography.body (this
// guard's own no-op gate) and a heading class, wrapInSiteProse always
// converts every heading it sees — so the "raw ATX heading survived"
// finding is a pure regression trap, not something a normal, working
// content shape can trigger. These tests cover what's actually reachable:
// the happy path, the no-op gates, and a bare tag surviving from a
// site's own captured (not generator-authored) wrapper markup.
describe('findBareNewPageMarkupIssues', () => {
  const site = (designProfile, componentTemplates = {}) => ({
    url_file_map: { siteRoot: { designProfile, componentTemplates } },
  });
  const REAL_PROFILE = { typography: { body: 'text-lg text-gray-600', heading: { section: 'text-3xl font-bold text-gray-900' } } };

  test('no-op for an actionType with no new-page renderer', () => {
    const { issues } = findBareNewPageMarkupIssues('meta-title', { selectedTitle: 'x' }, site(REAL_PROFILE));
    assert.equal(issues.length, 0);
  });

  test('no-op with no design profile at all', () => {
    const { issues } = findBareNewPageMarkupIssues('landing-page', { headline: 'H', sections: [] }, site(null));
    assert.equal(issues.length, 0);
  });

  test('no-op when the profile has no real typography.body evidence', () => {
    const { issues } = findBareNewPageMarkupIssues('landing-page', { headline: 'H', sections: [] }, site({ typography: {} }));
    assert.equal(issues.length, 0);
  });

  test('a landing page with real typography evidence renders fully grounded — no issues', () => {
    const content = { headline: 'Grow Your Business', subheadline: 'Real AI infrastructure.', sections: [{ heading: 'Why Us', body: 'We build real systems.' }] };
    const { issues } = findBareNewPageMarkupIssues('landing-page', content, site(REAL_PROFILE));
    assert.deepEqual(issues, []);
  });

  test('a blog-outline post for a client WITH a captured article of its own renders fully grounded — no issues', () => {
    const content = { title: 'Post Title', sections: [{ heading: 'Intro', body: 'Real intro text.' }] };
    const s = site({ ...REAL_PROFILE, pageTypePatterns: { 'blog-article': { sectionOrder: ['article'], textHierarchy: [] } } });
    const { issues } = findBareNewPageMarkupIssues('blog-outline', content, s);
    assert.deepEqual(issues, []);
  });

  test('a compliance page (privacy-policy) renders fully grounded — no issues', () => {
    const content = { headline: 'Privacy Policy', sections: [{ heading: 'Data We Collect', body: 'We collect real data.' }] };
    const { issues } = findBareNewPageMarkupIssues('privacy-policy', content, site(REAL_PROFILE));
    assert.deepEqual(issues, []);
  });

  // A bare tag reaching the final rendered body from the site's OWN captured
  // contentWrapper template (rather than from the generator's content) is
  // exactly the kind of stale/thin-capture defect this check exists to
  // surface — the wrapper's literal markup is spliced in verbatim by
  // fillContentWrapper, with no class-stripping applied to it.
  test('flags a bare tag coming from the site\'s own captured content wrapper', () => {
    const componentTemplates = { contentWrapper: { wrapper: '<div>\n<h1>Untouched chrome</h1>\n{{BODY}}\n</div>' } };
    const { issues } = findBareNewPageMarkupIssues('landing-page', { headline: 'H', sections: [] }, site(REAL_PROFILE, componentTemplates));
    assert.ok(issues.some((i) => i.patternId === 'bare-unstyled-markup' && /<h1>/.test(i.snippet)));
  });

  test('blog-outline\'s TSX variant is not covered — nothing to check in a JSX source file', () => {
    // frontend.js only calls the TSX renderer when a site's newContentTargets
    // configures a `filename` (directory-per-post) target; this guard never
    // attempts that variant regardless of site shape, so a TSX-only site
    // still gets 0 issues here rather than a crash on markdown-shaped regexes.
    const tsx = site(REAL_PROFILE); tsx.url_file_map.newContentTargets = { 'blog-outline': { dir: 'src/app', filename: 'page.tsx', extension: '.tsx' } };
    const { issues } = findBareNewPageMarkupIssues('blog-outline', { title: 'Post', sections: [] }, tsx);
    assert.deepEqual(issues, []);
  });

  test('a render failure produces no issues — not this check\'s concern', () => {
    const badContent = { get headline() { throw new Error('boom'); }, sections: [] };
    const { issues } = findBareNewPageMarkupIssues('landing-page', badContent, site(REAL_PROFILE));
    assert.deepEqual(issues, []);
  });
});


// EVERY CLIENT HELD TO ITS OWN ARTICLE STANDARD. One fixture per kind of evidence the six real clients have (the shape of their recorded profiles; nothing is shared
// between them): a layout that styles prose, a captured article with no subheading class, a captured article WITH its own subheading class, and no captured article.
describe('articles are held to the client\'s own article standard (never a default, never another client\'s)', () => {
  const TYPO = { body: 'text-lg', heading: { section: 'text-3xl font-bold', item: 'text-xl' } };
  const withProfile = (extra, siteRoot = {}) => ({ url_file_map: { siteRoot: { ...siteRoot, designProfile: { typography: TYPO, ...extra } } } });
  const CLIENTS = {
    zunkiree: withProfile({ pageTypePatterns: { 'blog-article': { textHierarchy: [] } } }, { inlineProse: 'layout' }),                                   // layout styles the prose
    chayce: withProfile({ pageTypePatterns: { 'blog-article': { textHierarchy: [{ role: 'title', classes: 'v2-h2' }] } } }),                              // article captured, no subheading class
    admizz: withProfile({ pageTypePatterns: { 'blog-article': { textHierarchy: [] } } }),
    mobilise: withProfile({ pageTypePatterns: { 'blog-article': { textHierarchy: [] } } }),
    superrank: withProfile({ pageTypePatterns: { 'blog-article': { textHierarchy: [{ role: 'subheading', classes: 'h2' }] } } }),                         // its own subheading class
    zennly: withProfile({ pageTypePatterns: { 'blog-article': { textHierarchy: [{ role: 'subheading', classes: 'v2-mm__aside-title' }] } } }),
  };
  const post = { title: 'Post', sections: [{ heading: 'Intro', body: 'Real text.' }, { heading: 'More', body: 'More real text.' }] };
  const kinds = (issues) => issues.map((i) => i.patternId);

  test('the standard is read from each client\'s own evidence', () => {
    assert.equal(articleHeadingStandard(CLIENTS.zunkiree).mode, 'layout');
    for (const k of ['chayce', 'admizz', 'mobilise']) assert.equal(articleHeadingStandard(CLIENTS[k]).mode, 'inherit', k);
    assert.deepEqual(articleHeadingStandard(CLIENTS.superrank), { mode: 'grounded', classes: 'h2' });
    // Zennly's recorded "subheading" class came from a navigation mega-menu panel: untrusted, so it is IGNORED and the article is held to the page's own styling (never "unknown": a reference exists)
    assert.deepEqual(articleHeadingStandard(CLIENTS.zennly), { mode: 'inherit', ignoredClass: 'v2-mm__aside-title' });
    assert.equal(articleHeadingStandard(withProfile({})).mode, 'unknown');
  });

  test('layout and inherit clients: markdown headings are their format, and a well-formed article has no issues', () => {
    for (const k of ['zunkiree', 'chayce', 'admizz', 'mobilise']) assert.deepEqual(kinds(findBareNewPageMarkupIssues('blog-outline', post, CLIENTS[k]).issues), [], k);
  });

  const RAW = '---\ntitle: Post\n---\n\n## Raw heading survived\n\nText.\n';
  const force = (body) => ({ renderBody: () => body });

  test('a client with its OWN subheading class: a raw "#" that survived is flagged, naming that client\'s class (the check is not skipped for articles)', () => {
    CLIENTS.observed = withProfile({ pageTypePatterns: { 'blog-article': { textHierarchy: [{ role: 'subheading', classes: 'article-h2', observed: 6, observedInBody: true }] } } });
    for (const k of ['superrank', 'observed']) {
      const issues = findBareNewPageMarkupIssues('blog-outline', post, CLIENTS[k], force(RAW)).issues;
      const f = issues.find((i) => i.patternId === 'ungrounded-heading-markdown');
      assert.ok(f && f.blocking, k); assert.match(f.detail, new RegExp(articleHeadingStandard(CLIENTS[k]).classes), `${k}: names its own class`);
    }
    assert.match(findBareNewPageMarkupIssues('blog-outline', post, CLIENTS.superrank, force(RAW)).issues.find((i) => i.patternId === 'ungrounded-heading-markdown').detail, /"h2"/);
  });
  test('layout and inherit clients: the same raw heading is their own format, not flagged', () => {
    for (const k of ['zunkiree', 'chayce', 'admizz', 'mobilise', 'zennly']) assert.ok(!kinds(findBareNewPageMarkupIssues('blog-outline', post, CLIENTS[k], force(RAW)).issues).includes('ungrounded-heading-markdown'), k);
  });
  test('a structurally broken article is flagged for EVERY client, whatever its standard', () => {
    const BAD = '---\ntitle: P\n---\n\n# Own H1\n\n## A\n\n#### Jumped\n';
    for (const k of Object.keys(CLIENTS)) {
      const issues = findBareNewPageMarkupIssues('blog-outline', post, CLIENTS[k], force(BAD)).issues.filter((i) => i.patternId === 'heading-structure');
      assert.equal(issues.length, 2, `${k}: extra H1 and a skipped level`); assert.ok(issues.every((i) => i.blocking));
    }
  });
  test('NO captured article for the client: not assumed acceptable, flagged for review', () => {
    const issues = findBareNewPageMarkupIssues('blog-outline', post, withProfile({})).issues;
    assert.ok(kinds(issues).includes('article-standard-not-established')); assert.ok(issues.find((i) => i.patternId === 'article-standard-not-established').blocking);
  });
  test('and it is flagged even for a client with no typography evidence at all (the earlier early return would have let it through)', () => {
    const issues = findBareNewPageMarkupIssues('blog-outline', post, { url_file_map: { siteRoot: { designProfile: {} } } }).issues;
    assert.deepEqual(kinds(issues), ['article-standard-not-established']);
  });

  test('other page types never get the article standard; their class check is unchanged', () => {
    const none = withProfile({});
    assert.ok(!kinds(findBareNewPageMarkupIssues('landing-page', { headline: 'H', sections: [{ heading: 'S', body: 'b' }] }, none).issues).includes('article-standard-not-established'));
    const raw = findBareNewPageMarkupIssues('landing-page', { headline: 'H', sections: [] }, none, force('# H\n\n## Raw survived\n')).issues;
    assert.ok(raw.some((i) => i.patternId === 'ungrounded-heading-markdown'), 'a landing page is still checked against the section-heading class');
  });
  test('a landing page with two H1s or a skipped level is flagged too: structure applies to everything generated', () => {
    const bad = findBareNewPageMarkupIssues('landing-page', { headline: 'H', sections: [] }, withProfile({}), force('# A\n\n# B\n\n#### C\n')).issues.filter((i) => i.patternId === 'heading-structure');
    assert.equal(bad.length, 2);
  });
});

describe('heading structure of every generated page body', () => {
  const lv = (body, o) => headingStructureIssues(body, o).map((i) => i.detail);
  test('headings are read from markdown and HTML, in order, ignoring code fences', () => {
    assert.deepEqual(headingsOf('## A\n\n<h3 class="x">B</h3>\n```\n# not a heading\n```\n### C').map((h) => [h.level, h.text]), [[2, 'A'], [3, 'B'], [3, 'C']]);
  });
  test('an article: H2 then H3 is fine; the title is the layout\'s H1', () => assert.deepEqual(lv('## A\n\n### B\n\n## C', { article: true }), []));
  test('an article with its own H1 in the body is flagged (the layout already supplies one)', () => assert.match(lv('# Title\n\n## A', { article: true })[0], /another H1/));
  test('an article that starts at H3, or jumps H2 to H4, is flagged: levels are never skipped', () => {
    assert.match(lv('### A', { article: true })[0], /skipped/); assert.match(lv('## A\n\n#### B', { article: true })[0], /skipped/);
  });
  test('a page with two H1s is flagged; one H1 then H2 is fine', () => {
    assert.match(lv('# A\n\n# B')[0], /one H1/); assert.deepEqual(lv('# A\n\n## B\n\n### C'), []);
  });
  test('an empty heading is flagged', () => assert.match(lv('## A\n\n##\n\ntext', { article: true })[0], /empty/));
  test('going back up (H3 to H2) is allowed', () => assert.deepEqual(lv('## A\n\n### B\n\n## C\n\n### D', { article: true }), []));
});


describe('articleHeadingStandard: evidence must be a body heading, never a menu', () => {
  const prof = (entry, extra = {}) => ({ url_file_map: { siteRoot: { designProfile: { pageTypePatterns: { 'blog-article': { textHierarchy: [entry] } }, ...extra } } } });
  test('a BARE finding is the inherit standard (the layout styles the headings), explicitly', () => {
    assert.deepEqual(articleHeadingStandard(prof({ role: 'subheading', classes: null, bare: true, observed: 6, observedInBody: true })), { mode: 'inherit', bare: true });
  });
  test('a class observed on a body heading is grounded', () => {
    assert.deepEqual(articleHeadingStandard(prof({ role: 'subheading', classes: 'post-h2', observed: 5, observedInBody: true })), { mode: 'grounded', classes: 'post-h2' });
  });
  test('an explicit "not observed in the body" class is never accepted, even with a clean-looking name', () => {
    assert.equal(articleHeadingStandard(prof({ role: 'subheading', classes: 'post-h2', observedInBody: false })).mode, 'inherit');
  });
  test('a legacy class (recorded before the evidence existed) is accepted only while its name does not read like navigation', () => {
    assert.equal(articleHeadingStandard(prof({ role: 'subheading', classes: 'h2' })).mode, 'grounded');
    for (const chrome of ['v2-mm__aside-title', 'nav-mega-title', 'sidebar-heading', 'dropdown-title']) assert.equal(articleHeadingStandard(prof({ role: 'subheading', classes: chrome })).mode, 'inherit', chrome);
  });
  test('an untrusted class falls back to inherit when ANY reference article exists (a captured article page counts), and to unknown only when none does', () => {
    const entry = { role: 'subheading', classes: 'v2-mm__aside-title' };
    const noPattern = { url_file_map: { siteRoot: { designProfile: { pageTypePatterns: {}, pages: [{ pageType: 'blog-article', url: 'https://x.test/blog/p' }] } } } };
    assert.equal(articleHeadingStandard({ url_file_map: { siteRoot: { designProfile: { pageTypePatterns: { 'blog-article': { textHierarchy: [entry] } }, pages: [] } } } }).mode, 'inherit', 'pattern exists');
    assert.equal(articleHeadingStandard(noPattern).mode, 'inherit', 'captured article page exists');
    assert.equal(articleHeadingStandard({ url_file_map: { siteRoot: { designProfile: { pageTypePatterns: {}, pages: [] } } } }).mode, 'unknown');
  });
  test('layout opt-in still wins', () => {
    const p = prof({ role: 'subheading', classes: 'post-h2', observedInBody: true }); p.url_file_map.siteRoot.inlineProse = 'layout';
    assert.equal(articleHeadingStandard(p).mode, 'layout');
  });
});

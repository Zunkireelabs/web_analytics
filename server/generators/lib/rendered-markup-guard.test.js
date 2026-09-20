import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findBareMarkupIssues, findBareNewPageMarkupIssues } from './rendered-markup-guard.js';

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
    assert.equal(issues.length, 1);
    assert.equal(issues[0].patternId, 'bare-heading-inconsistent-styling');
    assert.equal(issues[0].blocking, true);
    assert.match(issues[0].snippet, /<h1>/);
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

  test('a blog-outline post with real typography evidence renders fully grounded — no issues', () => {
    const content = { title: 'Post Title', sections: [{ heading: 'Intro', body: 'Real intro text.' }] };
    const { issues } = findBareNewPageMarkupIssues('blog-outline', content, site(REAL_PROFILE));
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
    const { issues } = findBareNewPageMarkupIssues('blog-outline', { title: 'Post', sections: [] }, site(REAL_PROFILE));
    assert.deepEqual(issues, []);
  });

  test('a render failure produces no issues — not this check\'s concern', () => {
    const badContent = { get headline() { throw new Error('boom'); }, sections: [] };
    const { issues } = findBareNewPageMarkupIssues('landing-page', badContent, site(REAL_PROFILE));
    assert.deepEqual(issues, []);
  });
});

import { buildMergeValues } from '../../implementers/lib/marker-merge.js';
import {
  renderLandingPageBody, renderBlogOutlineBody, renderDirectAnswerBody,
  renderTranslationBody, renderCompliancePageBody, renderMissingPageBody,
} from '../../implementers/lib/newpage-render.js';

// The systemic safety net for the "flat/unstyled generated content" bug
// class fixed 2026-09-15 (a stripped inline-page heading with nothing
// grounded to replace it; expand-content's own comparison tables and body
// prose always shipping bare <table>/<p>/<ul>). Every one of those was a
// SEPARATE gap in marker-merge.js's rendering, found by manual inspection —
// nothing in the Quality Gate actually looked at the HTML a draft would
// ship. This check closes that: it renders the draft through the exact same
// buildMergeValues() call apply-time splicing uses (same componentTemplates/
// designProfile the real PR would get) and inspects the RESULT for
// block-level tags with no class at all, so a future gap of the identical
// shape — a new template variant, a new generator branch — fails here
// instead of shipping silently.
//
// Deliberately an allow-list (RENDERED_ACTION_TYPES), not the deny-list
// design-integrity-guard.js's findDesignIntegrityIssues uses: that check
// only reads the site's stored profile, so it can run for every generator
// generically. This one actually CALLS buildMergeValues, which only has a
// real HTML-producing branch for the action types listed here — an
// unsupported actionType has nothing meaningful to render, not just nothing
// interesting to check. Extend this set when marker-merge.js gains a new
// visible-HTML branch, the same way COMPONENT_TEMPLATE_KEY is extended.
const RENDERED_ACTION_TYPES = new Set(['faq', 'expand-content', 'refresh-content', 'qa-content', 'internal-links']);

// Only fires when the site has real typography evidence to check against
// (profile.typography.body) — a site whose own CSS targets bare tag
// selectors (plain-css/css-modules, no utility classes) legitimately ships
// classless markup by design, and flagging that would be a pure false
// positive on a site with nothing wrong at all.
const BARE_TAG_RE = /<(h[1-6]|p|ul|ol|li|table|th|td)\b(?:(?!class=)[^>])*>/gi;

export function findBareMarkupIssues(actionType, content, componentTemplates, designProfile) {
  if (!RENDERED_ACTION_TYPES.has(actionType) || !content) return { issues: [] };
  if (!designProfile?.typography?.body) return { issues: [] };

  let result;
  try {
    result = buildMergeValues(actionType, content, 'visible', componentTemplates || {}, designProfile, { page: content?.page || null });
  } catch {
    // A render failure here is quality-gate.js's own concern to surface
    // elsewhere (or apply-time's) — this check only has an opinion once
    // there IS real HTML to inspect.
    return { issues: [] };
  }
  if (!result.ok) return { issues: [] };

  const issues = [];
  for (const [field, html] of Object.entries(result.values || {})) {
    if (typeof html !== 'string') continue;
    const seenTags = new Set();
    for (const match of html.matchAll(BARE_TAG_RE)) {
      const tag = match[1].toLowerCase();
      if (seenTags.has(tag)) continue; // one finding per tag type per field is enough signal to act on
      seenTags.add(tag);
      issues.push({
        path: field,
        patternId: 'bare-unstyled-markup',
        snippet: match[0].slice(0, 120),
        detail: `This site has real typography evidence, but the rendered <${tag}> carries no class at all — `
          + `it would render as unstyled browser-default text next to the site's own real design.`,
        blocking: true,
      });
    }
  }
  return { issues };
}

// Same idea, the OTHER rendering path: whole-new-page generation
// (newpage-render.js), which produces a markdown-with-inline-HTML body via
// wrapInSiteProse -> projectMarkdownTablesInBody/projectMarkdownProseInBody
// rather than marker-merge.js's splice. That grounding already existed
// before this session (it's what markdown-table-render.js/markdown-prose-
// render.js are FOR) — this is the same safety-net idea as
// findBareMarkupIssues above, applied here too, so a regression in THIS
// path also fails the gate instead of requiring another manual find.
//
// blog-outline's TSX variant (renderBlogOutlineBodyTsx) is deliberately not
// covered: it emits a JSX/TSX source file, not markdown-with-inline-HTML —
// styling is the responsibility of a human-written GeneratedBlogPost
// component in the client's own repo, not this pipeline, so a bare-tag scan
// has nothing meaningful to check there.
const NEW_PAGE_RENDERERS = {
  'landing-page': renderLandingPageBody,
  'blog-outline': renderBlogOutlineBody,
  'direct-answer': renderDirectAnswerBody,
  translation: renderTranslationBody,
  'cookie-policy': (content, site) => renderCompliancePageBody(content, {}, site),
  'privacy-policy': (content, site) => renderCompliancePageBody(content, {}, site),
  'terms-of-service': (content, site) => renderCompliancePageBody(content, {}, site),
  'missing-page-create': renderMissingPageBody,
};

// A raw, unconverted ATX heading ("## Heading") surviving into the rendered
// body when the site has a real section/item heading class — the markdown
// equivalent of a bare <h*>: it hasn't become an HTML tag YET (that's
// Eleventy's own build step, not this code), but with no class applied here
// it will build as a bare one. Lines already turned into inline
// `<h2 class="...">` HTML by projectMarkdownProseInBody don't match this
// (they start with `<`, not `#`), so this only fires on the specific
// regression it exists to catch: grounding that should have run but didn't.
const ATX_HEADING_RE = /^#{1,6}\s+\S/m;

export function findBareNewPageMarkupIssues(actionType, content, site) {
  const renderer = NEW_PAGE_RENDERERS[actionType];
  if (!renderer || !content) return { issues: [] };
  const designProfile = site?.url_file_map?.siteRoot?.designProfile;
  if (!designProfile?.typography?.body) return { issues: [] };

  let body;
  try {
    body = renderer(content, site);
  } catch {
    return { issues: [] }; // a render failure is this generator's own concern, not this check's
  }
  if (typeof body !== 'string') return { issues: [] };

  const issues = [];
  const seenTags = new Set();
  for (const match of body.matchAll(BARE_TAG_RE)) {
    const tag = match[1].toLowerCase();
    if (seenTags.has(tag)) continue;
    seenTags.add(tag);
    issues.push({
      path: 'body',
      patternId: 'bare-unstyled-markup',
      snippet: match[0].slice(0, 120),
      detail: `This site has real typography evidence, but this new page's rendered <${tag}> carries no class at all.`,
      blocking: true,
    });
  }

  const headingClass = designProfile.typography?.heading?.section || designProfile.typography?.heading?.item;
  const headingMatch = ATX_HEADING_RE.exec(body);
  if (headingClass && headingMatch) {
    issues.push({
      path: 'body',
      patternId: 'ungrounded-heading-markdown',
      snippet: headingMatch[0].slice(0, 120),
      detail: 'This site has a real section-heading class, but a raw "#" markdown heading survived into the '
        + 'rendered body — it will build as a bare, unstyled heading instead of using the site\'s own typography.',
      blocking: true,
    });
  }

  return { issues };
}

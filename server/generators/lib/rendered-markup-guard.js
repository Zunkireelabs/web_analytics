import { buildMergeValues, isInlineContentPage } from '../../implementers/lib/marker-merge.js';
import { isChromeLikeClass, ARTICLE_PAGE_TYPES as ARTICLE_TYPES } from '../../design-agent/live-analysis/chrome-context.js';
import {
  renderLandingPageBody, renderBlogOutlineBody, renderDirectAnswerBody,
  renderTranslationBody, renderCompliancePageBody, renderMissingPageBody, rendersAsInlineArticle,
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

// Evidence for the fallback check below: does this render contain ANY real
// classed element at all? Cheap existence test, not a parse.
const CLASSED_TAG_RE = /<[a-z][a-z0-9]*\b[^>]*\bclass="[^"]+"/i;

export function findBareMarkupIssues(actionType, content, componentTemplates, designProfile) {
  if (!RENDERED_ACTION_TYPES.has(actionType) || !content) return { issues: [] };

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

  const hasTypographyEvidence = Boolean(designProfile?.typography?.body);
  // A bare heading inheriting its host's own prose styling is the
  // deliberately correct shape on a blog/legal page (marker-merge.js's
  // groundedInlineHeadingClass) — never a defect there, so the fallback
  // check below must not fire on one.
  const inline = isInlineContentPage(content?.page);

  const issues = [];
  for (const [field, html] of Object.entries(result.values || {})) {
    if (typeof html !== 'string') continue;
    const seenTags = new Set();
    for (const match of html.matchAll(BARE_TAG_RE)) {
      const tag = match[1].toLowerCase();
      if (seenTags.has(tag)) continue; // one finding per tag type per field is enough signal to act on
      seenTags.add(tag);
      if (hasTypographyEvidence) {
        issues.push({
          path: field,
          patternId: 'bare-unstyled-markup',
          snippet: match[0].slice(0, 120),
          detail: `This site has real typography evidence, but the rendered <${tag}> carries no class at all — `
            + `it would render as unstyled browser-default text next to the site's own real design.`,
          blocking: true,
        });
        continue;
      }
      // FALLBACK — fires even with no typography.body evidence yet (a site
      // whose broader design profile hasn't been derived, or was derived
      // AFTER this specific componentTemplate was captured). Covers every
      // BARE_TAG_RE tag type — a heading, a table/th/td, a p/ul/li — not
      // just headings: the same reasoning applies equally to a comparison
      // table left bare next to a classed wrapper as to a bare heading.
      // Only fires when this SAME render also contains some other classed
      // element (e.g. the template's own wrapper div) — a genuinely
      // classless site has nothing classed anywhere to contrast against, so
      // this can never false-positive there; it only fires when a render is
      // internally inconsistent with itself. `inline` (blog/legal pages)
      // still exempts headings specifically, since a bare heading
      // inheriting the article's own prose is the deliberately correct
      // shape there (marker-merge.js's groundedInlineHeadingClass) — a bare
      // table/list on an inline page is never that kind of intentional, so
      // only the heading tags are skipped for `inline`. Confirmed live on
      // site 8864 (chayceproperties.com, 2026-09-20):
      // componentTemplates.expandContent's own captured row carried a bare
      // <h1> inside a classed `<div class="container">` wrapper, and it
      // shipped on 6+ pages because the check above (which requires
      // typography.body evidence) never even ran for this site at the time.
      if (!(inline && /^h[1-6]$/.test(tag)) && CLASSED_TAG_RE.test(html)) {
        issues.push({
          path: field,
          patternId: 'bare-tag-inconsistent-styling',
          snippet: match[0].slice(0, 120),
          detail: `The rendered <${tag}> carries no class at all, but this same block contains other classed `
            + `elements — an internally inconsistent render regardless of whether this site's full typography `
            + `profile has been derived yet.`,
          blocking: true,
        });
      }
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


// ── HEADING STANDARD AND STRUCTURE FOR GENERATED PAGES ──────────────────────────────────────────────────────────────────────────────────────────────────
// The rule: whatever is generated follows THAT client's own published format. The standard is read from the client's own evidence, never from a default and
// never from another client:
//   layout     siteRoot.inlineProse === 'layout': the client's blog layout styles the article's prose, so markdown headings are the client's own format
//              (the real typography is then verified on the rendered page by the render gate, desktop and mobile, against the client's own article)
//   grounded   the client's own article pattern records a subheading class: headings must carry it, so a raw "#" that survived is a grounding failure
//   inherit    the client has a captured article page but no subheading class: headings inherit the article's own styling (the render gate measures it)
//   unknown    no article of this client was ever captured: there is NO standard to hold the draft to, so it is not assumed acceptable. It is flagged for review.
export function articleHeadingStandard(site) {
  const sr = site?.url_file_map?.siteRoot || {};
  if (sr.inlineProse === 'layout') return { mode: 'layout' };
  const profile = sr.designProfile;
  const pattern = profile?.pageTypePatterns?.['blog-article'];
  const entry = Array.isArray(pattern?.textHierarchy) ? pattern.textHierarchy.find((h) => h?.role === 'subheading') : null;
  // A reference article exists when the profile recorded an article pattern/template or captured an article (or legal) page. Then the standard is ESTABLISHED, even when
  // the one subheading class on record cannot be trusted: it falls back to the page's own styling (inherit), never to "unknown".
  const hasReference = Boolean(pattern) || Boolean(sr.pageTemplates?.['blog-article'])
    || (Array.isArray(profile?.pages) && profile.pages.some((p) => ARTICLE_TYPES.includes(p?.pageType)));
  if (entry?.classes) {
    // A class is accepted as "the client's own subheading class" only when the evidence says it was OBSERVED ON A BODY HEADING (observedInBody). A profile recorded before that
    // evidence existed is accepted only while the class name does not read like navigation furniture ('v2-mm__aside-title' was a mega-menu panel's heading, not the article's).
    const observed = entry.observedInBody === true;
    const legacyAccepted = entry.observedInBody === undefined && !isChromeLikeClass(entry.classes);
    if (observed || legacyAccepted) return { mode: 'grounded', classes: String(entry.classes) };
    return hasReference ? { mode: 'inherit', ignoredClass: String(entry.classes) } : { mode: 'unknown' };
  }
  if (entry?.bare === true) return { mode: 'inherit', bare: true };
  return hasReference ? { mode: 'inherit' } : { mode: 'unknown' };
}

const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$|^(#{1,6})[ \t]*$|<h([1-6])\b[^>]*>([\s\S]*?)<\/h\4>/gim;

/** The headings of a rendered body in document order, from both markdown ("## x") and HTML (<h2>x</h2>) form. */
export function headingsOf(body) {
  const out = []; const text = String(body || '').replace(/```[\s\S]*?```/g, '');
  for (const m of text.matchAll(HEADING_RE)) {
    if (m[4]) out.push({ level: Number(m[4]), text: m[5].replace(/<[^>]+>/g, '').trim() });
    else if (m[3]) out.push({ level: m[3].length, text: '' });
    else out.push({ level: m[1].length, text: (m[2] || '').trim() });
  }
  return out;
}

/** Structure problems in a generated page body. `article`: the layout supplies the title (the H1), so the body starts at H2 and has no H1 of its own. */
export function headingStructureIssues(body, { article = false } = {}) {
  const hs = headingsOf(body); const issues = []; const add = (patternId, detail, snippet) => issues.push({ path: 'body', patternId, snippet: String(snippet || '').slice(0, 120), detail, blocking: true });
  const h1s = hs.filter((h) => h.level === 1);
  if (article && h1s.length) add('heading-structure', `An article's title is the page's H1 (the layout supplies it); this body adds another H1 ("${h1s[0].text}").`, `# ${h1s[0].text}`);
  else if (h1s.length > 1) add('heading-structure', `A page has one H1; this body has ${h1s.length}.`, `# ${h1s[1].text}`);
  const empty = hs.find((h) => !h.text);
  if (empty) add('heading-structure', `A heading (H${empty.level}) is empty.`, '#'.repeat(empty.level));
  let prev = article ? 1 : 0;
  for (const h of hs) {
    if (h.level > prev + 1 && !(prev === 0 && h.level <= 2)) { add('heading-structure', `Heading level skipped: H${prev || 1} is followed directly by H${h.level} ("${h.text}").`, `${'#'.repeat(h.level)} ${h.text}`); break; }
    prev = h.level;
  }
  return issues;
}

export function findBareNewPageMarkupIssues(actionType, content, site, { renderBody = null } = {}) {
  const renderer = NEW_PAGE_RENDERERS[actionType];
  if (!renderer || !content) return { issues: [] };
  // A blog the client's repo builds from a TSX component (a `filename` target, directory-per-post) is not markdown: its styling is that component's, and the
  // render gate measures the live page. Nothing here applies to it.
  if (actionType === 'blog-outline' && site?.url_file_map?.newContentTargets?.['blog-outline']?.filename) return { issues: [] };
  const designProfile = site?.url_file_map?.siteRoot?.designProfile || {};
  // The class-based checks below need typography evidence; the article STANDARD check and the heading STRUCTURE check do not (a client with no captured article
  // is exactly the case where nothing can be assumed), so they always run.
  const hasTypography = Boolean(designProfile?.typography?.body);

  let body;
  try {
    body = renderBody ? renderBody(content, site) : renderer(content, site); // renderBody: a test seam to force a specific rendered body
  } catch {
    return { issues: [] }; // a render failure is this generator's own concern, not this check's
  }
  if (typeof body !== 'string') return { issues: [] };

  const issues = [];
  const seenTags = new Set();
  for (const match of hasTypography ? body.matchAll(BARE_TAG_RE) : []) {
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

  const isArticle = actionType === 'blog-outline' && rendersAsInlineArticle(site, actionType);
  const headingClass = designProfile.typography?.heading?.section || designProfile.typography?.heading?.item;
  const headingMatch = ATX_HEADING_RE.exec(body);
  if (isArticle) {
    // An article is held to ITS OWN client's article standard (articleHeadingStandard), not to the landing-page heading class.
    const standard = articleHeadingStandard(site);
    if (standard.mode === 'unknown') {
      issues.push({ path: 'body', patternId: 'article-standard-not-established', snippet: '', blocking: true,
        detail: 'No published article of this client was captured, so there is no heading or typography standard to hold this draft to. It is not assumed acceptable: it needs a person to confirm the format.' });
    } else if (standard.mode === 'grounded' && headingMatch) {
      issues.push({ path: 'body', patternId: 'ungrounded-heading-markdown', snippet: headingMatch[0].slice(0, 120), blocking: true,
        detail: `This client's own articles style their subheadings with "${standard.classes}", but a raw "#" markdown heading survived into the rendered body without it.` });
    }
  } else if (hasTypography && headingClass && headingMatch) {
    issues.push({
      path: 'body',
      patternId: 'ungrounded-heading-markdown',
      snippet: headingMatch[0].slice(0, 120),
      detail: 'This site has a real section-heading class, but a raw "#" markdown heading survived into the '
        + 'rendered body — it will build as a bare, unstyled heading instead of using the site\'s own typography.',
      blocking: true,
    });
  }
  issues.push(...headingStructureIssues(body, { article: isArticle }));
  return { issues };
}

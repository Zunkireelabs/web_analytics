import { projectPageWrapper, projectCta, projectCard } from '../../design-agent/lib/design-profile.js';
import { projectMarkdownTablesInBody } from '../../generators/lib/markdown-table-render.js';
import { projectMarkdownProseInBody } from '../../generators/lib/markdown-prose-render.js';
import { stripFixedHeightClass, isInlineContentPage } from './marker-merge.js';
import { slugifyTitle } from './url-file-map.js';
// Real body-generation for the three net-new-content types (landing-page,
// blog-outline, translation). Unlike marker-merge.js's splice (which never
// needs to understand a template's syntax because it only replaces text
// between human-placed markers), these produce a brand-new file from
// scratch — there's no existing structure to splice into. Output is a
// minimal, generic Markdown-with-YAML-front-matter file (the same
// title/description front-matter shape confirmed against this platform's
// own real production templates, see marker-merge.js's header comment) —
// not a byte-perfect clone of any specific site's full page template
// (layout wrappers, includes, nav, etc.), since draft.content never
// contains that structure to begin with. A human reviews the real PR before
// merging — this is a deliberately conservative, always-buildable default,
// not a guess at unknown framework/component syntax.

function escapeYaml(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Every renderXBody() below always writes a real Markdown-syntax body
// (#, ##, > blockquote — see module comment). Eleventy only runs its
// Markdown pass on the `.md` template format by default; a `.njk`/`.html`
// target gets none, so that raw syntax would ship unrendered to visitors
// (confirmed live on zunkireelabs-web's /terms/, /privacy/, /cookies/ before
// this was added — see fix/legal-page-unrendered-markdown). Eleventy's own
// `templateEngineOverride` front-matter field runs a file through Nunjucks
// then Markdown regardless of its extension, with zero build-config change,
// so this is added unconditionally for any Eleventy site — harmless on
// `.md` targets that already get a native Markdown pass. `site` is optional
// (some callers, e.g. tests, don't have one) — no site/no generator match
// means no override, same as today's behavior for non-Eleventy stacks,
// which this function has no evidence about and must not guess for.
function templateEngineOverrideField(site) {
  return site?.url_file_map?.renderCapabilities?.generator === 'eleventy'
    ? ['templateEngineOverride', 'njk, md']
    : null;
}

function frontMatter(fields, site) {
  const lines = ['---'];
  const override = templateEngineOverrideField(site);
  if (override) fields = [override, ...fields];
  for (const [key, value] of fields) {
    if (value == null || value === '') continue;
    lines.push(`${key}: "${escapeYaml(value)}"`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

// `permalink` (every renderer below) is the page's real public URL path,
// resolved by frontend.js from the site's own newContentTargets.urlPattern
// config — null whenever that config is absent or unusable, in which case it
// is simply omitted and the build decides the URL exactly as it does today.
// It is what puts a new page into a build-time-generated sitemap at the right
// URL (see url-file-map.js's resolveNewContentUrl) with no second draft, no
// second PR, and no edit to a sitemap file that in the Eleventy case doesn't
// exist in the repo at all.
// featuredImage front matter is deliberately opt-IN here, unlike
// renderBlogOutlineBody's guessed default (imageKey/altKey/creditKey above) —
// a blog post having a hero image is an established convention this
// platform can safely assume; a landing page or direct-answer page having
// one is not (this renderer emitted nothing image-related at all until
// site-wide Pexels sourcing was requested). So the field is only written
// when `fieldNames.featuredImage` came from REAL sibling evidence
// (newcontent-contract.js sampled an existing page in this same directory
// that already has one) — never a guessed key for a page type with no
// established image convention on this site.
function featuredImageFields(content, fieldNames) {
  if (!fieldNames?.featuredImage || !content.featuredImage?.url) return [];
  return [
    [fieldNames.featuredImage, content.featuredImage.url],
    [fieldNames.featuredImageAlt || 'featuredImageAlt', content.featuredImage.alt],
    [fieldNames.featuredImageCredit || 'featuredImageCredit', content.featuredImage.photographer
      ? `Photo by ${content.featuredImage.photographer} on Pexels`
      : null],
  ];
}

export function renderLandingPageBody(content, site, { permalink = null, layout = null, fieldNames = {} } = {}) {
  const front = frontMatter([
    ['layout', layout],
    ['permalink', permalink],
    ['title', content.metaTitle || content.headline],
    ['description', content.metaDescription || content.subheadline],
    ...featuredImageFields(content, fieldNames),
  ], site);
  const parts = [`# ${content.headline || content.target}`];
  if (content.subheadline) parts.push(content.subheadline);
  for (const s of content.sections || []) {
    const rendered = renderSection(s, site);
    if (rendered) parts.push(rendered);
  }
  const cta = renderCta(content.cta, site);
  if (cta) parts.push(cta);
  return `${front}\n${wrapInSiteProse(parts.join('\n\n'), site, permalink)}\n`;
}

export function renderBlogOutlineBody(content, site, { permalink = null, layout = null, fieldNames = {} } = {}) {
  // `fieldNames` maps a canonical field onto whatever THIS directory's
  // existing posts call it (newcontent-contract.js). The defaults below are
  // only what gets used when no sibling could be read — they are not a
  // contract any particular site honours. This mattered: a hardcoded `image`
  // key meant zunkireelabs.com's blog template, which reads `featuredImage`,
  // rendered no image on any generated post even though the Pexels URL was
  // sitting right there in the front matter. Fixed by defaulting to the exact
  // same canonical names FIELD_ALIASES itself lists first/most-likely for
  // each field (newcontent-contract.js) — the no-siblings case should guess
  // the platform's own best-known name, not an arbitrary lower-priority
  // alias from that same list.
  const imageKey = fieldNames.featuredImage || 'featuredImage';
  const altKey = fieldNames.featuredImageAlt || 'featuredImageAlt';
  const creditKey = fieldNames.featuredImageCredit || 'featuredImageCredit';
  const front = frontMatter([
    ['layout', layout],
    ['permalink', permalink],
    ['title', content.title || content.topic],
    ['description', content.metaDescription],
    ['date', new Date().toISOString().slice(0, 10)],
    // Optional — only present when blog-outline.js's Pexels search
    // (generators/lib/pexels-client.js) found a match; omitted otherwise via
    // frontMatter()'s existing null/empty skip, same as every other field
    // here. A remote URL in front matter, not a binary committed to the
    // repo — the client's blog template is responsible for rendering it.
    [imageKey, content.featuredImage?.url],
    [altKey, content.featuredImage?.alt],
    [creditKey, content.featuredImage?.photographer
      ? `Photo by ${content.featuredImage.photographer} on Pexels`
      : null],
  ], site);
  const parts = [];
  for (const s of content.sections || []) {
    if (!s?.heading) continue;
    parts.push(`## ${s.heading}\n\n${s.body || ''}`);
  }
  // content.suggestedFaqTopics and content.suggestedInternalLinks are
  // deliberately NOT rendered. They are instructions ABOUT the article, aimed at
  // whoever (or whatever) works on it next — "FAQ topics to cover", "Suggested
  // internal links" — and they used to be appended as real ## sections, so a
  // published post ended with a visible editorial checklist. Harmless while a
  // human reviewed every blog draft by hand; the moment blog-outline can open a
  // PR unattended it becomes the first thing a reader sees at the bottom of the
  // page.
  //
  // Nothing is lost by dropping them here: both fields stay on the draft, so the
  // Action Center still shows them, the faq generator can still act on the
  // topics, and internal-links can still place the links — in context, where an
  // internal link is actually worth something, rather than as a bare list under
  // a heading that announces it was machine-generated.
  //
  // Worth knowing for any future net-new content type: the Quality Gate
  // (generators/lib/quality-gate.js, including content-scaffolding-guard's
  // explicit checks for exactly this kind of text) inspects the generator's
  // `content` object, but the artifact that actually gets committed is the
  // markdown rendered HERE, at apply time. Scaffolding introduced during
  // rendering is invisible to every guard by construction — so it has to not be
  // introduced.
  return `${front}\n${wrapInSiteProse(parts.join('\n\n'), site, permalink)}\n`;
}

// Next.js App Router variant of renderBlogOutlineBody, for a
// newContentTargets["blog-outline"] configured with `filename` (a
// directory-per-post framework — see url-file-map.js's resolveNewContentTarget).
// Deliberately does NOT hand-write JSX around the generated title/body text:
// a title or paragraph containing a brace, angle bracket, quote or backtick
// would either break the surrounding TSX as source code or (worse) be
// silently parsed as a JSX expression instead of literal text. Content is
// instead serialized with JSON.stringify — a plain, always-valid JS object
// literal — and handed as props to GeneratedBlogPost, a small shared
// component this page imports and that owns 100% of the actual markup. The
// component is written once per site (a real, human-reviewed file in the
// client's own repo, not generated per post) and can be restyled without
// regenerating any existing post.
//
// `post` is exported (not a private `const`) so a listing page can import
// title/featuredImage/publishedAt straight out of each generated post's own
// file at build time — the single source of truth this file already writes,
// rather than a second sidecar/metadata file that could drift from it. See
// e.g. Admizz's src/app/blogs/page.tsx, which merges these with its Sanity
// posts.
export function renderBlogOutlineBodyTsx(content, site, { canonicalUrl = null } = {}) {
  const title = content.title || content.topic || 'Untitled';
  const props = {
    title,
    // The post's own identity — same slugifyTitle call resolveNewContentTarget
    // used to decide this file's own directory name, so GeneratedBlogPost's
    // "exclude myself from related posts" check can never disagree with the
    // real URL. featuredImage/categories are optional real facts, never
    // invented if absent (see blog-outline.js's own fetchRealCategories).
    slug: slugifyTitle(title),
    sections: (content.sections || [])
      .filter((s) => s?.heading)
      .map((s) => ({ heading: s.heading, body: s.body || '' })),
    featuredImage: content.featuredImage?.url
      ? { url: content.featuredImage.url, alt: content.featuredImage.alt || null }
      : null,
    categories: Array.isArray(content.categories) ? content.categories : [],
    publishedAt: new Date().toISOString(),
  };
  const metaTitle = content.title || content.topic || 'Untitled';
  const metaDescription = content.metaDescription || '';
  const lines = [
    'import type { Metadata } from "next";',
    'import GeneratedBlogPost from "@/components/GeneratedBlogPost";',
    '',
    `export const post = ${JSON.stringify(props, null, 2)};`,
    '',
    'export const metadata: Metadata = {',
    `  title: ${JSON.stringify(metaTitle)},`,
    `  description: ${JSON.stringify(metaDescription)},`,
    ...(canonicalUrl ? [`  alternates: { canonical: ${JSON.stringify(canonicalUrl)} },`] : []),
    '};',
    '',
    'export default function Page() {',
    '  return <GeneratedBlogPost {...post} />;',
    '}',
    '',
  ];
  return lines.join('\n');
}

// The direct-answer paragraph goes immediately after the heading — no
// filler sections before it — since the whole point of this content type is
// the AI-citation "answer-first" pattern: a real assistant (or a human
// skimming) gets the complete answer without scrolling past preamble.
export function renderDirectAnswerBody(content, site, { permalink = null, layout = null, fieldNames = {} } = {}) {
  const front = frontMatter([
    ['layout', layout],
    ['permalink', permalink],
    ['title', content.title || content.heading || content.query],
    ['description', content.directAnswer?.slice(0, 155)],
    ['date', new Date().toISOString().slice(0, 10)],
    ...featuredImageFields(content, fieldNames),
  ], site);
  const parts = [`# ${content.heading || content.query}`, content.directAnswer || ''];
  for (const s of content.supportingSections || []) {
    if (s?.heading) parts.push(`## ${s.heading}\n\n${s.body || ''}`);
  }
  // Same editorial-scaffolding removal as renderBlogOutlineBody above, for the
  // same reason — see the long comment there. Both fields remain on the draft;
  // they just never reach a reader.
  return `${front}\n${wrapInSiteProse(parts.join('\n\n'), site, permalink)}\n`;
}

// The page a dead internal link already pointed at (generators/
// missing-page-create.js). The permalink is the dead URL's own path rather
// than a urlPattern-derived one — every other net-new renderer here is
// creating a page at a URL of its own choosing, whereas this one exists to
// make one specific already-published URL resolve, and a page that builds to
// any other path leaves that link broken.
export function renderMissingPageBody(content, site, { permalink = null, layout = null } = {}) {
  const front = frontMatter([
    ['layout', layout],
    ['permalink', permalink],
    ['title', content.title],
    ['description', content.metaDescription],
    ['date', new Date().toISOString().slice(0, 10)],
  ], site);
  const parts = [];
  for (const s of content.sections || []) {
    if (!s?.heading) continue;
    parts.push(`## ${s.heading}\n\n${s.body || ''}`);
  }
  // content.siblings/modelPage/sourcePages are review metadata (which pages
  // justified creating this and which one it was modelled on) — same reason
  // renderBlogOutlineBody withholds its editorial fields, they must never
  // reach a reader.
  return `${front}\n${wrapInSiteProse(parts.join('\n\n'), site, permalink)}\n`;
}

// Deliberately NOT a structural clone of the source page (draft.content only
// has the source's extracted plain text, not its raw template source — see
// generators/translation.js) — a minimal new page with the real translated
// title/description/content. A reviewer adapts layout/includes on the real
// PR as needed, same as landing-page/blog-outline.
export function renderTranslationBody(content, site, { permalink = null, layout = null } = {}) {
  const front = frontMatter([
    ['layout', layout],
    ['permalink', permalink],
    ['title', content.translatedTitle || content.sourceTitle],
    ['description', content.translatedMetaDescription || content.sourceMetaDescription],
  ], site);
  return `${front}\n${wrapInSiteProse(content.translatedContent || '', site, permalink)}\n`;
}

// Only a tiny, deliberately narrow parse of the two fields this codebase's
// own real compliance-page templates set — not a general YAML parser.
// Overwriting an already-linked page (frontend.js's COMPLIANCE_ACTION_TYPES
// existingFile branch) without preserving these would silently orphan it:
// no `layout` means no site chrome/styling wraps the new content, and no
// `permalink` means Eleventy falls back to a filename-derived URL instead
// of the real one (e.g. zunkireelabs.com's /privacy/ actually lives at
// src/pages/privacy-policy-zunkiree-labs.njk with an explicit
// `permalink: /privacy/` — losing that would move the live page to
// /privacy-policy-zunkiree-labs/ and 404 the real URL).
export function extractPreservedFrontMatter(rawContent) {
  if (!rawContent) return {};
  const match = rawContent.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const preserved = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(layout|permalink):\s*"?([^"\n]*)"?\s*$/);
    if (m) preserved[m[1]] = m[2];
  }
  return preserved;
}

// Cookie Policy / Privacy Policy / Terms of Service — same minimal
// front-matter + heading/section shape as renderLandingPageBody, plus the
// generator's disclaimer rendered as a visible callout at the very top of
// the file (not just a `content` field a reviewer could miss), so "this is
// a template, not legal advice, have it reviewed" survives into the real PR
// diff a human reviews before merging. `preserved` (from
// extractPreservedFrontMatter, existing-file overwrites only) is written
// first so a real layout/permalink always wins over nothing.
//
// Body is wrapped in this SITE's own real typography markup — the same
// per-tenant componentTemplates mechanism marker-merge.js already uses for
// faq/expandContent/internalLinks/qaContent (design-drift.js's
// COMPONENT_TEMPLATE_KEY['content-wrapper'] = 'contentWrapper'), derived by
// the Design Agent from the site's own real repo, never a class list
// hardcoded here for one tenant. Without a real base layout applying its
// own typography to `{{ content | safe }}`, an unconfigured site ships bare,
// unstyled `<h1>/<h2>/<p>` (confirmed live on zunkireelabs-web's own
// /terms/, /privacy/, /cookies/ before contentWrapper was captured for it —
// see fix/legal-page-prose-styling) — that plain-markdown output is this
// function's deliberate, safe default for any site with no contentWrapper
// configured yet, same as every other net-new-content renderer above.
function fillContentWrapper(wrapper, body) {
  // Blank line right after the opening tag and right before the closing tag
  // keeps them as their own markdown-it HTML blocks, so everything between
  // is still parsed as normal markdown instead of being swallowed verbatim.
  const [open, close] = wrapper.split('{{BODY}}');
  return `${open.trimEnd()}\n\n${body}\n\n${close.trimStart()}`;
}

// Applies this site's own real prose wrapper to a rendered markdown body, for
// EVERY net-new whole-page type (frontend.js's FRONTEND_ACTION_TYPES), not
// just the compliance trio it was originally written for — landing pages,
// blog posts, direct-answer pages and translations are the same shape and
// were shipping without it, i.e. bare unstyled headings and paragraphs into a
// real PR. Unchanged fallback: a site with no contentWrapper configured gets
// the plain markdown body exactly as before, so nothing regresses for a site
// that hasn't been through the Design Agent yet.
function wrapInSiteProse(body, site, permalink = null) {
  // Any real markdown table in the generated body goes through the same
  // projectTable() call content-integrity-repair.js already uses to rebuild
  // a broken/raw-text table on an EXISTING page — one table pipeline for
  // both repair and net-new generation, not a generic markdown-table render
  // here and a tenant-aware one there. Runs before the prose wrapper below
  // so the projected <table> lands inside it, same as any other block.
  const tableProjected = projectMarkdownTablesInBody(body, site?.url_file_map?.siteRoot?.designProfile);

  // Then the prose itself. The wrapper below positions a body; it does not
  // style the headings and paragraphs inside it, and on a utility-class site
  // nothing else will either — see markdown-prose-render.js for why an
  // unstyled <h2>/<p> inside a correctly-padded container is precisely the
  // "generated pages look flat next to the real ones" symptom. Runs after the
  // table pass so already-projected table markup is left alone.
  //
  // `inline` (same classifier marker-merge.js's splice path already uses):
  // a blog post's or legal page's own "## Subheading" is an in-article
  // subheading, not a real page section — confirmed live (2026-09-24), a
  // generated blog post's own body headings rendered at hero/section scale
  // (text-3xl md:text-4xl lg:text-5xl), visibly larger than the site's own
  // human-written reference post's item-scale (text-2xl) headings for the
  // exact same markdown. Without a real permalink (some callers, e.g. a
  // translation of an unclassifiable page) this is simply false, same as
  // today's behavior.
  // `permalink` here is a bare path ("/blog/some-post/"), not a full URL —
  // classifyPageType (via isInlineContentPage) needs one to parse a
  // pathname from, so a placeholder origin stands in; only the path is ever
  // read. Malformed/absent permalinks fall through to inline=false, same as
  // today's behavior for a caller with no permalink at all.
  let inline = false;
  if (permalink) {
    try { inline = isInlineContentPage(new URL(permalink, 'https://placeholder.invalid').href); } catch { /* inline stays false */ }
  }
  const proseProjected = projectMarkdownProseInBody(tableProjected, site?.url_file_map?.siteRoot?.designProfile, { inline });

  // Configured template first, then a projection from the site's design
  // profile, then bare markdown. That middle step is the change: net-new
  // pages were the last renderers still shipping unstyled headings and
  // paragraphs into a real PR whenever a contentWrapper happened not to be
  // configured, even on a site whose design language was already known.
  // DEFAULT behaviour (bare body) now only applies to a site with no design
  // knowledge at all.
  // stripFixedHeightClass: a captured wrapper can carry an incidental fixed
  // height from whatever instance the Design Agent captured it from (see
  // marker-merge.js's sanitizeCapturedTemplate for the 2026-09-09 case this
  // guards against) — catastrophic here specifically, since this wrapper
  // holds an ENTIRE net-new page body, not one section.
  const configured = stripFixedHeightClass(site?.url_file_map?.siteRoot?.componentTemplates?.contentWrapper?.wrapper);
  const wrapper = configured?.includes('{{BODY}}')
    ? configured
    : projectPageWrapper(site?.url_file_map?.siteRoot?.designProfile);
  return wrapper?.includes('{{BODY}}') ? fillContentWrapper(wrapper, proseProjected) : proseProjected;
}

function designProfileOf(site) {
  return site?.url_file_map?.siteRoot?.designProfile || null;
}

// A landing page's call to action. Rendered as a real button in the site's
// own styling when it has a button convention; otherwise the plain markdown
// link this always emitted.
function renderCta(cta, site) {
  if (!cta) return null;
  const projected = projectCta(designProfileOf(site), { label: cta });
  return projected ? `\n${projected}\n` : `[${cta}](#)`;
}

// A content section, in the site's card convention when it has one. Falls
// back to the plain "## heading + body" markdown these renderers always
// produced, so a site with no card pattern is byte-for-byte unchanged.
function renderSection(section, site, headingLevel = 2) {
  if (!section?.heading) return null;
  const projected = projectCard(designProfileOf(site), {
    heading: section.heading, body: section.body || '', headingLevel,
  });
  return projected || `${'#'.repeat(headingLevel)} ${section.heading}\n\n${section.body || ''}`;
}

export function renderCompliancePageBody(content, preserved = {}, site, { permalink = null, layout = null } = {}) {
  const front = frontMatter([
    // An existing page's own layout always wins, same reasoning as permalink
    // below — overwriting a real page must not restyle it.
    ['layout', preserved.layout || layout],
    // An existing page's own permalink always wins — overwriting a real,
    // already-linked page must never move its live URL (see
    // extractPreservedFrontMatter below). The resolved one only applies to
    // the genuinely-new-file case, where there is no existing URL to keep.
    ['permalink', preserved.permalink || permalink],
    ['title', content.metaTitle || content.headline],
    ['description', content.metaDescription],
  ], site);
  const parts = [`# ${content.headline}`];
  if (content.disclaimer) parts.push(`> **${content.disclaimer}**`);
  for (const s of content.sections || []) {
    if (s?.heading) parts.push(`## ${s.heading}\n\n${s.body || ''}`);
  }
  return `${front}\n${wrapInSiteProse(parts.join('\n\n'), site, preserved.permalink || permalink)}\n`;
}

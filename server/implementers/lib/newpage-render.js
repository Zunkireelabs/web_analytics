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

export function renderLandingPageBody(content, site) {
  const front = frontMatter([
    ['title', content.metaTitle || content.headline],
    ['description', content.metaDescription || content.subheadline],
  ], site);
  const parts = [`# ${content.headline || content.target}`];
  if (content.subheadline) parts.push(content.subheadline);
  for (const s of content.sections || []) {
    if (s?.heading) parts.push(`## ${s.heading}\n\n${s.body || ''}`);
  }
  if (content.cta) parts.push(`[${content.cta}](#)`);
  return `${front}\n${parts.join('\n\n')}\n`;
}

export function renderBlogOutlineBody(content, site) {
  const front = frontMatter([
    ['title', content.title || content.topic],
    ['description', content.metaDescription],
    ['date', new Date().toISOString().slice(0, 10)],
  ], site);
  const parts = [];
  for (const s of content.sections || []) {
    if (!s?.heading) continue;
    parts.push(`## ${s.heading}\n\n${s.body || ''}`);
  }
  if (content.suggestedFaqTopics?.length) {
    parts.push(`## FAQ topics to cover\n\n${content.suggestedFaqTopics.map((t) => `- ${t}`).join('\n')}`);
  }
  if (content.suggestedInternalLinks?.length) {
    parts.push(`## Suggested internal links\n\n${content.suggestedInternalLinks.map((l) => `- [${l.anchorText}](${l.targetUrl})`).join('\n')}`);
  }
  return `${front}\n${parts.join('\n\n')}\n`;
}

// The direct-answer paragraph goes immediately after the heading — no
// filler sections before it — since the whole point of this content type is
// the AI-citation "answer-first" pattern: a real assistant (or a human
// skimming) gets the complete answer without scrolling past preamble.
export function renderDirectAnswerBody(content, site) {
  const front = frontMatter([
    ['title', content.title || content.heading || content.query],
    ['description', content.directAnswer?.slice(0, 155)],
    ['date', new Date().toISOString().slice(0, 10)],
  ], site);
  const parts = [`# ${content.heading || content.query}`, content.directAnswer || ''];
  for (const s of content.supportingSections || []) {
    if (s?.heading) parts.push(`## ${s.heading}\n\n${s.body || ''}`);
  }
  if (content.suggestedFaqTopics?.length) {
    parts.push(`## FAQ topics to cover\n\n${content.suggestedFaqTopics.map((t) => `- ${t}`).join('\n')}`);
  }
  if (content.suggestedInternalLinks?.length) {
    parts.push(`## Suggested internal links\n\n${content.suggestedInternalLinks.map((l) => `- [${l.anchorText}](${l.targetUrl})`).join('\n')}`);
  }
  return `${front}\n${parts.join('\n\n')}\n`;
}

// Deliberately NOT a structural clone of the source page (draft.content only
// has the source's extracted plain text, not its raw template source — see
// generators/translation.js) — a minimal new page with the real translated
// title/description/content. A reviewer adapts layout/includes on the real
// PR as needed, same as landing-page/blog-outline.
export function renderTranslationBody(content, site) {
  const front = frontMatter([
    ['title', content.translatedTitle || content.sourceTitle],
    ['description', content.translatedMetaDescription || content.sourceMetaDescription],
  ], site);
  return `${front}\n${content.translatedContent || ''}\n`;
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

export function renderCompliancePageBody(content, preserved = {}, site) {
  const front = frontMatter([
    ['layout', preserved.layout],
    ['permalink', preserved.permalink],
    ['title', content.metaTitle || content.headline],
    ['description', content.metaDescription],
  ], site);
  const parts = [`# ${content.headline}`];
  if (content.disclaimer) parts.push(`> **${content.disclaimer}**`);
  for (const s of content.sections || []) {
    if (s?.heading) parts.push(`## ${s.heading}\n\n${s.body || ''}`);
  }
  const body = parts.join('\n\n');
  const wrapper = site?.url_file_map?.siteRoot?.componentTemplates?.contentWrapper?.wrapper;
  const wrapped = wrapper?.includes('{{BODY}}') ? fillContentWrapper(wrapper, body) : body;
  return `${front}\n${wrapped}\n`;
}

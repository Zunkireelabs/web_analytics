// Marker-based splice — the only merge strategy this codebase uses for
// editing an EXISTING page's real template file, because it never requires
// parsing or understanding an unknown site's real templating syntax
// (Nunjucks/Astro/Next.js/Hugo/plain HTML/...): a literal text replacement
// anchored on exact, human-placed marker comments works identically no
// matter what surrounds them. The client (or their webmaster) adds these
// once per template, a real one-time step — same spirit as the GSC-access
// grant already required at onboarding.
//
// Two real marker conventions — the client picks whichever fits a given
// field's real syntax context:
//
//   BLOCK (multi-line HTML body content, e.g. an FAQ section):
//     <!-- SEOAI:NAME:START -->...content...<!-- SEOAI:NAME:END -->
//
//   LINE (a single quoted value, e.g. YAML/JS front matter — confirmed
//   against this platform's own real production site, which stores
//   title/description as `title: "..."` front matter, not an HTML <title>
//   tag). A block wrapper placed INSIDE the quotes would leak literal
//   comment text into the rendered page, since front-matter values are
//   substituted verbatim — so this form anchors on a trailing comment
//   instead and rewrites the quoted value on that same line:
//     title: "current value" # SEOAI:NAME

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function blockRegex(name) {
  const start = `<!-- SEOAI:${name}:START -->`;
  const end = `<!-- SEOAI:${name}:END -->`;
  // [\s\S] (not .) so this matches across newlines. Captures the start/end
  // tags too, so a replacement can re-wrap them exactly, preserving the
  // marker for the next real merge.
  return new RegExp(`(${escapeRegExp(start)})([\\s\\S]*?)(${escapeRegExp(end)})`);
}

// Matches a line ending in a trailing `# SEOAI:<name>` (or `<!-- SEOAI:<name> -->`,
// for a YAML/HTML-comment-style single-line marker) comment, capturing the
// quoted value earlier on that same line so it can be replaced in place.
function lineRegex(name) {
  const marker = `(?:#\\s*SEOAI:${escapeRegExp(name)}\\s*|<!--\\s*SEOAI:${escapeRegExp(name)}\\s*-->)`;
  return new RegExp(`^(.*?)(["'])((?:(?!\\2)[^\\\\]|\\\\.)*)\\2(\\s*${marker}\\s*)$`, 'm');
}

function findMarker(fileContent, name) {
  const block = blockRegex(name).exec(fileContent);
  if (block) return { kind: 'block', old: block[2] };
  const line = lineRegex(name).exec(fileContent);
  if (line) return { kind: 'line', old: line[3] };
  return null;
}

// Exact, deterministic presence check — the one piece of render-mode
// evidence (lib/render-inspector.js) that's always answered by regex, never
// guessed at by an LLM: does this exact marker already exist in the file.
export function hasMarker(fileContent, name) {
  return !!findMarker(fileContent, name);
}

// Fields using the LINE convention (a single quoted front-matter value) —
// established by this codebase's only real precedent, meta-title's `title`
// field (see module comment above). Everything else is a BLOCK marker.
const LINE_CONVENTION_FIELDS = new Set(['title']);

// Fields whose real HTML context is <head> specifically (canonical, Open
// Graph tags, and any future head-metadata generator — meta description,
// meta robots, hreflang, verification tags, ...). The default BLOCK
// convention's EOF auto-insert (insertBlockMarker below) is safe for body
// content, but a <link rel="canonical">/og:* tag placed in <body> or after
// </html> is browser-tolerant yet SEO-invisible — a "successful" splice
// that silently does nothing. These fields are therefore never auto-
// inserted at EOF. They're only ever auto-created NESTED inside the site's
// own one-time, human-placed <!-- SEOAI:HEAD:START/END --> region — safe
// because a human confirmed that region is genuinely inside their real
// <head>. If that region doesn't exist yet, this fails honestly (no draft
// applied) rather than drafting a tag that will never take effect. A future
// head-metadata generator just adds its field name here — no per-generator
// placement code.
const HEAD_SCOPED_FIELDS = new Set(['canonical', 'openGraph']);
const HEAD_MARKER_NAME = 'HEAD';

// Exposed so callers (backend.js's computeMarkerMerge) can give a more
// specific "marker not found" error for a head-scoped field — pointing at
// the missing HEAD region itself, not just the field's own marker name.
export function isHeadScopedField(field) {
  return HEAD_SCOPED_FIELDS.has(field);
}

// Fields whose real render location can't be assumed to be "wherever the
// file happens to end" the way flat HTML/Markdown body content can. A
// component-based page (React/Next/Astro/.jsx/.tsx) has real markup after
// its last line of source — outside the rendered component tree entirely —
// so the default BLOCK convention's EOF auto-insert (insertBlockMarker
// below) would "succeed" (marker created, PR merges, build passes) while
// producing a marker that never renders on the live page. Same hazard
// HEAD_SCOPED_FIELDS already guards against for <head> tags; this is the
// body-content equivalent. These fields are therefore never auto-inserted
// at EOF — only ever spliced into a marker a human has already placed
// somewhere genuinely inside the page's real rendered body. If that marker
// doesn't exist yet, this fails honestly (no draft applied) rather than
// drafting content that will never actually be visible.
const NO_EOF_INSERT_FIELDS = new Set(['expandedContent']);

// Exposed so callers can give a more specific "marker not found" error for
// a body-scoped field — same spirit as isHeadScopedField above.
export function isNoEofInsertField(field) {
  return NO_EOF_INSERT_FIELDS.has(field);
}

// Auto-creates a head-scoped field's own empty marker, nested inside the
// site's already-placed <!-- SEOAI:HEAD:START/END --> region — never at
// EOF. Returns null when that region doesn't exist yet (an onboarding step
// the operator hasn't done for this template), leaving spliceMarkers'
// existing "marker not found" failure as the honest outcome, same
// discipline as insertLineMarker's null-on-unsafe return below.
function insertHeadScopedMarker(fileContent, markerName) {
  const match = blockRegex(HEAD_MARKER_NAME).exec(fileContent);
  if (!match) return null;
  const [full, start, inner, end] = match;
  const newInner = `${inner}\n<!-- SEOAI:${markerName}:START --><!-- SEOAI:${markerName}:END -->`;
  return fileContent.slice(0, match.index) + start + newInner + end + fileContent.slice(match.index + full.length);
}

// The front-matter block only, `---\n...\n---\n` at the very start of the
// file — auto-insertion for a LINE marker is restricted to inside this
// block so it can never mistake an unrelated `title:`-looking string
// elsewhere in the file's real body content for the front-matter field.
function frontMatterLength(fileContent) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(fileContent);
  return match ? match[0].length : null;
}

// A plain (unquoted) YAML scalar is unsafe to mechanically wrap in double
// quotes without a real YAML parser if it contains an unescaped '"' (we
// don't escape it), a '#' (ambiguous comment-start once quoted), or opens
// with a flow/anchor/tag/block-scalar indicator that changes meaning once
// quoted (e.g. `[`, `{`, `&`, `*`, `!`, `|`, `>`, `%`, `@`, backtick).
// Anything matching this bails out to the honest "marker not found"
// failure instead of risking a wrong rewrite — same conservatism as the
// quoted-value path, just drawing the safe boundary around a wider (and,
// on this site's own real pages, at least as common) case.
const UNSAFE_UNQUOTED_VALUE = /["#]|^[[{&*!|>%@`]/;

// Auto-inserts a trailing `# SEOAI:<name>` comment onto an existing
// `field: value` front-matter line — deliberately conservative: only
// proceeds when front matter exists. Two forms, tried in order:
//   1. `field: "value"` / `field: 'value'` (already quoted) — the marker
//      comment is simply appended after the closing quote.
//   2. `field: value` (a plain, unquoted scalar) — wrapping it in double
//      quotes doesn't change its parsed value, so this is safe to do
//      automatically UNLESS the value itself needs real YAML-aware
//      escaping/interpretation (see UNSAFE_UNQUOTED_VALUE) — that case is
//      left for a human to quote and mark by hand, same as before this
//      form existed at all.
// Returns null on anything less than a clean, safe match, leaving the
// caller to fall back to today's honest "marker not found" failure rather
// than guess further.
function insertLineMarker(fileContent, field, markerName) {
  const fmLen = frontMatterLength(fileContent);
  if (fmLen == null) return null;
  const frontMatter = fileContent.slice(0, fmLen);
  const rest = fileContent.slice(fmLen);

  const quotedRe = new RegExp(`^(${escapeRegExp(field)}:\\s*)(["'])((?:(?!\\2)[^\\\\]|\\\\.)*)\\2\\s*$`, 'm');
  if (quotedRe.test(frontMatter)) {
    const newFrontMatter = frontMatter.replace(quotedRe, (_m, prefix, q, val) => `${prefix}${q}${val}${q} # SEOAI:${markerName}`);
    return newFrontMatter + rest;
  }

  const unquotedRe = new RegExp(`^(${escapeRegExp(field)}:\\s*)(\\S.*?)\\s*$`, 'm');
  const unquoted = unquotedRe.exec(frontMatter);
  if (unquoted && !UNSAFE_UNQUOTED_VALUE.test(unquoted[2])) {
    const newFrontMatter = frontMatter.replace(unquotedRe, (_m, prefix, val) => `${prefix}"${val}" # SEOAI:${markerName}`);
    return newFrontMatter + rest;
  }

  return null;
}

// Appends an empty block marker at the very end of the file — purely
// additive, so it can never disturb existing template syntax, front
// matter, or layout regardless of framework. The same position every
// block marker has been manually placed at by hand this session.
function insertBlockMarker(fileContent, markerName) {
  const sep = fileContent.length > 0 && !fileContent.endsWith('\n') ? '\n' : '';
  return `${fileContent}${sep}<!-- SEOAI:${markerName}:START --><!-- SEOAI:${markerName}:END -->\n`;
}

// Auto-creates any marker referenced in markerMap that isn't already
// present in fileContent, so a draft never has to wait on a human
// hand-placing an empty marker first. Never touches an existing marker
// (hasMarker guard) — only ever adds genuinely missing ones. A LINE marker
// that can't be safely placed (see insertLineMarker) is simply skipped,
// leaving spliceMarkers()'s existing "marker not found" failure as the
// honest fallback for that one field.
export function ensureMarkers(fileContent, markerMap) {
  let content = fileContent;
  const inserted = [];
  for (const [field, markerName] of Object.entries(markerMap)) {
    if (hasMarker(content, markerName)) continue;
    if (LINE_CONVENTION_FIELDS.has(field)) {
      const updated = insertLineMarker(content, field, markerName);
      if (updated) { content = updated; inserted.push(markerName); }
      continue;
    }
    if (HEAD_SCOPED_FIELDS.has(field)) {
      const updated = insertHeadScopedMarker(content, markerName);
      if (updated) { content = updated; inserted.push(markerName); }
      continue; // no EOF fallback — an honest "marker not found" is correct here
    }
    if (NO_EOF_INSERT_FIELDS.has(field)) continue; // no EOF fallback — see NO_EOF_INSERT_FIELDS comment above
    content = insertBlockMarker(content, markerName);
    inserted.push(markerName);
  }
  return { content, inserted };
}

// Whatever's currently sitting inside a marker, verbatim — used to show an
// implemented draft's real, live content (routes/action-center.js's preview
// for an already-merged draft) without recomputing anything: the marker
// already holds whatever was actually applied, so there's nothing to build
// or diff against, just read what's there.
export function getMarkerContent(fileContent, name) {
  return findMarker(fileContent, name)?.old ?? null;
}

function applyMarker(fileContent, name, newValue) {
  const block = blockRegex(name);
  if (block.test(fileContent)) {
    return fileContent.replace(block, (_m, start, _old, end) => `${start}${newValue}${end}`);
  }
  const line = lineRegex(name);
  const match = line.exec(fileContent);
  if (match) {
    const quote = match[2];
    // Minimal, safe re-escaping for a quoted YAML/JS-style string —
    // backslashes and the matched quote character only.
    const escaped = String(newValue).replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), `\\${quote}`);
    return fileContent.replace(line, (_m, prefix, q, _old, suffix) => `${prefix}${q}${escaped}${q}${suffix}`);
  }
  return fileContent; // caller already confirmed the marker exists via findMarker before calling this
}

// Validates every marker this draft needs is ACTUALLY present in the real
// fetched file content — not just configured in url_file_map, which can
// drift from the live file — before changing anything. A stale/wrong
// config fails honestly here (`missingMarkers`) instead of silently doing
// nothing or writing a corrupted file.
export function spliceMarkers(fileContent, markerMap, values) {
  const missingMarkers = [];
  const changedRegions = [];

  for (const [field, markerName] of Object.entries(markerMap)) {
    if (!(field in values)) continue; // this draft type doesn't set this field
    const found = findMarker(fileContent, markerName);
    if (!found) { missingMarkers.push(markerName); continue; }
    changedRegions.push({ field, markerName, before: found.old, after: values[field] });
  }

  if (missingMarkers.length) return { ok: false, missingMarkers };

  let result = fileContent;
  for (const { markerName, after } of changedRegions) {
    result = applyMarker(result, markerName, after);
  }

  return { ok: true, newContent: result, changedRegions };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Fills a `{{PLACEHOLDER}}` template string with escaped-HTML values — the
// one substitution mechanism shared by every injected content type below.
// Split/join instead of a regex replace so a value that itself happens to
// contain `{{...}}`-shaped text (rare but possible in LLM output) is never
// misinterpreted as another placeholder.
function fillTemplate(template, vars) {
  return Object.entries(vars).reduce((s, [key, value]) => s.split(`{{${key}}}`).join(value), template);
}

// Real HTML for an injected content block is now a per-site config value
// (site.url_file_map.siteRoot.componentTemplates.{faq,expandContent,
// internalLinks} — see types.js), not code. Every tenant's real site has its
// own template/CSS framework/component library; baking any one tenant's
// markup into this shared implementer would inject the WRONG site's styling
// into every OTHER tenant's pages. A site's real template is captured once,
// at onboarding (`npm run connect-repo --url-file-map ...`), the same way
// url_file_map.siteRoot.layoutTemplate/nginxConfig/robotsTxt already are.
//
// `wrapper` is filled once with {{ROWS}} (the joined, already-filled rows);
// `row` is filled once per item with that content type's own fields. Sites
// with no configured template yet fall back to the DEFAULT_* templates
// below — deliberately plain, zero-CSS-assumption markup (the same shape
// this code emitted before per-site templates existed) rather than any
// specific tenant's real styling, so an unconfigured site never gets
// another tenant's component injected into it.
function renderFromTemplate(template, rows) {
  return fillTemplate(template.wrapper, { ROWS: rows.join('\n') });
}

const DEFAULT_FAQ_TEMPLATE = {
  wrapper: '<dl class="faq">\n{{ROWS}}\n</dl>',
  row: '  <dt>{{QUESTION}}</dt>\n  <dd>{{ANSWER}}</dd>',
};

// The JSON-LD itself (content.schemaJsonLd) is already a deterministic
// transform of the same approved items (server/generators/faq.js), reused
// verbatim here rather than re-derived, so there's exactly one source of
// truth for it — only the visible HTML representation varies per site.
function renderFaqHtml(items, template = DEFAULT_FAQ_TEMPLATE) {
  const rows = items.map((qa, i) => fillTemplate(template.row, {
    INDEX: String(i + 1), QUESTION: escapeHtml(qa.question), ANSWER: escapeHtml(qa.answer),
  }));
  return renderFromTemplate(template, rows);

}

const DEFAULT_LINKS_TEMPLATE = {
  wrapper: '<ul class="related-links">\n{{ROWS}}\n</ul>',
  row: '  <li><a href="{{URL}}">{{ANCHOR_TEXT}}</a></li>',
};

// anchorText/targetUrl are escaped since they ultimately come from LLM
// output (already filtered against real candidate URLs at generation time,
// see generators/internal-links.js, but still untrusted as raw HTML).
function renderLinksHtml(suggestions, template = DEFAULT_LINKS_TEMPLATE) {
  const rows = suggestions.map((s) => fillTemplate(template.row, {
    URL: escapeHtml(s.targetUrl), ANCHOR_TEXT: escapeHtml(s.anchorText),
  }));
  return renderFromTemplate(template, rows);
}

const DEFAULT_EXPAND_TEMPLATE = {
  wrapper: '<div>\n{{ROWS}}\n</div>',
  row: '  <h2>{{HEADING}}</h2>\n  <p>{{BODY}}</p>',
};

// Converts the light markdown expand-content's prompts sometimes produce
// (bold/italic emphasis, and — pre-generator-fix — inline links) into real
// HTML instead of leaking literal `**`/`[text](url)` syntax as visible text
// (escapeHtml alone just escapes <>&", it never parses markdown). A link is
// only ever rendered as a real <a> when its href is an actual http(s) URL;
// anything else (a bare "#", empty, or missing href) is deliberately
// downgraded to its plain text — expand-content.js's own prompt no longer
// asks for placeholder citation links, but this is the last line of defense
// against ever publishing a dead anchor to a live site.
function markdownToHtml(text) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
}

// Each section is a real, LLM-grounded heading+body pair (generators/
// expand-content.js). Heading stays plain-escaped (never expected to carry
// markdown); body runs through markdownToHtml since it's free-form prose.
function renderExpandedHtml(sections, template = DEFAULT_EXPAND_TEMPLATE) {
  const rows = sections.map((s) => fillTemplate(template.row, {
    HEADING: escapeHtml(s.heading), BODY: markdownToHtml(s.body),
  }));
  return renderFromTemplate(template, rows);
}

// Turns one APPROVED draft's already-locked content into the literal
// marker values to splice in — the only place that decides "what text goes
// where." Every value here is either already-approved content verbatim
// (meta-title, faq questions/answers, the existing schemaJsonLd transform)
// or a deterministic wrapper around it — never a new LLM call, so preview
// and apply can never diverge from what a human actually approved.
//
// `mode` (see implementers/lib/render-inspector.js's inspectRenderMode and
// implementers/types.js for the full contract — decided by live page
// inspection, not static config) selects which representation
// of the content to splice, for any type that has more than one:
//   'visible' (default) — today's exact original behavior, unchanged.
//   'schema-only' — only the structured-data fragment, for a content type
//     that has one (currently just faq — schema is already schema-only by
//     nature). A content type with no schema fragment (meta-title,
//     internal-links) honestly errors rather than silently no-op'ing —
//     same no-fabrication discipline as agents/ai-visibility.js.
//
// `componentTemplates` is the calling site's
// url_file_map.siteRoot.componentTemplates ({faq,expandContent,
// internalLinks}, each optional) — falls back per-type to the DEFAULT_*
// templates above when a site hasn't configured its own yet.
export function buildMergeValues(actionType, content, mode = 'visible', componentTemplates = {}) {
  if (actionType === 'meta-title') {
    if (mode === 'schema-only') return { ok: false, error: '"meta-title" has no schema-only representation.' };
    if (!content.selectedTitle) {
      return { ok: false, error: 'No title selected yet — pick one of the candidate titles (Draft Preview → "Use this") before this can be applied.' };
    }
    const values = { title: content.selectedTitle };
    if (content.metaDescription) values.metaDescription = content.metaDescription;
    return { ok: true, values };
  }

  if (actionType === 'faq') {
    if (!content.items?.length) return { ok: false, error: 'This FAQ draft has no items.' };
    const visible = renderFaqHtml(content.items, componentTemplates.faq || DEFAULT_FAQ_TEMPLATE);
    const schema = content.schemaJsonLd ? `<script type="application/ld+json">${JSON.stringify(content.schemaJsonLd)}</script>` : null;
    if (mode === 'schema-only') {
      if (!schema) return { ok: false, error: 'This FAQ draft has no schema/JSON-LD data to publish in schema-only mode.' };
      return { ok: true, values: { faq: schema } };
    }
    return { ok: true, values: { faq: schema ? `${visible}\n${schema}` : visible } };
  }

  if (actionType === 'schema') {
    if (!content.jsonLd) return { ok: false, error: 'This schema draft has no JSON-LD to apply.' };
    if (content.placeholderFields?.length) {
      return { ok: false, error: `This schema draft has ${content.placeholderFields.length} unverified placeholder field(s) (${content.placeholderFields.join(', ')}) — the model couldn't confirm these from the real page text. Fill them in manually (edit the draft) before this can be applied.` };
    }
    // Already structured-data-only by nature — every mode produces the same value.
    return { ok: true, values: { schema: `<script type="application/ld+json">${JSON.stringify(content.jsonLd)}</script>` } };
  }

  if (actionType === 'internal-links') {
    if (mode === 'schema-only') return { ok: false, error: '"internal-links" has no schema-only representation.' };
    if (!content.suggestions?.length) return { ok: false, error: 'This internal-links draft has no suggestions to apply.' };
    return { ok: true, values: { links: renderLinksHtml(content.suggestions, componentTemplates.internalLinks || DEFAULT_LINKS_TEMPLATE) } };
  }

  if (actionType === 'canonical') {
    if (mode === 'schema-only') return { ok: false, error: '"canonical" has no schema-only representation.' };
    if (!content.canonicalUrl) return { ok: false, error: 'This canonical draft has no URL.' };
    return { ok: true, values: { canonical: `<link rel="canonical" href="${escapeHtml(content.canonicalUrl)}">` } };
  }

  if (actionType === 'open-graph') {
    if (mode === 'schema-only') return { ok: false, error: '"open-graph" has no schema-only representation.' };
    if (!content.ogTitle) return { ok: false, error: 'This Open Graph draft has no title.' };
    const tags = `<meta property="og:title" content="${escapeHtml(content.ogTitle)}">\n<meta property="og:description" content="${escapeHtml(content.ogDescription || '')}">`;
    return { ok: true, values: { openGraph: tags } };
  }

  if (actionType === 'expand-content') {
    if (mode === 'schema-only') return { ok: false, error: '"expand-content" has no schema-only representation.' };
    if (!content.sections?.length) return { ok: false, error: 'This content-expansion draft has no sections.' };
    return { ok: true, values: { expandedContent: renderExpandedHtml(content.sections, componentTemplates.expandContent || DEFAULT_EXPAND_TEMPLATE) } };
  }

  return { ok: false, error: `No merge strategy for action type "${actionType}".` };
}

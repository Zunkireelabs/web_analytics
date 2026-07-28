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

// Real, deterministic HTML for an FAQ block — matches zunkireelabs-web's own
// hand-built FAQ accordion (Tailwind + Alpine.js, confirmed identical on
// /products/search/ and /products/gaamma/) instead of a generic unstyled
// list, so an injected FAQ looks like a real section of the page rather than
// bolted-on browser-default markup. The JSON-LD itself (content.schemaJsonLd)
// is already a deterministic transform of the same approved items
// (server/generators/faq.js), reused verbatim here rather than re-derived,
// so there's exactly one source of truth for it.
function renderFaqHtml(items) {
  const rows = items.map((qa, i) => {
    const index = i + 1;
    return `        <div class="py-5">
          <button @click="activeIndex = (activeIndex === ${index} && !expandAll) ? null : ${index}" class="w-full flex items-center justify-between text-left group">
            <span class="text-lg font-medium text-gray-900 group-hover:text-blue-600 transition-colors pr-4">${escapeHtml(qa.question)}</span>
            <span class="flex-shrink-0 text-gray-400">
              <svg class="w-5 h-5 transition-transform duration-200" :class="{ 'rotate-45': activeIndex === ${index} || expandAll }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
              </svg>
            </span>
          </button>
          <div x-show="activeIndex === ${index} || expandAll" x-transition:enter="transition ease-out duration-200" x-transition:enter-start="opacity-0 -translate-y-2" x-transition:enter-end="opacity-100 translate-y-0" x-transition:leave="transition ease-in duration-150" x-transition:leave-start="opacity-100 translate-y-0" x-transition:leave-end="opacity-0 -translate-y-2" class="overflow-hidden">
            <p class="pt-4 text-gray-600 leading-relaxed">${escapeHtml(qa.answer)}</p>
          </div>
        </div>`;
  }).join('\n');
  return `<section class="py-12 md:py-20 bg-gray-50">
  <div class="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8">
    <div x-data="{ activeIndex: null, expandAll: false }">
      <div class="flex items-center justify-between mb-6 border-b border-gray-300 pb-4">
        <h3 class="text-2xl md:text-3xl font-normal text-gray-900">Frequently asked questions</h3>
        <button @click="expandAll = !expandAll; activeIndex = expandAll ? 'all' : null" class="text-sm text-blue-600 hover:text-blue-800 transition-colors">
          <span x-text="expandAll ? 'Collapse All' : 'Expand All'"></span>
        </button>
      </div>
      <div class="divide-y divide-gray-200">
${rows}
      </div>
    </div>
  </div>
</section>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Real, deterministic HTML for an internal-links block — anchorText/
// targetUrl are escaped since they ultimately come from LLM output (already
// filtered against real candidate URLs at generation time, see
// generators/internal-links.js, but still untrusted as raw HTML).
function renderLinksHtml(suggestions) {
  const items = suggestions.map((s) =>
    `  <li><a href="${escapeHtml(s.targetUrl)}">${escapeHtml(s.anchorText)}</a></li>`
  ).join('\n');
  return `<ul class="related-links">\n${items}\n</ul>`;
}

// Real, deterministic HTML for a content-expansion block (generators/
// expand-content.js) — each section is a real, LLM-grounded heading+body
// pair, escaped since it's untrusted LLM output same as internal-links'
// anchor text above.
function renderExpandedHtml(sections) {
  const rendered = sections.map((s) =>
    `  <h2>${escapeHtml(s.heading)}</h2>\n  <p>${escapeHtml(s.body)}</p>`
  ).join('\n');
  return `<section class="expanded-content">\n${rendered}\n</section>`;
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
export function buildMergeValues(actionType, content, mode = 'visible') {
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
    const visible = renderFaqHtml(content.items);
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
    return { ok: true, values: { links: renderLinksHtml(content.suggestions) } };
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
    return { ok: true, values: { expandedContent: renderExpandedHtml(content.sections) } };
  }

  return { ok: false, error: `No merge strategy for action type "${actionType}".` };
}

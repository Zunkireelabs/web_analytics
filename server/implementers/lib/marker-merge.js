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

// Real, deterministic HTML for an FAQ block — a plain <dl> so it renders
// sensibly with zero site-specific CSS assumptions. The JSON-LD itself
// (content.schemaJsonLd) is already a deterministic transform of the same
// approved items (server/generators/faq.js), reused verbatim here rather
// than re-derived, so there's exactly one source of truth for it.
function renderFaqHtml(items) {
  const rows = items.map((qa) =>
    `  <dt>${qa.question}</dt>\n  <dd>${qa.answer}</dd>`
  ).join('\n');
  return `<dl class="faq">\n${rows}\n</dl>`;
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

  return { ok: false, error: `No merge strategy for action type "${actionType}".` };
}

import { projectComponentTemplate, projectExpandContentCard, pageUsesCardSections, cx } from '../../design-agent/lib/design-profile.js';
import { classifyPageType } from '../../design-agent/live-analysis/schema.js';
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

import { isJsxFile } from './structural-detect.js';

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

// JSX/TSX's own comment convention — `<!-- -->` is NOT a comment inside JSX
// (JSX has no HTML-comment syntax; that literal text would render as
// visible garbage on the live page), so a `.jsx`/`.tsx` file needs its own
// marker form, `{/* SEOAI:NAME:START */}`, which Babel/React strip like any
// other JS comment. Same start/end capture shape as blockRegex so
// findMarker/applyMarker can treat both conventions uniformly aside from
// the wrapper syntax itself. Written and consumed only by
// structural-detect.js's bootstrap flow and this module — never hand-placed
// by a human, since JSX file structure makes a plain-text instruction less
// obvious to place correctly than the HTML comment form.
function jsxBlockRegex(name) {
  const start = `{/* SEOAI:${name}:START */}`;
  const end = `{/* SEOAI:${name}:END */}`;
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
  const jsx = jsxBlockRegex(name).exec(fileContent);
  if (jsx) return { kind: 'jsx', old: jsx[2] };
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

// Every marker token (LINE or BLOCK/JSX, any name) appearing anywhere in a
// file, regardless of convention — the generic union of lineRegex/blockRegex/
// jsxBlockRegex's marker syntax above, used only to COUNT occurrences rather
// than to capture a value for replacement.
const ANY_MARKER_TOKEN_RE = /#\s*SEOAI:([A-Za-z0-9_-]+)(?::(START|END))?|<!--\s*SEOAI:([A-Za-z0-9_-]+)(?::(START|END))?\s*-->|\{\/\*\s*SEOAI:([A-Za-z0-9_-]+)(?::(START|END))?\s*\*\/\}/g;

// Detects a marker left in a structurally invalid state: a LINE marker
// (title's `field: "value" # SEOAI:NAME` convention) appearing more than
// once, or a BLOCK/JSX marker whose START and END counts don't match (or
// exceed one each) — real content, never just a false-positive substring
// match, since every SEOAI: token this codebase ever writes is unique by
// construction (spliceMarkers/ensureMarkers only ever touch an existing
// marker in place or insert a genuinely missing one).
//
// Exists because of one concrete failure mode: getOrInitBatchBranch
// (github-ops.js) syncs a shared per-day batch branch by merging the site's
// default branch INTO it via GitHub's server-side merge endpoint. A REAL
// same-line conflict (both branches edited the identical line differently)
// correctly comes back 409 and is already handled. But two commits that
// each replaced the SAME marker's line independently — one applied straight
// to main, one applied to the batch branch, starting from the same original
// line — can diff to non-overlapping hunks that git's merge algorithm
// resolves cleanly, KEEPING BOTH lines: a duplicated `title:` key that's
// invalid YAML, breaking every downstream build. Confirmed on
// zunkireelabs-web PR #87 (2026-09-08): two independent meta-title drafts
// (#1287 landed on `main`, #1430 landed on the batch branch) collided this
// way — GitHub's merge returned 201 (no conflict reported), yet the
// resulting front matter had two `title:` lines and broke Eleventy/CI. A
// git-level "clean" merge is therefore not sufficient evidence the sync is
// actually safe; this function is the content-level check that catches what
// git's line-based diff cannot.
export function findMarkerCorruption(fileContent) {
  const lineCounts = new Map();
  const blockCounts = new Map();
  let m;
  ANY_MARKER_TOKEN_RE.lastIndex = 0;
  while ((m = ANY_MARKER_TOKEN_RE.exec(fileContent))) {
    const name = m[1] ?? m[3] ?? m[5];
    const kind = m[2] ?? m[4] ?? m[6]; // 'START' | 'END' | undefined (LINE marker)
    if (!kind) {
      lineCounts.set(name, (lineCounts.get(name) || 0) + 1);
    } else {
      const counts = blockCounts.get(name) || { start: 0, end: 0 };
      counts[kind === 'START' ? 'start' : 'end'] += 1;
      blockCounts.set(name, counts);
    }
  }

  const corrupted = [];
  for (const [name, count] of lineCounts) {
    if (count > 1) corrupted.push(name);
  }
  for (const [name, { start, end }] of blockCounts) {
    if (start > 1 || end > 1 || start !== end) corrupted.push(name);
  }
  return corrupted;
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
// analytics-install has ONE field per PROVIDER, not one shared field, so a
// GA4 draft and a Facebook Pixel draft can both be configured and applied
// without clobbering each other. Before this, both providers wrote to the
// same `analyticsScript` field/marker — spliceMarkers replaces whatever's
// between a marker's START/END on every apply, so approving both drafts
// meant whichever merged second silently overwrote the first one's script,
// leaving only one tracking script actually live despite two "successful"
// PRs. Exported so backend.js's computeMarkerMerge/markerConfigExample can
// build a provider-aware error hint instead of a generic wrong one.
export const ANALYTICS_PROVIDER_FIELDS = { ga4: 'analyticsScriptGa4', 'facebook-pixel': 'analyticsScriptFacebookPixel' };

const HEAD_SCOPED_FIELDS = new Set(['canonical', 'openGraph', ...Object.values(ANALYTICS_PROVIDER_FIELDS)]);
const HEAD_MARKER_NAME = 'HEAD';

// Fields that, when no nested SEOAI:HEAD region can be found or created in
// the page's own file, can fall back to a front-matter LINE value instead —
// the site's shared layout renders it into <head> itself. This is the common
// case on a shared-layout SSG (Eleventy/Hugo/Jekyll/11ty, ...), where <head>
// exists only once, in one shared layout file, never in the individual page
// file a canonical/open-graph draft actually targets — so the nested-HEAD
// convention above can never apply there, the same way meta-title's `title`
// field already relies on a front-matter value the layout reads
// (`{{ title }}`), not an HTML <title> tag spliced into the page file.
// Confirmed real, not hypothetical: chayceproperties.com (Eleventy, one
// shared src/_includes/base.njk) — every page's own file is a body fragment
// with no literal <head>, so canonical/open-graph were fatally blocked on
// every single page until this fallback existed.
//
// Maps the generator's field name to the literal front-matter KEY this
// fallback writes — a new key (not reusing the field name), a real,
// one-time template variable a human wires into the layout once, same
// one-time step the SEOAI:HEAD region itself already is.
//
// open-graph is deliberately NOT here yet: it emits several composite
// values (og:title/description/image, twitter:*) under one field, which
// would need several distinct front-matter keys and matching generator
// changes to support the same way — a real, separate follow-up, not a
// quick addition alongside canonical's single-URL case.
const LINE_HEAD_FALLBACK_KEY = { canonical: 'canonicalUrl' };

// Exposed so callers (backend.js's computeMarkerMerge) can give a more
// specific "marker not found" error for a head-scoped field — pointing at
// the missing HEAD region itself, not just the field's own marker name.
export function isHeadScopedField(field) {
  return HEAD_SCOPED_FIELDS.has(field);
}

// Every field that isn't LINE-convention or HEAD-scoped is a generic
// body-content BLOCK field (faq, schema, internal-links, breadcrumbSchema,
// expandedContent, qaContent, and any future one) — and NONE of them can
// safely assume "wherever the file happens to end" is inside the rendered
// body. A component-based page (React/Next/Astro/.jsx/.tsx) has real markup
// after its last line of source — outside the rendered component tree
// entirely — so a blind EOF auto-insert would "succeed" (marker created, PR
// merges, build passes) while producing a marker that never renders on the
// live page. Same hazard HEAD_SCOPED_FIELDS already guards against for
// <head> tags; this is the body-content equivalent. `ensureMarkers` below
// therefore only auto-inserts a body-scoped marker at EOF on a plain
// Markdown/MDX file (isPlainMarkdownFile — the one shape where EOF really
// is inside the rendered body); everywhere else, real structural detection
// is required — see insertion-engine.js's `resolveInsertion`, which
// `ensureMarkers` here defers to via its caller (backend.js) rather than
// ever guessing an EOF position itself.
//
// Exposed so callers can give a more specific "marker not found" error for
// a body-scoped field — same spirit as isHeadScopedField above.
export function isNoEofInsertField(field) {
  return !LINE_CONVENTION_FIELDS.has(field) && !HEAD_SCOPED_FIELDS.has(field);
}

// Exposed so insertion-engine.js's resolveInsertion can tell a LINE field
// (front-matter value — its own safe, narrow auto-heal path in ensureMarkers
// below, never structural detection) apart from a generic body-scoped BLOCK
// field, the same way isHeadScopedField already lets it distinguish that
// third category.
export function isLineConventionField(field) {
  return LINE_CONVENTION_FIELDS.has(field);
}

// Single source of truth for "will the marker-existence pipeline actually be
// able to create this marker automatically, or is there genuinely no safe
// anchor" — used by BOTH ensureMarkers/insertion-engine.js (the apply-time
// behavior) and audit-url-file-map.js (the diagnostic script), so the two
// can never silently disagree about what counts as a real gap. Before this
// existed, the audit script counted every missing marker equally, even ones
// that self-heal automatically at apply time — inflating its gap count with
// noise and burying the marker gaps that actually need attention.
//
// Returns 'self-heals' (no action needed — either ensureMarkers' own
// LINE/HEAD-nested paths, or real structural detection, will resolve it) or
// a specific 'fatal-*' reason naming the missing anchor. `detectors` (both
// optional) are structural-detect.js's real detection functions —
// `detectBody` (`detectInsertionPoint`) and `detectHead` (`detectHeadRegion`)
// — injected rather than imported directly so this module (already the
// lowest-level, most-imported implementer lib) never needs a static
// dependency on the AST/DOM parsing stack. Omitting them falls back to the
// conservative pre-structural-detection answer (matches this function's
// contract before the universal insertion engine existed) rather than
// silently claiming something self-heals that was never actually checked.
export function classifyMarkerGap(field, filePath, fileContent, detectors = {}) {
  if (LINE_CONVENTION_FIELDS.has(field)) {
    return frontMatterLength(fileContent) != null ? 'self-heals' : 'fatal-no-front-matter';
  }
  if (HEAD_SCOPED_FIELDS.has(field)) {
    const headRegex = isJsxFile(filePath) ? jsxBlockRegex(HEAD_MARKER_NAME) : blockRegex(HEAD_MARKER_NAME);
    if (headRegex.test(fileContent)) return 'self-heals';
    if (detectors.detectHead && detectors.detectHead(fileContent).ok) return 'self-heals';
    // Front-matter fallback (LINE_HEAD_FALLBACK_KEY above) — only reachable
    // once a real <head> is confirmed absent from this file, never preferred
    // over a genuine nested-HEAD region.
    if (LINE_HEAD_FALLBACK_KEY[field] && frontMatterLength(fileContent) != null) return 'self-heals';
    return 'fatal-no-head-region';
  }
  if (isPlainMarkdownFile(filePath)) return 'self-heals';
  if (!detectors.detectBody) return 'fatal-no-safe-anchor';
  return detectors.detectBody(fileContent, filePath).ok ? 'self-heals' : 'fatal-no-safe-anchor';
}

// The one case where EOF genuinely IS inside the rendered body: a pure
// content file with no component wrapper at all — this codebase's own
// newContentTargets convention (blog-outline, direct-answer; see
// frontend.js) uses plain `.md`/`.mdx` files whose entire body is handed to
// a markdown renderer as the article. There's no markup "after the last
// line" the way a .jsx/.tsx/.astro component has — the last line of the
// file IS the end of the rendered article. So for these extensions only,
// the EOF fallback below is safe and isNoEofInsertField's guard doesn't
// apply. Anything else (component templates, unknown extensions) keeps the
// conservative "fail honestly" behavior.
function isPlainMarkdownFile(filePath) {
  return /\.mdx?$/i.test(filePath || '');
}

// Auto-creates a head-scoped field's own empty marker, nested inside the
// site's already-placed SEOAI:HEAD region — never at EOF. Returns null when
// that region doesn't exist yet (an onboarding step the operator hasn't done
// for this template), leaving spliceMarkers' existing "marker not found"
// failure as the honest outcome, same discipline as insertLineMarker's
// null-on-unsafe return below.
//
// `filePath`-aware on both sides: the HEAD region itself may exist in either
// convention (a `.jsx`/`.tsx` file gets one via ensureHeadRegion's own
// isJsxFile check, insertion-engine.js), so this must match whichever form
// is actually present — and the nested marker it creates must match that
// SAME form, never assume HTML-comment. Confirmed real: admizz-web-dev
// (Next.js App Router) shipped a raw `<!-- SEOAI:HEAD:START -->` into
// layout.tsx and broke the build (`Expected '</', got '!'`) — JSX has no
// HTML-comment syntax, so that text is parsed as markup, not a comment.
function insertHeadScopedMarker(fileContent, markerName, filePath) {
  const jsx = isJsxFile(filePath);
  const regex = jsx ? jsxBlockRegex(HEAD_MARKER_NAME) : blockRegex(HEAD_MARKER_NAME);
  const match = regex.exec(fileContent);
  if (!match) return null;
  const [full, start, inner, end] = match;
  const nested = jsx
    ? `{/* SEOAI:${markerName}:START */}{/* SEOAI:${markerName}:END */}`
    : `<!-- SEOAI:${markerName}:START --><!-- SEOAI:${markerName}:END -->`;
  const newInner = `${inner}\n${nested}`;
  return fileContent.slice(0, match.index) + start + newInner + end + fileContent.slice(match.index + full.length);
}

// LINE_HEAD_FALLBACK_KEY's own insertion: adds a brand-new front-matter key
// (never one that already exists — insertLineMarker below only ever
// annotates an EXISTING line, by design, so it can't be reused here) just
// before the closing `---` fence, with an empty placeholder value and the
// field's marker comment already attached. Purely additive to the front
// matter block, so it can never misinterpret or disturb an existing key —
// unlike insertLineMarker's escaping concerns, there is no existing value
// here to preserve. spliceMarkers' normal LINE-marker splice (applyMarker)
// then fills in the real value the same way it fills in `title`'s.
function insertNewFrontMatterField(fileContent, key, markerName) {
  const fmLen = frontMatterLength(fileContent);
  if (fmLen == null) return null;
  const frontMatter = fileContent.slice(0, fmLen);
  const rest = fileContent.slice(fmLen);
  const closing = /^([\s\S]*?)(---\r?\n)$/.exec(frontMatter);
  if (!closing) return null;
  const newFrontMatter = `${closing[1]}${key}: "" # SEOAI:${markerName}\n${closing[2]}`;
  return newFrontMatter + rest;
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
// `filePath`-aware: a .jsx/.tsx file gets the JSX comment convention (see
// jsxBlockRegex above) since `<!-- -->` isn't a real comment in JSX and
// would otherwise render as literal visible text.
function insertBlockMarker(fileContent, markerName, filePath) {
  const sep = fileContent.length > 0 && !fileContent.endsWith('\n') ? '\n' : '';
  const marker = isJsxFile(filePath)
    ? `{/* SEOAI:${markerName}:START */}{/* SEOAI:${markerName}:END */}`
    : `<!-- SEOAI:${markerName}:START --><!-- SEOAI:${markerName}:END -->`;
  return `${fileContent}${sep}${marker}\n`;
}

// Auto-creates any marker referenced in markerMap that isn't already
// present in fileContent, so a draft never has to wait on a human
// hand-placing an empty marker first. Never touches an existing marker
// (hasMarker guard) — only ever adds genuinely missing ones. A LINE marker
// that can't be safely placed (see insertLineMarker) is simply skipped,
// leaving spliceMarkers()'s existing "marker not found" failure as the
// honest fallback for that one field.
export function ensureMarkers(fileContent, markerMap, filePath) {
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
      const fallbackKey = LINE_HEAD_FALLBACK_KEY[field];
      const updated = insertHeadScopedMarker(content, markerName, filePath)
        ?? (fallbackKey ? insertNewFrontMatterField(content, fallbackKey, markerName) : null);
      if (updated) { content = updated; inserted.push(markerName); }
      continue; // no EOF fallback — an honest "marker not found" is correct here
    }
    if (isNoEofInsertField(field) && !isPlainMarkdownFile(filePath)) continue; // no EOF fallback — see isNoEofInsertField's comment above; insertion-engine.js's resolveInsertion handles this case via real structural detection
    content = insertBlockMarker(content, markerName, filePath);
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

// Raw HTML (renderFaqHtml/renderQaHtml/... output below) is not valid JSX
// source — unquoted attributes like `class="faq"`, void elements, and any
// literal `{`/`}` in generated text would all be JS/JSX syntax errors if
// spliced in as literal JSX children. Wrapping it as a single
// dangerouslySetInnerHTML expression is the one form that's simultaneously
// (a) valid JSX regardless of what the HTML inside contains, since it's a
// JS string literal, not parsed markup, and (b) renders the exact same
// visible HTML a non-JSX template would get via a literal splice.
// suppressHydrationWarning is a real, standard React DOM prop (harmless
// even outside Next.js) — without it, a Next.js SSR build can log a
// hydration-mismatch warning here even though the content itself is correct
// and static, because this div's children are set via __html/injected
// after the fact rather than usual JSX-rendered markup.
function jsxSafeWrap(rawHtml) {
  return `<div suppressHydrationWarning dangerouslySetInnerHTML={{ __html: ${JSON.stringify(String(rawHtml))} }} />`;
}

function applyMarker(fileContent, name, newValue) {
  const block = blockRegex(name);
  if (block.test(fileContent)) {
    return fileContent.replace(block, (_m, start, _old, end) => `${start}${newValue}${end}`);
  }
  const jsx = jsxBlockRegex(name);
  if (jsx.test(fileContent)) {
    return fileContent.replace(jsx, (_m, start, _old, end) => `${start}${jsxSafeWrap(newValue)}${end}`);
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
    // A field with a LINE_HEAD_FALLBACK_KEY (currently just `canonical`)
    // carries TWO real representations of the same content — a full HTML
    // tag for the nested-HEAD-region convention, a bare value for the
    // front-matter LINE convention — because buildMergeValues is computed
    // before it's known which convention this file's marker actually ended
    // up using (ensureMarkers/resolveInsertion decide that, at insertion
    // time). `found.kind` (from the SAME findMarker call above, against the
    // SAME already-resolved file) is the one place that answer is already
    // known, so it picks the matching representation here rather than
    // guessing earlier. Every other field's value is still a plain string,
    // unchanged — this only ever applies to values buildMergeValues built as
    // `{block, line}` on purpose.
    let after = values[field];
    if (after && typeof after === 'object' && !Array.isArray(after)) {
      after = found.kind === 'line' ? after.line : after.block;
      if (after == null) { missingMarkers.push(markerName); continue; }
    }
    changedRegions.push({ field, markerName, before: found.old, after });
  }

  if (missingMarkers.length) return { ok: false, missingMarkers };

  let result = fileContent;
  for (const { markerName, after } of changedRegions) {
    result = applyMarker(result, markerName, after);
  }

  return { ok: true, newContent: result, changedRegions };
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Fills a `{{PLACEHOLDER}}` template string with escaped-HTML values — the
// one substitution mechanism shared by every injected content type below.
// Split/join instead of a regex replace so a value that itself happens to
// contain `{{...}}`-shaped text (rare but possible in LLM output) is never
// misinterpreted as another placeholder.
export function fillTemplate(template, vars) {
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
export function renderFromTemplate(template, rows) {
  return fillTemplate(template.wrapper, { ROWS: rows.join('\n') });
}

const DEFAULT_FAQ_TEMPLATE = {
  wrapper: '<dl class="faq">\n{{ROWS}}\n</dl>',
  row: '  <dt>{{QUESTION}}</dt>\n  <dd>{{ANSWER}}</dd>',
};

// A captured componentTemplate carries whatever Tailwind classes the Design
// Agent found literally on the site's real FAQ/Q&A element (design-drift.js).
// Those classes were observed on a specific instance of the component, in a
// specific container — verification only proves each class is LIVE in the
// site's CSS (classExistsInCss), never that it is safe to reuse verbatim on
// arbitrary future content or inside a different container. Two classes of
// captured class break that assumption and are stripped before every render:
//
// A fixed pixel/number height on the element wrapping drafted Q&A text is
// never valid regardless of where it's injected — it was the on-page height
// of whatever question happened to be captured, not a real constraint, and
// clips or overlaps any question/answer of different length. This is the
// defect reported 2026-09-09: site 8862's captured faq/qaContent wrapper
// carried `h-[70px]`, and a longer real question broke out of it.
const FIXED_HEIGHT_CLASS_RE = /^h-(\[[^\]]+\]|\d+)$/;

// Page-level section-container sizing (the site's own FAQ section width,
// centering, and outer padding) is only correct when the component is
// injected as its own full-bleed section, e.g. on a landing page. A blog
// post's FAQ/Q&A block is nested inside the post body's own, already-
// constrained content column — reapplying the site's wider section
// container on top of that stretches/misaligns the block against the
// column around it, which is the same 2026-09-09 defect (site 8862's
// wrapper also carried `max-w-7xl mx-auto px-4 sm:px-6 lg:px-8`). The
// WRAPPER is stripped of these; row-level weight/color still carry over so
// the questions/answers still look like the rest of the site, just flowing
// in the post's own column instead of fighting it for width. Row-level
// font-SIZE gets its own, narrower strip below (BLOG_UNSAFE_HEADING_SIZE_RE)
// — a section-headline-scale heading is exactly as wrong nested in an
// article as a full-bleed section container is.
const BLOG_UNSAFE_WRAPPER_CLASS_RE = /^(container(-\w+)?|max-w-\S+|mx-auto)$/;

// A captured row heading (an FAQ question, e.g.) carries whatever font-size
// utility the source element had — correct when that source was itself a
// section headline (a homepage FAQ block's question IS the section's visual
// anchor), wrong when the same markup is spliced inline into a blog post's
// body copy, where a section-headline-scale heading reads as an oversized,
// out-of-place H1 sitting in the middle of a paragraph flow (2026-09-10:
// site 1's captured componentTemplates.faq/qaContent row carried
// `text-2xl md:text-3xl`, rendering as an H1-sized heading inside every
// blog post it was spliced into). Same reasoning as BLOG_UNSAFE_WRAPPER_CLASS_RE
// above, applied to the row instead of the wrapper — text-3xl and up is
// section-headline scale in virtually every real Tailwind config; text-2xl
// and below is ordinary in-article subheading scale and is left alone.
// Responsive variants (`md:text-3xl`) carry the same prefix.
const BLOG_UNSAFE_HEADING_SIZE_RE = /^(?:[\w-]+:)?text-(3xl|4xl|5xl|6xl|7xl|8xl|9xl)$/;

// Generalized beyond "blog" (2026-09-10): the real question was never
// specifically about /blog/ — it's whether the TARGET page is one where an
// inserted component is a small addition to an established page (an
// article, a legal page, a location/service page, ...) versus a page type
// this site conventionally builds AS a full-bleed section/page (a
// homepage, a landing page, a dedicated FAQ page, a blog LISTING).
// classifyPageType (design-agent/live-analysis/schema.js) is the same
// classifier the rest of the platform already uses for page-type-aware
// guidance (page-templates.js) — reusing it here means a legal page, a
// location page, or any future client's equivalent all get the same
// protection a blog post did, not just URLs containing "/blog/".
// Deliberately NOT 'service'/'location' (or 'homepage'/'landing'/'faq'):
// those page types conventionally have their OWN dedicated, section-scale
// FAQ/CTA block as part of the page's normal design (the 2026-09-09 fix's
// own regression coverage treats a /services/ page's real section sizing as
// correct, not a defect to strip). 'blog-article' and 'legal' are pure prose
// flow with no section-building convention at all; 'other' is genuinely
// unclassified — safest to treat as inline (strip the unsafe classes) than
// to assume unknown page structure can host a full-bleed section.
const INLINE_CONTENT_PAGE_TYPES = new Set(['blog-article', 'legal', 'other']);

function isInlineContentPage(pageUrl) {
  if (typeof pageUrl !== 'string' || !pageUrl) return false;
  return INLINE_CONTENT_PAGE_TYPES.has(classifyPageType(pageUrl));
}

// When the site's OWN design profile has real, live-observed typography for
// a SUBHEADING role on this exact page type (profile.pageTypePatterns —
// same evidence page-templates.js's canonical page templates already draw
// on), that is a strictly better correction than blindly stripping the
// captured template's oversized class down to nothing: it's the real class
// this site already uses for an in-page subheading on THIS page type, not a
// guess. Only 'subheading' counts — 'heading' is the page's own H1/top-level
// anchor, never the right role for an inserted FAQ question or similar.
// Returns null (never invents a class) when the site has no such evidence,
// which is the common case — most sites have no pageTypePatterns at all yet.
function groundedInlineHeadingClass(designProfile, pageUrl) {
  const pageType = typeof pageUrl === 'string' ? classifyPageType(pageUrl) : null;
  const hierarchy = pageType && designProfile?.pageTypePatterns?.[pageType]?.textHierarchy;
  if (!Array.isArray(hierarchy)) return null;
  const entry = hierarchy.find((h) => h?.role === 'subheading' && h.classes);
  return entry ? entry.classes : null;
}

function stripClassesMatching(html, predicate) {
  if (!html) return html;
  return html.replace(/class="([^"]*)"/g, (full, list) => {
    const kept = list.split(/\s+/).filter((c) => c && !predicate(c));
    return kept.length ? `class="${kept.join(' ')}"` : '';
  });
}

// Exported standalone (not just through sanitizeCapturedTemplate below) for
// newpage-render.js's contentWrapper — that one wraps a WHOLE net-new page
// body, not a section nested inside an existing page, so the BLOG_UNSAFE
// container-sizing strip below never applies to it (a page's own top-level
// layout container is correct there by definition); only a fixed height
// is unconditionally wrong on any element holding arbitrary-length body copy.
export function stripFixedHeightClass(html) {
  return stripClassesMatching(html, (c) => FIXED_HEIGHT_CLASS_RE.test(c));
}

// Applied to every captured template right before render — DEFAULT_* templates
// carry no classes at all, so this is a no-op for them. `inline` replaces
// the old blog-only `blog` flag (see isInlineContentPage above);
// `groundedHeadingClass`, when the site's own design profile has real
// evidence for this exact page type, REPLACES the stripped heading-size
// class with the site's own real subheading class instead of leaving the
// row with no size class at all — a grounded correction, not just removal.
export function sanitizeCapturedTemplate(template, { inline = false, groundedHeadingClass = null } = {}) {
  if (!template) return template;
  const strippedRow = stripClassesMatching(stripFixedHeightClass(template.row),
    (c) => inline && BLOG_UNSAFE_HEADING_SIZE_RE.test(c));
  return {
    ...template,
    wrapper: stripClassesMatching(stripFixedHeightClass(template.wrapper),
      (c) => inline && BLOG_UNSAFE_WRAPPER_CLASS_RE.test(c)),
    row: (inline && groundedHeadingClass && strippedRow !== template.row)
      ? strippedRow.replace(/class="([^"]*)"/, (full, list) => `class="${cx(list, groundedHeadingClass)}"`)
      : strippedRow,
  };
}

// The JSON-LD itself (content.schemaJsonLd) is already a deterministic
// transform of the same approved items (server/generators/faq.js), reused
// verbatim here rather than re-derived, so there's exactly one source of
// truth for it — only the visible HTML representation varies per site.
export function renderFaqHtml(items, template = DEFAULT_FAQ_TEMPLATE) {
  const rows = items.map((qa, i) => fillTemplate(template.row, {
    INDEX: String(i + 1), QUESTION: escapeHtml(qa.question), ANSWER: escapeHtml(qa.answer),
  }));
  return renderFromTemplate(template, rows);

}

// Deliberately NOT DEFAULT_FAQ_TEMPLATE's <dl>/<dt>/<dd> shape, even though
// this reuses the same accordion styling intent — a <dt> is not a heading
// tag, so content rendered that way would never satisfy the real
// "question-style heading" check (page-content.js's questionHeadingCount:
// h1/h2/h3 whose text ends in "?") that this generator exists to fix,
// regardless of how it looks. <details>/<summary> is a native, always-
// reasonably-styled disclosure widget (unlike the retired qa-subheadings
// bug's bare <h2> dumped in body text — see ai-visibility.js's retirement
// note), so it never ships looking broken even with zero site-specific CSS,
// while still nesting a real <h3> so the check the audit runs actually
// passes. A site can still capture componentTemplates.qaContent later for
// exact visual parity with its own accordion, same as faq/expand-content
// support — this default just never requires that onboarding step first.
const DEFAULT_QA_TEMPLATE = {
  wrapper: '<div class="qa-content">\n{{ROWS}}\n</div>',
  row: '  <details>\n    <summary><h3>{{QUESTION}}</h3></summary>\n    <p>{{ANSWER}}</p>\n  </details>',
};

// A site that captured its real FAQ accordion but never captured a separate
// qaContent template should get its OWN accordion for Q&A content too, not
// the generic default above. To a reader these are the same component, and
// letting one page render the site's real accordion while another renders a
// bare <details> block is exactly the "the FAQ on this page doesn't look like
// the FAQ on the other pages" inconsistency reported on site 1 (/team/ and
// blog posts against / and /resources/). componentTemplates.qaContent still
// wins outright when a site really has captured a distinct one.
//
// Gated on the captured row carrying a real h1/h2/h3, because qa-content
// exists to satisfy questionHeadingCount (page-content.js counts h1/h2/h3
// whose text ends in "?"). Borrowing an faq template built on <dt> or <span>
// would look right and silently fail the very check the draft was queued to
// fix — the same trap DEFAULT_QA_TEMPLATE's own comment describes.
export function faqTemplateUsableForQa(faqTemplate) {
  if (!faqTemplate?.row) return null;
  return /<h[123][\s>]/i.test(faqTemplate.row) ? faqTemplate : null;
}

// INDEX mirrors renderFaqHtml's own fill exactly — a captured qaContent
// template is real site markup that may reuse the same interactive
// accordion pattern as componentTemplates.faq (activeIndex-keyed toggle
// state, e.g. Alpine's `x-show="activeIndex === {{INDEX}}"`), so this must
// substitute the same placeholder faq's own row template does. Harmless
// no-op for a plain DEFAULT_QA_TEMPLATE/static template with no {{INDEX}}
// token — fillTemplate only replaces tokens that are actually present.
export function renderQaHtml(items, template = DEFAULT_QA_TEMPLATE) {
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
export function renderLinksHtml(suggestions, template = DEFAULT_LINKS_TEMPLATE) {
  const rows = suggestions.map((s) => fillTemplate(template.row, {
    URL: escapeHtml(s.targetUrl), ANCHOR_TEXT: escapeHtml(s.anchorText),
  }));
  return renderFromTemplate(template, rows);
}

const DEFAULT_EXPAND_TEMPLATE = {
  wrapper: '<div>\n{{ROWS}}\n</div>',
  // No <p> wrapper here: markdownToHtml already wraps every block it emits
  // (prose in <p>, "- " lists in <ul>) itself, since a body can legally
  // contain both — a fixed outer <p> would nest a <ul> inside a <p>, which
  // is invalid HTML that browsers recover from by force-closing the <p>
  // early, silently dropping/misplacing whatever body text came after the
  // list (see the marker-merge.test.js regression for a live example).
  row: '  <h2>{{HEADING}}</h2>\n  {{BODY}}',
};

// Converts the light markdown expand-content's prompts sometimes produce
// (bold/italic emphasis, inline links, and — the external-citations focus's
// natural way of listing several sources — a "- item" bullet list) into real
// HTML instead of leaking literal `**`/`[text](url)`/`- ` syntax as visible
// text (escapeHtml alone just escapes <>&", it never parses markdown). A
// link is only ever rendered as a real <a> when its href is an actual
// http(s) URL; anything else (a bare "#", empty, or missing href) is
// deliberately downgraded to its plain text — expand-content.js's own
// prompt no longer asks for placeholder citation links, but this is the
// last line of defense against ever publishing a dead anchor to a live
// site.
function markdownInline(text) {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
}

// A GFM-style pipe-table row: at least one `|` with real content around it
// (excludes a stray line that merely contains a literal "|" in prose).
const TABLE_ROW_RE = /^\s*\|?.*\|.*\|?\s*$/;
// The required separator row directly under a table's header, e.g.
// `|---|:--:|--:|` — this is what actually distinguishes a real table from
// prose that happens to contain pipe characters.
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

// Splits one pipe-delimited row into trimmed cells, dropping the empty
// leading/trailing entries a row's optional outer `|` produces.
function splitTableRow(line) {
  const cells = line.trim().split('|').map((c) => c.trim());
  if (cells.length && cells[0] === '') cells.shift();
  if (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

// generators/expand-content.js's SYSTEM_COMPARISON focus explicitly asks the
// LLM for "a comparison table structure", and it reliably answers with GFM
// pipe-table syntax in the body's free-form prose — this function's only
// caller runs on exactly that kind of text. Without this, a table's `|`/`-`
// syntax matched none of the bullet/paragraph branches below, so it fell
// through to the plain-paragraph case and shipped as one long line of
// literal pipes and dashes straight to a live page (confirmed live:
// zunkireelabs.com/locations/kathmandu/, PR #64 on zunkireelabs-web).
// `style` is the SAME per-tenant table convention renderComparisonTable
// below already applies (componentTemplates.table, captured from a real
// table in the tenant's own repo). Without it, a comparison table the model
// happened to write as MARKDOWN shipped as a bare, class-less <table> —
// no borders, no padding, no header contrast — sitting directly beside a
// STRUCTURED table on the same page that did carry the site's real classes.
// On a Tailwind site that is a visibly foreign block, and it reached live
// pages autonomously: the styling was threaded to the structured path and
// silently not to this one, even though the same prompt produces both
// shapes interchangeably.
function markdownTable(lines, startIndex, style = {}) {
  const header = splitTableRow(lines[startIndex]);
  const rows = [];
  let i = startIndex + 2; // skip the header row and its separator row
  while (i < lines.length && TABLE_ROW_RE.test(lines[i]) && !TABLE_SEPARATOR_RE.test(lines[i])) {
    rows.push(splitTableRow(lines[i]));
    i++;
  }
  const th = header.map((c) => `<th${attrIf(style.th)}>${markdownInline(c)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c, idx) => (
    `<td${attrIf(idx === 0 ? (style.tdFirst || style.td) : style.td)}>${markdownInline(c)}</td>`
  )).join('')}</tr>`).join('');
  const html = `<table${attrIf(style.table)}><thead${attrIf(style.thead)}><tr>${th}</tr></thead>`
    + `<tbody${attrIf(style.tbody)}>${body}</tbody></table>`;
  return { html: style.wrapper ? `<div class="${style.wrapper}">${html}</div>` : html, nextIndex: i };
}

// A table whose row breaks were lost, arriving as ONE line:
// `| Feature | A | B | |---|---|---| | Row | x | y |`. The line-based
// detection above cannot see it — there is no next line to test for a
// separator row — so it fell through to the plain-paragraph branch and
// shipped as literal pipes and dashes on a live page, exactly the failure
// markdownTable itself was added to stop (see its comment above).
//
// The only place two pipes appear with nothing but spaces/tabs between them
// in a well-formed pipe table is a row boundary: the previous row's closing
// pipe followed by the next row's opening pipe (an interior cell separator
// always has real content on at least one side). Newlines are deliberately
// NOT matched, so an already-correct multi-line table is never touched.
const COLLAPSED_TABLE_LINE_RE = /\|[ \t]*:?-{2,}/;
const ROW_BOUNDARY_RE = /\|([ \t]+)\|/g;

function reflowCollapsedTableRows(line) {
  // Only a line carrying a separator run INSIDE it is treated as collapsed.
  // A normal single row with an empty middle cell ("| A |  | C |") also has
  // two pipes separated by spaces, and must never be split on that alone.
  if (!COLLAPSED_TABLE_LINE_RE.test(line)) return [line];
  return line.replace(ROW_BOUNDARY_RE, '|\n|').split('\n');
}

// generators/expand-content.js's SYSTEM_COMPARISON prompt asks for "a
// comparison table structure" without dictating a format, so the model's
// answer isn't consistently GFM markdown (handled by the table parser
// below) — it sometimes writes the table as literal HTML instead. Passed
// through the escape-everything path below, that real markup got neutered
// into visible `&lt;table class=...&gt;` text on a live page (confirmed:
// zunkireelabs.com/locations/, PR #64 on zunkireelabs-web). This is trusted
// content from this platform's own generation pipeline, not untrusted user
// input, so a body that already opens with a real HTML block tag is used
// verbatim instead of being escaped and reparsed as prose.
const HTML_BLOCK_RE = /^\s*<(table|div|section|ul|ol)\b/i;

function markdownToHtml(text, tableStyle = {}) {
  if (HTML_BLOCK_RE.test(text)) return text.trim();
  const escaped = escapeHtml(text);
  const parts = [];
  let listItems = [];
  let textLines = [];
  const flushText = () => {
    if (textLines.length) {
      parts.push(`<p>${textLines.map((line) => markdownInline(line)).join('\n')}</p>`);
      textLines = [];
    }
  };
  const flushList = () => {
    if (listItems.length) {
      parts.push(`<ul>${listItems.map((item) => `<li>${markdownInline(item)}</li>`).join('')}</ul>`);
      listItems = [];
    }
  };
  // Split on real newlines first, then restore the row breaks of any table
  // that arrived collapsed onto one line (reflowCollapsedTableRows) — after
  // this, both shapes look identical to the line-based detection below.
  const lines = escaped.split('\n').flatMap(reflowCollapsedTableRows);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const bullet = /^-\s+(.*)$/.exec(line);
    if (TABLE_ROW_RE.test(line) && TABLE_SEPARATOR_RE.test(lines[i + 1] || '')) {
      flushText();
      flushList();
      const { html, nextIndex } = markdownTable(lines, i, tableStyle);
      parts.push(html);
      i = nextIndex - 1; // for-loop's own i++ advances past the last consumed row
    } else if (bullet) {
      flushText();
      listItems.push(bullet[1]);
    } else {
      flushList();
      textLines.push(line);
    }
  }
  flushText();
  flushList();
  return parts.join('\n');
}

// column key ("zunkiree_labs", "serviceArea") -> a real header label
// ("Zunkiree Labs", "Service Area"), for a comparison table whose columns
// are whatever keys the model chose (see renderComparisonTable below).
function toTitleCase(key) {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// generators/expand-content.js's comparison-content focus can attach a
// structured "table" alongside a section's body — an array of plain
// {column: value} rows, every row sharing the first row's key set (its
// generation-time sanitizer, sanitizeTable, already enforces this shape and
// caps its size — this only re-derives columns from row[0] defensively).
// Rendered with OUR OWN escaped markup, never whatever HTML/CSS a model
// might invent for the same data (that's exactly the class of bug
// markdownToHtml's HTML_BLOCK_RE passthrough exists to contain elsewhere,
// not extend here) — column labels are Title Cased from the row keys so
// "zunkiree_labs" reads as "Zunkiree Labs" rather than leaking the raw
// field name. Returns '' (not a stray empty <table>) for anything
// malformed, so a caller can always safely concatenate this after body
// prose.
// `style` is the site's own table convention, stored per tenant as
// componentTemplates.table (a class map, captured from a real table in the
// tenant's repo — see scripts/capture-component-template.js). Without it this
// emitted a bare <table> with no classes at all, which on a Tailwind site
// means no borders, no padding, no header contrast: a generated comparison
// table was visibly not part of the page it sat on. Every slot falls back to
// '' so a site with no captured table renders exactly the bare markup it did
// before, rather than borrowing another tenant's look.
function attrIf(cls) {
  return cls ? ` class="${cls}"` : '';
}

function renderComparisonTable(table, style = {}) {
  if (!Array.isArray(table) || !table.length) return '';
  const columns = Object.keys(table[0]);
  if (!columns.length) return '';
  const th = columns.map((c) => `<th${attrIf(style.th)}>${escapeHtml(toTitleCase(c))}</th>`).join('');
  const body = table.map((row) => `<tr>${columns.map((c, i) => (
    // The first column is the row label on every comparison table this renders,
    // and the site's own tables give it more weight than the values beside it.
    `<td${attrIf(i === 0 ? (style.tdFirst || style.td) : style.td)}>${escapeHtml(String(row?.[c] ?? ''))}</td>`
  )).join('')}</tr>`).join('');
  const html = `<table${attrIf(style.table)}><thead${attrIf(style.thead)}><tr>${th}</tr></thead>`
    + `<tbody${attrIf(style.tbody)}>${body}</tbody></table>`;
  // The wrapper carries the border/rounding on the sites that use one, and
  // keeps a wide table scrollable instead of overflowing its column.
  return style.wrapper ? `<div class="${style.wrapper}">${html}</div>` : html;
}

// Each section is a real, LLM-grounded heading+body pair (generators/
// expand-content.js). Heading stays plain-escaped (never expected to carry
// markdown); body runs through markdownToHtml since it's free-form prose.
// An optional structured table (see renderComparisonTable) renders as a
// sibling block right after the body — never nested inside body's own <p>,
// same "block content is never trapped in a <p>" rule markdownToHtml's own
// list/table handling already follows.
// A site's captured template can put {{BODY}} inside a <p>, because the real
// example it was captured from is one paragraph of prose. A generated body is
// not: markdownToHtml emits <p>/<ul>/<table> blocks, and renderComparisonTable
// appends a <div><table>. A <table> inside a <p> is invalid HTML, and browsers
// "fix" it by closing the <p> early — which strands the table OUTSIDE the
// styled wrapper it was supposed to be in, on the live page, silently.
//
// Swapping the slot's <p> for a <div> keeps the same class and the same visual
// result while being valid either way. Only done when the body actually
// contains a block element, so a one-paragraph body still renders as the
// site's own example did.
const BLOCK_LEVEL = /<(table|ul|ol|div|h[1-6]|blockquote|pre|figure|section|p)[\s>]/i;

function blockSafeRow(rowTemplate, body, slot) {
  if (!BLOCK_LEVEL.test(body)) return rowTemplate;
  const re = new RegExp(`<p(\\s[^>]*)?>(\\s*\\{\\{${slot}\\}\\}\\s*)</p>`);
  return rowTemplate.replace(re, (m, attrs, inner) => `<div${attrs || ''}>${inner}</div>`);
}

export function renderExpandedHtml(sections, template = DEFAULT_EXPAND_TEMPLATE, tableStyle = {}) {
  const rows = sections.map((s) => {
    const body = markdownToHtml(s.body, tableStyle) + renderComparisonTable(s.table, tableStyle);
    return fillTemplate(blockSafeRow(template.row, body, 'BODY'), {
      HEADING: escapeHtml(s.heading), BODY: body,
    });
  });
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
// internalLinks,qaContent}, each optional).
//
// `designProfile` (optional) is the site's whole design language
// (design-agent/lib/design-profile.js). When a specific template is absent,
// a projection from that profile is used BEFORE any DEFAULT_* fallback —
// that ordering is the point. The DEFAULT_* templates are generic markup
// invented here, so two generators falling back to them on the same site
// present content in two different visual languages, neither of which is the
// site's. A projection is the site's own typography, spacing and component
// conventions. DEFAULT_* now only applies to a site with no design knowledge
// at all.
export function buildMergeValues(actionType, content, mode = 'visible', componentTemplates = {}, designProfile = null, { suppressSchema = false, page = null } = {}) {
  // Resolved per call rather than precomputed: only the branch that actually
  // renders visible HTML for this action type ever needs one.
  // sanitizeCapturedTemplate runs here, once, for every actionType that
  // resolves a componentTemplate — not just faq/qa-content — so a bug like
  // 2026-09-09's (one site's Design Agent capture stamping `h-[70px]` onto
  // EVERY component wrapper: faq, qaContent, expandContent, internalLinks,
  // contentWrapper alike) can't ship on any of them, present or future.
  const inline = isInlineContentPage(page);
  const groundedHeadingClass = inline ? groundedInlineHeadingClass(designProfile, page) : null;
  const templateFor = (actionType_, configured, fallback) => sanitizeCapturedTemplate(
    configured
    || (designProfile ? projectComponentTemplate(designProfile, actionType_) : null)
    || fallback,
    { inline, groundedHeadingClass },
  );

  // expand-content only: a page whose OWN sections are built from the site's
  // card component (a portfolio/case-study grid — see
  // pageUsesCardSections/projectExpandContentCard) gets the card-wrapped
  // variant instead of the plain heading+paragraph row every other page uses.
  // `componentTemplates.expandContentCard` is a captured/verified override,
  // same precedence as every other slot here; falls through to a live
  // projection, then to the plain template exactly as before for a page (or
  // site) with no card evidence — never invents a card look.
  const expandContentTemplate = () => {
    if (page && pageUsesCardSections(designProfile, page)) {
      const chosen = componentTemplates.expandContentCard
        || (designProfile ? projectExpandContentCard(designProfile) : null);
      if (chosen) return sanitizeCapturedTemplate(chosen, { inline, groundedHeadingClass });
    }
    return templateFor('expand-content', componentTemplates.expandContent, DEFAULT_EXPAND_TEMPLATE);
  };
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
    const visible = renderFaqHtml(content.items, templateFor('faq', componentTemplates.faq, DEFAULT_FAQ_TEMPLATE));
    // suppressSchema: the page already carries an FAQPage schema from the
    // OTHER FAQ/Q&A slot (qa-content) — see backend.js's hasExistingFaqSchema
    // check. 'faq' and 'qa-content' are independent marker fields, so
    // marker-merge's splice never overwrites one with the other; without
    // this, a page can end up with two separate FAQPage JSON-LD blocks.
    const schema = (!suppressSchema && content.schemaJsonLd) ? `<script type="application/ld+json">${JSON.stringify(content.schemaJsonLd)}</script>` : null;
    if (mode === 'schema-only') {
      if (!schema) {
        return { ok: false, error: suppressSchema
          ? 'This page already has an FAQPage schema from another FAQ/Q&A draft — nothing left to publish in schema-only mode.'
          : 'This FAQ draft has no schema/JSON-LD data to publish in schema-only mode.' };
      }
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

  if (actionType === 'breadcrumbs') {
    if (mode === 'schema-only') return { ok: false, error: '"breadcrumbs" has no schema-only representation — it is already schema-only by nature.' };
    if (!content.jsonLd) return { ok: false, error: 'This breadcrumbs draft has no JSON-LD to apply.' };
    // Its own field, distinct from 'schema' — a page can have real Article/
    // Product/etc. schema (schema.js) AND a BreadcrumbList at the same time,
    // and marker-merge's splice is a wholesale replace, not an append (see
    // spliceMarkers below), so sharing one field/marker would mean whichever
    // of schema.js/breadcrumbs.js applies second silently destroys the
    // other's JSON-LD. Same reasoning faq.js's schemaJsonLd already gets its
    // own 'faq' field instead of also using 'schema'.
    return { ok: true, values: { breadcrumbSchema: `<script type="application/ld+json">${JSON.stringify(content.jsonLd)}</script>` } };
  }

  if (actionType === 'internal-links') {
    if (mode === 'schema-only') return { ok: false, error: '"internal-links" has no schema-only representation.' };
    if (!content.suggestions?.length) return { ok: false, error: 'This internal-links draft has no suggestions to apply.' };
    return { ok: true, values: { links: renderLinksHtml(content.suggestions, templateFor('internal-links', componentTemplates.internalLinks, DEFAULT_LINKS_TEMPLATE)) } };
  }

  if (actionType === 'canonical') {
    if (mode === 'schema-only') return { ok: false, error: '"canonical" has no schema-only representation.' };
    if (!content.canonicalUrl) return { ok: false, error: 'This canonical draft has no URL.' };
    // Object-shaped, not a plain string — see LINE_HEAD_FALLBACK_KEY and
    // spliceMarkers' own comment above for why: this same draft can land
    // either as a nested-HEAD-region <link> tag or a front-matter value,
    // and which one wins isn't known yet at this point in the pipeline.
    return {
      ok: true,
      values: {
        canonical: {
          block: `<link rel="canonical" href="${escapeHtml(content.canonicalUrl)}">`,
          line: content.canonicalUrl,
        },
      },
    };
  }

  if (actionType === 'open-graph') {
    if (mode === 'schema-only') return { ok: false, error: '"open-graph" has no schema-only representation.' };
    if (!content.ogTitle) return { ok: false, error: 'This Open Graph draft has no title.' };
    if (content.placeholderFields?.length) {
      return { ok: false, error: `This Open Graph draft has ${content.placeholderFields.length} unverified placeholder field(s) (${content.placeholderFields.join(', ')}) — the page had no real title/description to draft from. Fill them in manually (edit the draft) before this can be applied.` };
    }
    const tags = [
      `<meta property="og:title" content="${escapeHtml(content.ogTitle)}">`,
      `<meta property="og:description" content="${escapeHtml(content.ogDescription || '')}">`,
      // Twitter Card tags — deterministic mirror of the same real og:title/
      // description (see generators/open-graph.js), under the SAME
      // 'openGraph' field/marker rather than a new one: one generator, one
      // draft, one PR already covers both, so there's no coexistence
      // conflict the way schema.js/breadcrumbs.js has (nothing else ever
      // writes into this same marker).
      `<meta name="twitter:card" content="${escapeHtml(content.twitterCard || 'summary_large_image')}">`,
      `<meta name="twitter:title" content="${escapeHtml(content.twitterTitle || content.ogTitle)}">`,
      `<meta name="twitter:description" content="${escapeHtml(content.twitterDescription || content.ogDescription || '')}">`,
    ].join('\n');
    return { ok: true, values: { openGraph: tags } };
  }

  if (actionType === 'expand-content' || actionType === 'refresh-content') {
    if (mode === 'schema-only') return { ok: false, error: `"${actionType}" has no schema-only representation.` };
    if (!content.sections?.length) return { ok: false, error: `This ${actionType === 'refresh-content' ? 'content-refresh' : 'content-expansion'} draft has no sections.` };
    // refresh-content deliberately shares expand-content's real, per-site
    // 'expandedContent' marker/template — see refresh-content.js's own
    // comment: a second marker would need every onboarded site re-onboarded
    // before this could ever ship.
    return {
      ok: true,
      values: {
        expandedContent: renderExpandedHtml(
          content.sections,
          expandContentTemplate(),
          componentTemplates.table || {},
        ),
      },
    };
  }

  if (actionType === 'qa-content') {
    if (!content.items?.length) return { ok: false, error: 'This Q&A draft has no items.' };
    const visible = renderQaHtml(content.items, templateFor(
      'qa-content',
      // The site's own captured FAQ accordion stands in when it has no
      // distinct qaContent template — see faqTemplateUsableForQa. Ordered
      // ahead of the design-profile projection inside templateFor because a
      // real captured component is closer to the site than a projection of
      // it, and far closer than DEFAULT_QA_TEMPLATE.
      componentTemplates.qaContent || faqTemplateUsableForQa(componentTemplates.faq),
      DEFAULT_QA_TEMPLATE,
    ));
    // suppressSchema: mirror of 'faq' above — avoids a second FAQPage schema
    // when the 'faq' slot already published one for this same page.
    const schema = (!suppressSchema && content.schemaJsonLd) ? `<script type="application/ld+json">${JSON.stringify(content.schemaJsonLd)}</script>` : null;
    if (mode === 'schema-only') {
      if (!schema) {
        return { ok: false, error: suppressSchema
          ? 'This page already has an FAQPage schema from another FAQ/Q&A draft — nothing left to publish in schema-only mode.'
          : 'This Q&A draft has no schema/JSON-LD data to publish in schema-only mode.' };
      }
      return { ok: true, values: { qaContent: schema } };
    }
    return { ok: true, values: { qaContent: schema ? `${visible}\n${schema}` : visible } };
  }

  if (actionType === 'analytics-install') {
    if (mode === 'schema-only') return { ok: false, error: '"analytics-install" has no schema-only representation.' };
    if (!content.script) return { ok: false, error: 'This analytics-install draft has no script.' };
    if (content.placeholderFields?.length) {
      return { ok: false, error: `This analytics-install draft has ${content.placeholderFields.length} unverified placeholder field(s) (${content.placeholderFields.join(', ')}) — the site's real tracking ID wasn't given. Fill it in manually (edit the draft) before this can be applied.` };
    }
    const field = ANALYTICS_PROVIDER_FIELDS[content.provider];
    if (!field) return { ok: false, error: `Unknown analytics-install provider "${content.provider}" — no marker field mapped for it.` };
    return { ok: true, values: { [field]: content.script } };
  }

  return { ok: false, error: `No merge strategy for action type "${actionType}".` };
}

// Minimal, non-real content sufficient to reach each actionType's OWN
// values-object construction inside buildMergeValues above — never written
// anywhere, never treated as real content, exists only so
// deriveMergeValueKey (below) can ask the real merge-strategy switch what
// field name it uses for a generatorId, instead of maintaining a second,
// hand-copied list that inevitably drifts out of sync with this one (the
// real incident: 25 of 28 registered generatorIds — including "schema" on
// /compare/* routes — were simply missing from that list, so template
// capability repair refused to derive an otherwise-derivable adapter field
// purely because nobody had remembered to add an entry for them).
// actionTypes absent from this table (meta-title, analytics-install, and
// every non-marker-merge generator) are deliberately not probed: they either
// return more than one field (meta-title) or a provider-dependent field
// (analytics-install), so there is no single value key to derive — callers
// must treat that as "cannot safely derive," never guess one.
const PROBE_CONTENT_BY_ACTION_TYPE = {
  faq: { items: [{ question: 'q', answer: 'a' }] },
  schema: { jsonLd: { '@type': 'Thing' } },
  breadcrumbs: { jsonLd: { '@type': 'BreadcrumbList' } },
  'internal-links': { suggestions: [{ url: '/x', anchorText: 'x' }] },
  canonical: { canonicalUrl: 'https://example.invalid/x' },
  'open-graph': { ogTitle: 'x' },
  'expand-content': { sections: [{ heading: 'h', body: 'b' }] },
  'refresh-content': { sections: [{ heading: 'h', body: 'b' }] },
  'qa-content': { items: [{ question: 'q', answer: 'a' }] },
};

// The single field name buildMergeValues uses for `actionType`'s rendered
// value — derived by actually running the real merge switch above against
// minimal probe content, not a second, independently-maintained mapping.
// Returns null when `actionType` has no single-field shape to derive from
// (multi-field, provider-dependent, or not a marker-merge action type at
// all) — callers must treat null as "cannot safely derive," never fall back
// to a guess.
const mergeValueKeyCache = new Map();
export function deriveMergeValueKey(actionType) {
  if (mergeValueKeyCache.has(actionType)) return mergeValueKeyCache.get(actionType);
  const probe = PROBE_CONTENT_BY_ACTION_TYPE[actionType];
  let key = null;
  if (probe) {
    const result = buildMergeValues(actionType, probe, 'visible', {}, null);
    const keys = result.ok ? Object.keys(result.values) : [];
    if (keys.length === 1) key = keys[0];
  }
  mergeValueKeyCache.set(actionType, key);
  return key;
}

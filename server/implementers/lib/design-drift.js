import { createHash } from 'crypto';
import { safeMessage } from '../../lib/errors.js';
import { updateSiteRepoConfig } from '../../db.js';
import { recordAuditEvent } from '../../store/admin/audit-log.js';
import { recordDesignIntegrityVerdict } from '../../store/design-integrity-verdicts.js';
import { recordFixOutcome } from '../../agent-memory.js';
import { FRONTEND_ACTION_TYPES } from '../frontend.js';
import { createComponentTemplateJob, getQueuedComponentTemplateJob, createDesignProfileJob, getLatestDesignAgentJob, getDesignAgentJobById, DESIGN_PROFILE_JOB_KEY } from '../../store/execution-jobs.js';
import { getSiteById } from '../../store/read.js';
import {
  projectAllComponentTemplates, projectComponentTemplate, stampDesignProfile,
  isProfileUsable, isProjectable,
} from '../../design-agent/lib/design-profile.js';

// The generatorId every componentTemplate-derivation lesson (see
// recordRejectedTemplateLesson below) is filed under in agent_fix_memory —
// previously defined in the now-removed openhands-handler.js (the
// Docker/OpenHands capability-repair path, replaced 2026-08-26 by
// native-repair-handler.js), but this constant itself was never
// OpenHands-specific, just co-located with it — moved here, its one real
// consumer, rather than into a shared file for a single string.
const DESIGN_AGENT_GENERATOR_ID = 'design-agent-component-templates';

// componentTemplates (marker-merge.js) are a one-time, hand-captured
// snapshot of a site's REAL design — real Tailwind classes copied out of the
// live site at config time. Nothing keeps that snapshot in sync with the
// site's own design changing later: if the site redesigns and the classes
// baked into the stored template stop being generated at all (Tailwind only
// ships CSS for classes it can see referenced somewhere at build time), the
// stored template still LOOKS correct (same class names in the HTML) but
// renders with zero actual styling — exactly the "looks bigger/different
// than the rest of the site" failure this module exists to catch before it
// ships, not after a human notices it live.
//
// Only action types with a real componentTemplates entry can go stale this
// way — meta-title/schema/canonical/open-graph are plain values with no CSS
// component to drift. Net-new content (blog-outline/landing-page/translation/
// direct-answer and the compliance pages, frontend.js) was once assumed to be
// "always current by construction" because it lands in the site's own layout
// template; that is only true of the layout CHROME. The body itself gets no
// typography from the layout unless the site's real prose wrapper is applied
// to it, which is what componentTemplates.contentWrapper supplies — so these
// are gated like any other rendered component. qa-content is deliberately excluded even though
// it has a componentTemplates entry: its DEFAULT_QA_TEMPLATE (marker-merge.js)
// uses a native <details>/<summary> element with no site-specific classes at
// all when unconfigured, so there's nothing that can go stale until a site
// actually opts into a custom qaContent template — see checkTemplateFreshness's
// own early-return for a template with zero literal classes.
export const COMPONENT_TEMPLATE_KEY = {
  faq: 'faq',
  'expand-content': 'expandContent',
  'internal-links': 'internalLinks',
  'qa-content': 'qaContent',
  // Net-new whole-page markdown content — every frontend.js action type
  // (terms/privacy/cookie-policy, landing-page, blog-outline, direct-answer,
  // translation; see newpage-render.js) — has no repeating-item
  // "rows" the way faq/expand-content/internal-links do, just a single
  // {{BODY}} slot — same per-site, Design-Agent-derived template mechanism,
  // one entry, no `row` placeholder requirement (see REQUIRED_PLACEHOLDERS
  // and validatePlaceholders below).
  'content-wrapper': 'contentWrapper',
};

// Bounded so a stalled/hanging origin can't wedge a draft-generation request
// (or the unattended auto-remediation loop) indefinitely — every caller here
// already treats null as "couldn't check," and a timeout is exactly that: an
// infra failure, not evidence the template is bad. Callers fail OPEN on null
// (see checkTemplateFreshness's contract below), so a slow site degrades to
// "unverified freshness" rather than to a wrong verdict.
const FETCH_TIMEOUT_MS = Number(process.env.DESIGN_DRIFT_FETCH_TIMEOUT_MS || 10000);

// Exported so callers that check SEVERAL templates for one site (see
// agents/lib/template-repair.js) can wrap it in their own memo and fetch the
// page and its stylesheets once for all of them, rather than once per
// template — every component template on a site links the same CSS bundle,
// so re-fetching per key costs five round trips for one answer.
export async function fetchText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function resolveUrl(base, href) {
  try { return new URL(href, base).href; } catch { return href; }
}

// Real class names literally present in a template's `class="..."` attributes
// — the only thing checked against the live CSS. Deliberately does NOT parse
// Alpine's `:class="{ 'x': expr }"` conditional bindings (e.g. the FAQ
// accordion's chevron rotation) — those are a minor visual embellishment,
// not the structural styling (typography/spacing/layout) that actually
// causes the "looks mismatched" failure this exists to catch, and reliably
// parsing arbitrary JS-object-literal syntax out of an attribute isn't worth
// the complexity for that.
// (?<!:) excludes Alpine's `:class="..."` dynamic binding attribute — a
// bare \b word boundary alone still matches right after the `:` (a
// non-word character), so this regex was matching :class="{ 'rotate-45':
// activeIndex === {{INDEX}} || expandAll }" too despite the comment above
// already documenting the intent to skip it. Extracted that whole JS
// object-literal expression as if it were a space-separated class list,
// then correctly failed to find garbage tokens like "activeIndex"/"==="/
// "||" in any real stylesheet — a real template (e.g. the FAQ accordion,
// now also reused for qaContent) was being rejected as stale for a page
// design mismatch that was never real.
const CLASS_ATTR_RE = /(?<!:)\bclass="([^"]*)"/g;
export function extractLiteralClassNames(templateEntry) {
  const source = `${templateEntry?.wrapper || ''}\n${templateEntry?.row || ''}`;
  const classes = new Set();
  let m;
  while ((m = CLASS_ATTR_RE.exec(source))) {
    for (const token of m[1].split(/\s+/)) {
      if (token && !token.includes('{{')) classes.add(token);
    }
  }
  return [...classes];
}

const LINK_TAG_RE = /<link\b[^>]*>/gi;
export function extractStylesheetHrefs(html) {
  const hrefs = [];
  let m;
  while ((m = LINK_TAG_RE.exec(html))) {
    const tag = m[0];
    if (!/rel=["']?[^"'>]*stylesheet/i.test(tag)) continue;
    const hrefMatch = /href=["']([^"']+)["']/i.exec(tag);
    if (hrefMatch) hrefs.push(hrefMatch[1]);
  }
  return hrefs;
}

// Tailwind escapes any character that isn't valid in a bare CSS identifier
// with a backslash when it generates the selector for a class whose name
// contains it (e.g. `md:text-2xl` -> `.md\:text-2xl`, `w-1/2` -> `.w-1\/2`,
// `mb-0.5` -> `.mb-0\.5`) — this mirrors that so the check looks for the
// selector Tailwind would ACTUALLY emit, not the raw class text.
const NEEDS_CSS_ESCAPE = /[:/.%[\](),]/g;
function escapeForCssSelector(cls) {
  return cls.replace(NEEDS_CSS_ESCAPE, '\\$&');
}

// Substring search for `.escaped-class` at a real selector boundary —
// deliberately not just "class exists anywhere in the file" (a class name
// could appear inside a comment or an unrelated string) or "class exists as
// its own complete rule" (variants nest the base selector inside
// `@media`/`:hover` wrappers in real Tailwind output, never as a bare
// top-level rule).
//
// The boundary is defined by what CANNOT follow, not by enumerating what can.
// That distinction matters: the enumerate-what-can version listed `{`, `:`,
// `,` and space, and so silently reported EVERY space-y-* and divide-* utility
// as missing — Tailwind emits those as `.divide-y>:not([hidden])~:not([hidden])`,
// and `>` was not on the list. Verified against the real shipped CSS at
// zunkireelabs.com, where `.divide-y`, `.divide-gray-200` and `.space-y-3` are
// each followed ONLY ever by `>`.
//
// That single missing character is why site 1's faq, qaContent and
// internalLinks templates were never stamped: the freshness check could not
// verify any template using those utilities, so it reported perfectly live
// markup as stale, and the templates sat blocked. An allow-list of
// punctuation is a guess about CSS output; "the class name does not simply
// continue" is the actual rule.
//
// Identifier continuation characters are the ones that would mean we matched
// a PREFIX of a longer class (`.divide-y` inside `.divide-yellow`), including
// a backslash, which begins an escape that is still part of the name. End of
// input counts as a non-match: a name with nothing after it has no rule body,
// so it is not a real selector.
const IDENT_CONTINUATION = /[A-Za-z0-9_\-\\]/;
// Exported so other repair/detection logic that needs to ask "does the live
// CSS define this exact class" can reuse the same real-selector-boundary
// evidence bar instead of a second, potentially-drifting implementation —
// see agents/lib/prerequisite-repair.js's missing-Tailwind-typography check.
export function classExistsInCss(cls, css) {
  const needle = `.${escapeForCssSelector(cls)}`;
  let idx = css.indexOf(needle);
  while (idx !== -1) {
    const after = css[idx + needle.length];
    if (after !== undefined && !IDENT_CONTINUATION.test(after)) return true;
    idx = css.indexOf(needle, idx + 1);
  }
  return false;
}

// Rebuilds every literal `class="..."` attribute in a template, keeping only
// the tokens that resolve in the given CSS. Field/HTML structure, Alpine
// bindings (`:class="..."`, which this never touches — same exclusion as
// extractLiteralClassNames) and placeholders are all left exactly as they
// were; only the class LIST inside a real `class="..."` attribute changes,
// and an attribute left with nothing live is dropped entirely rather than
// emitted empty.
//
// This is the answer to a real trap in the projection path: composing a new
// component template from a site's designProfile can propose classes the
// profile recorded but the site's shipped CSS does not currently define — on
// zunkireelabs.com specifically, `profile.layout.prose` would be
// `prose prose-lg prose-gray max-w-none`, and `.prose*` genuinely ships zero
// rules (@tailwindcss/typography is not installed). Stamping that
// unconditionally would "unblock" a recommendation with a wrapper that
// renders invisibly — worse than staying blocked, because it looks fixed.
//
// Filtering to what actually ships is not a downgrade of intent: those same
// prose classes have no effect on the LIVE site either, so a filtered
// wrapper renders identically to what a real page on this site renders
// today. The dropped classes are worth recording for the audit trail and for
// a future, honest recommendation ("install @tailwindcss/typography") — that
// recommendation belongs to the client repo, not to this pipeline.
export function filterTemplateToLiveClasses(template, css) {
  const dropped = new Set();
  // A fresh instance, not the shared module-level CLASS_ATTR_RE: that one is
  // driven with exec() elsewhere and .replace() on a global regex advances
  // lastIndex too, so sharing it risks the two use sites interleaving badly
  // under any future reentrancy. The leading `\s*` is captured too so a
  // fully-emptied attribute can remove its own preceding space along with
  // itself, rather than leaving `<div >`.
  const classAttrRe = /\s*(?<!:)\bclass="([^"]*)"/g;
  const filterOne = (html) => {
    if (!html) return html;
    return html.replace(classAttrRe, (full, classList) => {
      const kept = classList.split(/\s+/).filter((token) => {
        if (!token) return false;
        if (token.includes('{{')) return true; // never touch a placeholder token
        const live = classExistsInCss(token, css);
        if (!live) dropped.add(token);
        return live;
      });
      return kept.length ? ` class="${kept.join(' ')}"` : '';
    });
  };
  const filtered = {
    ...template,
    wrapper: filterOne(template.wrapper),
    ...(template.row !== undefined ? { row: filterOne(template.row) } : {}),
  };
  return { template: filtered, dropped: [...dropped] };
}

// Single source of truth for "is this stored template still real" — fetches
// the exact live page this draft is about to publish to (not some other
// reference page), so the check reflects the exact CSS that page will
// actually load, and checks every class the template claims to use against
// it. `ok: false` means the check itself couldn't run (network/infra) —
// callers should fail OPEN on that (proceed as before), the same "a real
// infra failure isn't a policy judgment call" discipline render-inspector.js
// already follows; only `ok: true, stale: true` is real evidence the
// template needs updating.
export async function checkTemplateFreshness({ pageUrl, templateEntry, fetchPage = fetchText, fetchStylesheet = fetchText }) {
  const classes = extractLiteralClassNames(templateEntry);
  if (!classes.length) return { ok: true, stale: false, missingClasses: [], checkedClasses: [] };

  const html = await fetchPage(pageUrl);
  if (!html) return { ok: false, error: `Could not fetch ${pageUrl} to check its current live design.` };

  const hrefs = extractStylesheetHrefs(html);
  if (!hrefs.length) return { ok: false, error: `No <link rel="stylesheet"> found on ${pageUrl} — cannot verify the current design.` };

  const cssParts = [];
  for (const href of hrefs) {
    const css = await fetchStylesheet(resolveUrl(pageUrl, href));
    if (css) cssParts.push(css);
  }
  if (!cssParts.length) return { ok: false, error: `Could not fetch any stylesheet linked from ${pageUrl}.` };

  const css = cssParts.join('\n');
  const missingClasses = classes.filter((cls) => !classExistsInCss(cls, css));
  // `css` is included so a caller with a stale result can filter the template
  // down to what actually ships (filterTemplateToLiveClasses) without a
  // second fetch of the exact same stylesheets.
  return { ok: true, stale: missingClasses.length > 0, missingClasses, checkedClasses: classes, css };
}

// The same placeholder contract marker-merge.js's renderFaqHtml/
// renderLinksHtml/renderExpandedHtml already require of any componentTemplates
// entry — checked here too so a regenerated template can never silently drop
// a token the real splice depends on (that would fail loudly at apply time
// anyway via fillTemplate's plain string substitution leaving a literal
// "{{QUESTION}}" in the page, but catching it here is a clearer, earlier
// failure with an honest reason instead of shipping broken-looking content).
const REQUIRED_PLACEHOLDERS = {
  faq: { wrapper: ['{{ROWS}}'], row: ['{{QUESTION}}', '{{ANSWER}}'] },
  'expand-content': { wrapper: ['{{ROWS}}'], row: ['{{HEADING}}', '{{BODY}}'] },
  'internal-links': { wrapper: ['{{ROWS}}'], row: ['{{URL}}', '{{ANCHOR_TEXT}}'] },
  'qa-content': { wrapper: ['{{ROWS}}'], row: ['{{QUESTION}}', '{{ANSWER}}'] },
  // No `row` — a whole-page markdown body isn't a repeating list, it's one
  // {{BODY}} slot filled once. validatePlaceholders below treats a missing
  // `row` requirement as "nothing to check", not "row is required but empty".
  'content-wrapper': { wrapper: ['{{BODY}}'] },
};

export function validatePlaceholders(actionType, template) {
  const required = REQUIRED_PLACEHOLDERS[actionType];
  const missing = [
    ...required.wrapper.filter((p) => !template.wrapper?.includes(p)),
    ...(required.row || []).filter((p) => !template.row?.includes(p)),
  ];
  if (missing.length) {
    return { ok: false, error: `Proposed template is missing required placeholder(s): ${missing.join(', ')}.` };
  }
  return { ok: true };
}

// Whether actionType's componentTemplate shape has a `row` at all — only
// 'content-wrapper' doesn't (see REQUIRED_PLACEHOLDERS above). A caller
// that needs to know whether a given action type's template is the
// repeating-row shape (faq/expand-content/internal-links/qa-content) or the
// single-slot shape (content-wrapper) uses this instead of assuming.
export function templateActionRequiresRow(actionType) {
  return (REQUIRED_PLACEHOLDERS[actionType]?.row || []).length > 0;
}

// ---------------------------------------------------------------------------
// Template provenance — "who verified this template, and against what?"
// ---------------------------------------------------------------------------
// componentTemplates used to carry no provenance at all: a hand-captured
// snapshot and a real-repo-grounded Design Agent derivation were byte-identical
// in storage, so nothing downstream could tell a verified template from a
// guess someone pasted in months ago. That ambiguity is what let unverified
// templates reach apply time and fail there (the "looks bigger/different than
// the rest of the site" class of failure this module already existed to catch,
// plus a large share of the observed apply-failure rate).
//
// The stamp lives INSIDE the template object rather than in a parallel table
// or column: every existing reader (marker-merge.js's fillTemplate,
// newpage-render.js, extractLiteralClassNames, validatePlaceholders) reads
// only `.wrapper`/`.row`, so extra keys are inert to all of them and no
// migration or backfill is required. An UNSTAMPED template is treated as
// unverified, which is the correct reading of every template stored before
// this existed — none of them were ever checked against a live page.
//
// Deliberately only two, both grounded/deterministic — there is no HUMAN
// entry. A staff member's opinion that a template "looks right" is not
// evidence it will render correctly; only a real repo checkout (DESIGN_AGENT)
// or a real live-CSS check (FRESHNESS_CHECK) is. The autonomous pipeline
// (resolveOrCreateComponentTemplate below, and the verify-component-templates
// script) is the only path that can produce a verified template.
export const TEMPLATE_VERIFIED_BY = {
  DESIGN_AGENT: 'design-agent', // derived from the site's real repo by OpenHands
  FRESHNESS_CHECK: 'freshness-check', // every claimed class proven live against the real site
};

// Attaches provenance without mutating the caller's object. `ref` is whatever
// identifies the evidence — a design_generate job id, a user id, or the page
// URL a freshness check ran against — so a later "why is this trusted?" has a
// real answer instead of a bare boolean.
export function stampTemplateVerification(template, { verifiedBy, verifiedRef = null, at = new Date() } = {}) {
  if (!template) return template;
  return { ...template, verifiedAt: at.toISOString(), verifiedBy, verifiedRef: verifiedRef == null ? null : String(verifiedRef) };
}

// The single predicate the gate asks. Deliberately structural-only (is there a
// stamp, and does the template still satisfy its placeholder contract) — it
// makes NO network call, so it is safe to call on the hot path in
// generateDraft and inside the per-item loop in buildRecommendations. Live-CSS
// freshness is the separate, expensive checkTemplateFreshness above, used by
// server/scripts/verify-component-templates.js.
export function isTemplateVerified(actionType, template) {
  if (!template?.wrapper) return { ok: false, reason: 'missing', detail: 'No component template is configured for this site yet.' };
  if (!template.verifiedAt || !template.verifiedBy) {
    return { ok: false, reason: 'unverified', detail: 'This site\'s component template has never been verified against the real site design.' };
  }
  const placeholders = validatePlaceholders(actionType, template);
  if (!placeholders.ok) return { ok: false, reason: 'invalid-placeholders', detail: placeholders.error };
  return { ok: true, verifiedAt: template.verifiedAt, verifiedBy: template.verifiedBy };
}

// Turns an UNSTAMPED but otherwise real template into a verified one, by
// proving its classes are live on the site right now.
//
// This closes a gap that was costing site 1 real shippable work. Three of its
// four component templates (faq, qaContent, internalLinks) held genuine
// repo-derived markup and were blocked solely because they carried no
// verification stamp — isTemplateVerified returns 'unverified' for a template
// with no verifiedAt, which is the correct default for anything stored before
// stamping existed. But resolveOrCreateComponentTemplate treated
// unstamped-but-present as unusable and jumped straight to re-derivation,
// never asking the cheap question first: are these classes actually live?
//
// They were. All of divide-y, divide-gray-200 and space-y-3 are present in
// the site's shipped CSS, verified directly against
// https://zunkireelabs.com/assets/main-*.css. So the correct repair was a
// single page fetch, not an OpenHands container job — and certainly not
// declaring those templates permanently invalid.
//
// Fails OPEN only on infrastructure. A network blip must not be read as
// evidence a template is bad, and must not trigger an expensive re-derivation
// — 'unreachable' means "we learned nothing", so the caller should leave the
// template exactly as it found it and try again next pass.
// The placeholder whose slot holds long-form prose, per action type. This is
// the one slot where a label style is unambiguously wrong: a heading may
// legitimately be uppercase, a button usually is, but body copy never is.
const BODY_SLOT_PLACEHOLDER = {
  faq: '{{ANSWER}}',
  'qa-content': '{{ANSWER}}',
  'expand-content': '{{BODY}}',
  'content-wrapper': '{{BODY}}',
  // internal-links' slot is an anchor label, not prose — a site may style its
  // link lists in caps deliberately. Deliberately excluded.
};

// The class tokens on the element that directly wraps `placeholder`. Scans
// back from the placeholder to the nearest opening tag and reads that tag's
// literal class attribute — the same "literal class attributes only" scope
// extractLiteralClassNames and filterTemplateToLiveClasses already work in.
function classesOnSlotElement(markup, placeholder) {
  const at = markup.indexOf(placeholder);
  if (at === -1) return [];
  const open = markup.lastIndexOf('<', at);
  if (open === -1) return [];
  const tag = markup.slice(open, at);
  const match = /\sclass="([^"]*)"/.exec(tag);
  return match ? match[1].trim().split(/\s+/).filter(Boolean) : [];
}

// True when the CSS defines `cls` with a rule that makes text read as a label
// rather than prose. Scoped to the single rule block following the selector so
// an unrelated later `text-transform` in the sheet can't produce a false
// positive.
function classIsLabelStyle(cls, css) {
  const needle = `.${escapeForCssSelector(cls)}`;
  let idx = css.indexOf(needle);
  while (idx !== -1) {
    const after = css[idx + needle.length];
    if (after !== undefined && !IDENT_CONTINUATION.test(after)) {
      const open = css.indexOf('{', idx);
      const close = open === -1 ? -1 : css.indexOf('}', open);
      if (open !== -1 && close !== -1) {
        const body = css.slice(open + 1, close);
        if (/text-transform\s*:\s*uppercase/i.test(body)) return true;
        const size = /font-size\s*:\s*([\d.]+)(rem|px|em)/i.exec(body);
        if (size) {
          const n = parseFloat(size[1]);
          const px = size[2].toLowerCase() === 'px' ? n : n * 16;
          if (px < 14) return true;
        }
      }
    }
    idx = css.indexOf(needle, idx + 1);
  }
  return false;
}

// Returns a human-readable reason string when the body slot is styled as a
// label, or null when it looks like real prose (or when there is nothing to
// judge — no CSS, no such slot, no literal classes: all "can't tell", which
// must not be reported as a failure).
export function bodySlotLooksLikeLabel(actionType, template, css) {
  const placeholder = BODY_SLOT_PLACEHOLDER[actionType];
  if (!placeholder || !css) return null;
  const markup = `${template?.row || ''}\n${template?.wrapper || ''}`;
  const offenders = classesOnSlotElement(markup, placeholder).filter((c) => classIsLabelStyle(c, css));
  if (!offenders.length) return null;
  return `The ${placeholder} slot is styled with ${offenders.join(', ')}, which the live CSS defines as a label `
    + '(uppercase and/or under 14px) rather than body copy. Generated prose would render as a caption.';
}

// ─────────────────────────────────────────────────────────────────────────
// ROLE VERIFICATION — is a typography field the class this site actually
// uses for that role, not just a class that exists.
//
// bodySlotLooksLikeLabel above catches one specific, CSS-provable shape of
// wrong role (a class the live stylesheet itself defines as uppercase/small,
// i.e. objectively caption-styled). It says nothing when the wrong class has
// no such tell — a 24px pull-quote wrongly picked as body copy has no
// text-transform or small font-size to catch it that way (that particular
// case is what correctBodyTypography's own token-centrality scoring already
// fixes, upstream of here).
//
// This check is independent and complementary: rather than judging a class's
// CSS properties, it asks whether the class was ever REAL EVIDENCE for the
// role it is now being used as. profile.pages[].sections[].textHierarchy[]
// (segment.js) already records, for every captured page, which class string
// was observed playing which role — body, heading, subheading, cta, link.
// A typography field that names a class this site only ever uses for a
// DIFFERENT role — an eyebrow's classes stored as typography.body, a hero
// CTA button's classes stored as typography.link — is a confirmed defect:
// the classes are real, and the site's own pages are the evidence that they
// mean something else. This is the exact incident this platform's first
// client shipped (body copy rendered in eyebrow style, related links
// rendered as filled buttons) caught generically instead of as one
// hardcoded special case.
//
// Structural fields (layout.container, spacing.section, components.*) are
// deliberately out of scope — they carry no text role, so there is no role
// for them to be wrong about.
// Deliberately a private copy of profile-extract.js's own normalizeClasses,
// not an import of it — profile-extract.js pulls in llm.js
// (callLLMForJson), and design-drift.js is imported (via sitePageUrl) by
// agents that mock llm.js with a deliberately partial namedExports list
// (font-consistency.test.js, visual-quality.test.js: only callLLM/
// callLLMWithImages, no callLLMForJson). Node's --experimental-test-
// module-mocks resolves mocked bindings statically, so a real transitive
// import into llm.js from inside design-drift.js breaks every one of those
// tests at module-load time, before a single assertion runs. Same
// "kept as its own copy deliberately" precedent profile-extract.js's own
// isLabelStyle already follows for the identical reason, one file over.
function normalizeClasses(classes) {
  return classes.trim().split(/\s+/).filter(Boolean).join(' ');
}

// Both heading.section (an <h2>, e.g. expand-content's own section heading —
// see projectExpandContent) and heading.item (an <h3>-or-fallback-h2, e.g. an
// FAQ question) are checked against the SAME evidence — textHierarchy's role
// is only 'heading' (h1) vs 'subheading' (anything else), with no h2-vs-h3
// split the way correctHeadingTypography's own byLevel map has. That is
// coarser than the correction it verifies: this check can still catch either
// field naming a class this site never uses on ANY heading tag at all (e.g.
// a class that's really the site's cta/body/link style), but it cannot catch
// heading.section and heading.item being swapped with each other — both
// read as legitimate 'subheading' evidence either way. Real, honest
// evidence, just at a coarser grain than the two-field split it's checking.
export const TYPOGRAPHY_ROLE_SOURCE = [
  { field: 'typography.body', roles: ['body'], get: (p) => p?.typography?.body },
  { field: 'typography.heading.section', roles: ['heading', 'subheading'], get: (p) => p?.typography?.heading?.section },
  { field: 'typography.heading.item', roles: ['heading', 'subheading'], get: (p) => p?.typography?.heading?.item },
  { field: 'typography.link', roles: ['link'], get: (p) => p?.typography?.link },
];

// role -> Set of normalized class strings actually observed playing that
// role, across every captured page's every section's textHierarchy. Built
// once per profile so per-field lookups below are a Set membership check,
// not a re-scan of every page.
export function observedClassesByRole(profile) {
  const byRole = new Map();
  for (const page of profile?.pages || []) {
    for (const section of page.sections || []) {
      for (const item of section.textHierarchy || []) {
        if (!item.classes) continue;
        const norm = normalizeClasses(item.classes);
        if (!norm) continue;
        if (!byRole.has(item.role)) byRole.set(item.role, new Set());
        byRole.get(item.role).add(norm);
      }
    }
  }
  return byRole;
}

// Which role (if any) a class string WAS observed playing, when it was not
// observed in the role currently being checked. This is what turns a plain
// miss into a NAMED defect — "your body copy is set to your eyebrow style"
// is a real, actionable finding; "we never saw this exact string" is not.
function roleThisClassActuallyPlays(observed, classes) {
  const norm = normalizeClasses(classes);
  for (const [role, set] of observed) {
    if (set.has(norm)) return role;
  }
  return null;
}

// Checks ONE typography field against the section evidence. Exported so a
// reporting tool can run every field and show the full picture — every
// field's verdict, not just the first failure — while verifyProfileRoles
// below stops at the first CONFIRMED mismatch, matching this file's existing
// single-reason-per-check convention (validatePlaceholders,
// checkTemplateFreshness) for the ship-gate use this is ultimately for.
//
// `observed` is optional — a standalone caller (a test, a one-off script)
// can omit it and pay the one-time scan; verifyProfileRoles computes it once
// and threads it through its own three calls instead.
export function checkTypographyRole(profile, source, observed = observedClassesByRole(profile)) {
  const classes = source.get(profile);
  // A null field is an honest abstention (extractDesignProfile already
  // prefers null over inventing a value) — nothing to verify, not a failure.
  if (!classes) return { ok: true, field: source.field, reason: 'not-set' };

  if (source.roles.some((r) => observed.get(r)?.has(normalizeClasses(classes)))) {
    return { ok: true, field: source.field };
  }

  // Did the capture record ANY element in the role(s) this field is checked
  // against? If not, there is no evidence base here at all, and a "mismatch"
  // cannot honestly be confirmed against evidence that does not exist.
  //
  // This is not hypothetical. capture.js only ever emits four roles —
  // heading, body, cta, subheading — and `link` is not among them, so
  // typography.link's accepted role set (['link']) matches nothing on ANY
  // site, ever. Worse, an ordinary inline link resembles a CTA closely enough
  // that the same class string is genuinely captured under `cta`, which sent
  // this field down the `actual` branch below and reported it as a CONFIRMED
  // role-mismatch — the one reason that blocks.
  //
  // Site 1 shows the effect exactly: typography.link is
  // "text-zunkiree-600 hover:underline" (a plain inline-link style; a real
  // CTA on this site carries px-/py-/bg-/rounded-), and all 54 recorded
  // verdicts failed on it — a 100% failure rate that is a property of the
  // check, not of the site. Had DESIGN_INTEGRITY_ENFORCE been turned on as
  // the rollout plan intended, it would have blocked every visible-content
  // draft for every tenant, permanently, on a defect none of them have.
  //
  // Reported (never silently dropped) but non-blocking, which is the same
  // call this module already makes for thin evidence via 'class-unobserved':
  // verifyProfileRoles blocks on a confirmed 'role-mismatch' only. Fields
  // whose role IS captured — body, heading, subheading — are unaffected and
  // still confirm and block, so the incident this gate was built for (body
  // copy set to an eyebrow style) is still caught.
  const roleEvidenceExists = source.roles.some((r) => (observed.get(r)?.size || 0) > 0);
  const actual = roleThisClassActuallyPlays(observed, classes);
  if (!roleEvidenceExists) {
    return {
      ok: false,
      field: source.field, classes, observedAs: actual,
      reason: 'role-unobserved',
      error: `${source.field} could not be verified: the capture recorded no ${source.roles.join('/')} elements on any page, so there is no evidence to check it against.`,
    };
  }

  return {
    ok: false,
    field: source.field, classes, observedAs: actual,
    // 'role-mismatch': the classes are real AND demonstrably used for a
    // different role — confirmed defect, this is what blocks (Phase 5).
    // 'class-unobserved': never seen in ANY role across the capture. Weaker
    // evidence — the capture samples up to 8 pages, so a class the site
    // genuinely uses elsewhere can legitimately be absent from the sample —
    // reported, but never blocks on its own.
    reason: actual ? 'role-mismatch' : 'class-unobserved',
    error: actual
      ? `${source.field} uses classes this site only ever uses for its ${actual}.`
      : `${source.field} uses classes never observed on any captured page.`,
  };
}

// The ship-gate contract (not yet wired into verifyTemplateAgainstLiveSite —
// see the platform's design-integrity-gate proposal, Phase 5: enforcement is
// the LAST phase, only turned on once this has been run against real,
// already-derived profiles and shown to report true defects, not false
// positives from a thin capture sample). Returns the first CONFIRMED
// role-mismatch across every typography field, or ok:true — never blocks on
// class-unobserved or role-unobserved alone (see checkTypographyRole: both
// mean "not enough evidence to confirm", not "confirmed wrong").
export function verifyProfileRoles(profile) {
  const observed = observedClassesByRole(profile);
  for (const source of TYPOGRAPHY_ROLE_SOURCE) {
    const result = checkTypographyRole(profile, source, observed);
    if (!result.ok && result.reason === 'role-mismatch') return result;
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────
// DESIGN REVIEW SIGN-OFF — a staff human's confirmation that this profile
// was actually looked at, recorded against the EXACT profile they saw.
//
// Deterministic fingerprint over only what a reviewer actually approved: the
// five projected component templates (the real markup that will ship), plus
// the raw typography inputs role verification reads (TYPOGRAPHY_ROLE_SOURCE
// — the same four class strings the review screen shows next to their
// role-check verdict). Deliberately NOT the whole stored profile —
// profile.evidence.notes and profile.site.pagesAnalyzed change on every
// weekly rescan without changing a single thing that ships, and
// fingerprinting the whole profile would invalidate a valid review on that
// noise, training staff to re-approve without reading, which is worse than
// no gate at all.
export function designReviewFingerprint(profile) {
  if (!profile) return null;
  const templates = projectAllComponentTemplates(profile);
  const typographyInputs = Object.fromEntries(TYPOGRAPHY_ROLE_SOURCE.map((s) => [s.field, s.get(profile) || null]));
  return createHash('sha256').update(JSON.stringify({ templates, typographyInputs })).digest('hex');
}

// The ship-time question: has a human signed off on the design THIS SITE
// CURRENTLY HAS, not merely on some design it had once. `design_review_at`
// null means never reviewed — the honest default for every site that
// predates this gate (migration 132, no backfill). A later re-derivation
// (the weekly rescan) that changes the fingerprint makes an existing
// sign-off 'stale' rather than silently absent — a meaningful distinction:
// 'stale' asks a human to re-approve a diff, 'unreviewed' asks them to look
// at a site nobody has ever looked at.
export function designReviewState(site) {
  if (!site?.design_review_at) return { ok: false, reason: 'unreviewed' };
  const currentFingerprint = designReviewFingerprint(getDesignProfile(site));
  if (currentFingerprint !== site.design_review_fingerprint) return { ok: false, reason: 'stale' };
  return { ok: true };
}

// The ACTUAL ship-time gate (replaces designReviewState above in that role —
// designReviewState/the review screen still exist for a human who wants to
// look, but are no longer a shipping prerequisite). Runs verifyProfileRoles
// against this site's real, currently-derived profile: a CONFIRMED
// role-mismatch (the zunkireelabs.com incident class — real classes,
// demonstrably used for a different role) fails; a profile with no observed
// mismatch, or no usable profile at all, passes.
//
// Every call is logged to design_integrity_verdicts regardless of mode, so
// the false-positive rate can be checked against real profiles before
// DESIGN_INTEGRITY_ENFORCE is turned on. In log-only mode (the default) a
// failing verdict is still recorded but never blocks — see that env var's
// own comment for why enforcement is a separate, later flip rather than
// bundled into this same change.
//
// Deliberately scoped to ONE recommendation's apply call, not the whole
// site: unlike the human sign-off it replaces, a failure here quarantines
// only the draft being applied right now. The caller's loop (
// auto-remediation.js's per-recommendation attempt) moves on to the next
// recommendation regardless, so one bad draft can never zero out a site's
// whole run the way the old gate did.
export async function checkDesignIntegrityGate(site, { actionType = null, findingId = null } = {}) {
  const profile = getDesignProfile(site);
  if (!isProfileUsable(profile)) return { ok: true, reason: 'no-profile' };

  const verdict = verifyProfileRoles(profile);
  const enforced = process.env.DESIGN_INTEGRITY_ENFORCE === 'true';

  await recordDesignIntegrityVerdict({ siteId: site.id, findingId, actionType, verdict, enforced });

  if (!enforced) return { ok: true, reason: 'log-only', observed: verdict };
  return verdict;
}

export async function verifyTemplateAgainstLiveSite(actionType, template, { pageUrl, fetchPage, fetchStylesheet } = {}) {
  if (!template?.wrapper) return { ok: false, reason: 'missing' };
  if (!pageUrl) return { ok: false, reason: 'unreachable', error: 'No live page URL available to verify against.' };

  // Placeholders first: it is a pure string check, and a template that would
  // splice broken is not worth a network round trip to confirm.
  const placeholders = validatePlaceholders(actionType, template);
  if (!placeholders.ok) return { ok: false, reason: 'invalid-placeholders', error: placeholders.error };

  const freshness = await checkTemplateFreshness({ pageUrl, templateEntry: template, fetchPage, fetchStylesheet })
    .catch((err) => ({ ok: false, error: err.message }));
  if (!freshness.ok) return { ok: false, reason: 'unreachable', error: freshness.error };
  // css is carried through so a caller can filterTemplateToLiveClasses and
  // re-verify without a second round trip to the exact same stylesheets.
  if (freshness.stale) return { ok: false, reason: 'stale', missingClasses: freshness.missingClasses, css: freshness.css };

  // A template with no literal classes at all (e.g. a bare `<dl>{{ROWS}}</dl>`)
  // passes the freshness check vacuously — there is nothing to disprove. It
  // must NOT be stamped on that basis: the stamp asserts "this matches the real
  // site design", and a template making no design claims has not earned it.
  // Such a template is exactly the case a design-profile projection improves
  // on, so report it as unverifiable-here and let the caller fall through.
  if (!freshness.checkedClasses?.length) return { ok: false, reason: 'no-design-claims' };

  // Class EXISTENCE is not class CORRECTNESS. Every check above answers "does
  // the live site define this class", and a template can pass all of them
  // while using a perfectly real class in entirely the wrong role — which is
  // how zunkireelabs.com came to have all five of its templates stamped
  // `verifiedBy: design-agent` while rendering every generated paragraph in
  // its eyebrow/kicker style: `text-xs uppercase tracking-widest`, all real,
  // all defined, all wrong for body copy. Verification has to be able to say
  // no to that, or the stamp means only "these strings exist".
  const label = bodySlotLooksLikeLabel(actionType, template, freshness.css);
  if (label) return { ok: false, reason: 'body-slot-is-label', error: label };

  return {
    ok: true,
    reason: 'passed',
    checkedClasses: freshness.checkedClasses,
    stamped: stampTemplateVerification(template, {
      verifiedBy: TEMPLATE_VERIFIED_BY.FRESHNESS_CHECK,
      verifiedRef: pageUrl,
    }),
  };
}

// generatorId -> the componentTemplates action type it renders through. Every
// net-new whole-page generator (frontend.js's FRONTEND_ACTION_TYPES: the three
// compliance pages, landing-page, blog-outline, direct-answer, translation)
// shares the single generic 'content-wrapper' key rather than each having its
// own — they all render the same shape, one markdown body dropped into one
// {{BODY}} slot (newpage-render.js). Every other generator maps to itself.
//
// This used to be COMPLIANCE_ACTION_TYPES only, which meant the other four
// net-new page types had no component-template concept at all: both gates saw
// 'no-concept', returned ok, and waved them straight through — while
// newpage-render.js emitted their bodies with no site wrapper, i.e. bare
// unstyled <h1>/<h2>/<p> into a real PR. That is the exact failure already
// confirmed live on zunkireelabs-web's /terms/, /privacy/ and /cookies/ before
// contentWrapper was captured for it; the compliance trio was fixed then and
// these four were left behind.
//
// Lives here, next to COMPONENT_TEMPLATE_KEY, so the draft-generation gate
// (routes/action-center.js) and the recommendation gate
// (agents/lib/recommendations.js) cannot drift apart on which action type a
// generator is actually checked against.
export function componentTemplateActionTypeFor(generatorId) {
  return FRONTEND_ACTION_TYPES.has(generatorId) ? 'content-wrapper' : generatorId;
}

// Convenience read used by both gates: resolves the stored template for a
// site+actionType and returns its verification verdict in one step. Pure read
// of the already-loaded `site` row — no DB or network access.
export function componentTemplateVerification(site, actionType) {
  const componentKey = COMPONENT_TEMPLATE_KEY[actionType];
  if (!componentKey) return { ok: true, reason: 'no-concept', componentKey: null };
  // 'content-wrapper' has its own, looser rule — see contentWrapperAvailability
  // just below for why a stricter check here would contradict what the apply
  // path actually does.
  if (actionType === 'content-wrapper') return contentWrapperAvailability(site);
  const template = site?.url_file_map?.siteRoot?.componentTemplates?.[componentKey];
  return { ...isTemplateVerified(actionType, template), componentKey, actionType };
}

// The gate for 'content-wrapper' specifically, separated out because the
// strict rule above is stricter than what actually happens at apply time.
//
// newpage-render.js's wrapInSiteProse already degrades gracefully: configured
// template -> project one from the design profile -> bare unwrapped body. A
// usable design profile is therefore already enough for a net-new page to
// render with real site styling, with no stored componentTemplates entry
// required at all — the gate was the only place still insisting on one. That
// mismatch is exactly what blocked 28 real, shippable blog-outline
// recommendations on site 1: the gate said "no component template is
// configured for this site yet" while the apply path had a perfectly good
// fallback ready to use.
//
// So this asks the honest question: can wrapInSiteProse produce SOMETHING
// better than a bare body right now? Yes if either a verified template
// exists, or the site has a usable profile to project from at apply time (the
// projection now runs the same live-CSS check resolveOrCreateComponentTemplate
// does above, so "usable" here is not a blank check — see that function's
// projection branch for the verification itself). Only when neither exists is
// this genuinely blocked, and the message says the true reason: a design
// language that hasn't been derived yet, not a template that was never
// "configured" by a human who was never asked to configure one.
export function contentWrapperAvailability(site) {
  const componentKey = COMPONENT_TEMPLATE_KEY['content-wrapper'];
  const template = site?.url_file_map?.siteRoot?.componentTemplates?.[componentKey];
  const verified = isTemplateVerified('content-wrapper', template);
  if (verified.ok) return { ...verified, componentKey, actionType: 'content-wrapper' };

  if (isProfileUsable(getDesignProfile(site))) {
    return { ok: true, reason: 'projectable-from-profile', componentKey, actionType: 'content-wrapper' };
  }

  return {
    ok: false,
    reason: 'design-language-not-derived',
    detail: "This site's Design Context hasn't been derived yet — analysis of the live site has been queued. No action needed; this generator's default fallback template renders in the meantime.",
    componentKey,
    actionType: 'content-wrapper',
  };
}

// LEARN side of the loop this module's RETRIEVE half (resolveOrCreateComponentTemplate
// below) already reads from. Single source of truth for what a rejected-template lesson looks
// like — called from resolveOrCreateComponentTemplate below, the sole
// path (autonomous, no human step) that can produce a componentTemplate in
// production, so there is exactly one write path into agent_fix_memory for
// a Design Agent placeholder rejection, not a fork between an autonomous
// path and a separate staff-triggered one.
//
// validatePlaceholders is a deterministic, ground-truth check (a plain
// string-contains test, not an LLM judgment call), so a rejection clears
// the same "genuinely validated" bar every other recordFixOutcome call site
// in this codebase requires — same shape action-center.js uses to record a
// Quality Gate hit. Never lets a memory-write failure block the caller —
// same fail-open discipline as everywhere else this table is touched.
export function recordRejectedTemplateLesson({ siteId, actionType, error, recordFixOutcomeFn = recordFixOutcome }) {
  return recordFixOutcomeFn({
    category: 'content', scope: 'client', siteId, generatorId: DESIGN_AGENT_GENERATOR_ID,
    validationRuleId: `missing-placeholders:${actionType}`, outcome: 'success', sourceType: 'runtime-auto',
    problemSignature: `missing-placeholders:${actionType}`,
    symptoms: `Design Agent derived a "${actionType}" component template missing a required placeholder token.`,
    rootCause: error,
    affectedPattern: `Design Agent component-templates output for action type "${actionType}".`,
    fixStrategy: `Every placeholder token required for "${actionType}" must appear verbatim in the derived template — ${error}`,
  }).catch((err) => console.error(`[design-drift] failed to record rejected-template memory for ${actionType}:`, err.message));
}

// The site's own real homepage URL — the page a freshness check runs against
// when no more specific one is known. website_domain is the configured value;
// gsc_property is the fallback for a site connected via Search Console only
// (its `sc-domain:` prefix is not part of the URL). Returns null when neither
// is set, which every caller treats as "cannot check against a live page."
export function sitePageUrl(site) {
  const domain = site?.website_domain || site?.gsc_property?.replace(/^sc-domain:/, '');
  if (!domain) return null;
  return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
}

// A synthetic req-like shape for recordAuditEvent — this resolver runs
// during draft GENERATION (generateDraft, called from the manual UI route,
// the MCP tool, and the unattended execution engine alike), never from one
// specific staff HTTP request, so there's no real req to pass through.
// req.userId left null resolves to audit-log.js's own 'system' actor type,
// which is exactly the right attribution for a template a human never
// clicked to create.
function systemActorReq(siteId) {
  return { userId: null, siteId, ip: null, get: () => null };
}

// The ONE place a Design-Agent-derived template becomes a saved, verified
// template on a site — validate, stamp, persist, audit. Extracted out of
// resolveOrCreateComponentTemplate below because there are two ways a
// derivation can arrive and they must produce byte-identical stored state:
//
//   1. INLINE — resolveOrCreateComponentTemplate ran the OpenHands session
//      itself (first-time derivation, no template to fall back on).
//   2. QUEUED — the design-agent worker ran it off the execution_jobs queue
//      (worker.js's processOneJob), which is the repair path for an existing
//      but unverified template.
//
// Path 2 had NO consumer at all before this: the worker wrote the derived
// templates onto execution_jobs.result and stopped, and every reader of that
// column (component-template-proposal.js and the /design-jobs + /confirm
// staff routes) was deleted by f7156ef along with the human-confirm workflow.
// So a queued re-derivation ran, succeeded, and its output was discarded —
// the template stayed unstamped, the gate kept rejecting it, and the next
// attempt queued another job to throw away. That is why the four templates on
// the only repo-connected site never healed.
//
// Takes the whole `componentTemplates` map the handler returned (keyed by
// ACTION TYPE, e.g. 'faq' / 'expand-content') rather than one entry, because a
// single job can be asked for several keys at once — one config write for all
// of them, not one per key.
// ── Website design profile ─────────────────────────────────────────────────
//
// The site's whole design language, derived once, and the SOURCE every
// per-component template is projected from. Stored beside componentTemplates
// under siteRoot so a site's design knowledge lives in one place.
//
// Before this existed, the Design Agent's only persisted output was the five
// component templates. Its OpenHands session analysed the whole site to
// produce them and then threw that understanding away — so every action type
// re-analysed the same repo, and any generator without a template fell back
// to its own hardcoded markup. The profile is what makes design knowledge a
// durable, shared asset instead of a side effect of one derivation.
export function getDesignProfile(site) {
  return site?.url_file_map?.siteRoot?.designProfile || null;
}

export function siteHasUsableDesignProfile(site) {
  return isProfileUsable(getDesignProfile(site));
}

// Generators whose output is real, visible page content — the set every
// website-facing draft is drawn from, as opposed to purely technical output
// (meta-title, schema, canonical, sitemap, robots-fix, security-headers,
// html-lang, viewport, open-graph, llms-txt, analytics-install,
// duplicate-id-fix, breadcrumbs, schema-repair) that has no rendered visual
// footprint and so has no use for a design/voice grounding. This is the
// authoritative set backend.js/frontend.js's `handles` arrays split into
// visible vs. invisible; kept here (not re-derived from COMPONENT_TEMPLATE_KEY,
// which is narrower — only the 5 types with a literal HTML wrapper) because
// withDesignContext below grounds the LLM PROSE, not a template substitution,
// so it applies to every visible-content generator, not just the projectable
// ones.
export const DESIGN_CONTEXT_GENERATOR_IDS = new Set([
  'faq', 'qa-content', 'expand-content', 'internal-links', 'direct-answer',
  'alt-text', 'broken-link-fix', 'redirect-fix', 'translation',
  'blog-outline', 'landing-page', 'cookie-policy', 'privacy-policy', 'terms-of-service',
]);

// The shared design-intelligence layer's RETRIEVE half — mirrors
// agent-memory.js's withAgentMemory exactly (same signature shape, same
// "append a grounding block to the system prompt, fail open on any error"
// contract), so every website-facing generator gets real site design/voice
// grounding for free just by passing its own generatorId + siteId to
// server/llm.js's callLLM, the same way it already gets agent_fix_memory
// lessons. Never blocks or throws: a site with no usable profile yet (or
// any lookup failure) returns `system` completely unchanged, so a
// generator's output is byte-for-byte the same as before this existed until
// a real Design Context has been derived.
export async function withDesignContext(system, generatorId, siteId, { fetchSite = getSiteById } = {}) {
  if (!generatorId || !siteId || !DESIGN_CONTEXT_GENERATOR_IDS.has(generatorId)) return system;

  let site;
  try {
    site = await fetchSite(siteId);
  } catch (err) {
    console.warn(`[design-drift] could not load site ${siteId} for design context, continuing without it: ${err.message}`);
    return system;
  }
  const profile = getDesignProfile(site);
  if (!isProfileUsable(profile)) return system;

  const patterns = profile.pageTypePatterns || {};
  const patternNotes = Object.entries(patterns)
    .map(([type, p]) => `- ${type}: sections in order ${JSON.stringify(p.sectionOrder || [])}${p.notes ? ` — ${p.notes}` : ''}`)
    .join('\n');

  return `${system}\n\nThis site's real design and voice, derived from its own live pages — write to match it, not a generic style:\n`
    + `- Styling: ${profile.styling || 'unknown'}${profile.framework ? ` (${profile.framework})` : ''}\n`
    + (patternNotes ? `- Observed page-type patterns:\n${patternNotes}\n` : '')
    + (profile.evidence?.notes ? `- ${profile.evidence.notes}\n` : '');
}

// Re-exported for discoverability alongside the rest of this module's
// Design Agent readiness logic — the real implementation lives in
// onboarding-readiness.js, a deliberately leaf-level module (see its own
// comment) so callers that only need this one check don't pull in this
// file's much heavier import graph (audit-log, agent-memory, ...).
export { isOnboardingAnalysisPending } from './onboarding-readiness.js';

// Validates and saves a freshly-derived profile, then projects EVERY
// design-sensitive component template from it in the same pass. That is the
// architectural point: one analysis yields the site's whole design-sensitive
// surface, rather than one template per repo analysis.
export async function persistDesignProfile(site, rawProfile, {
  jobId = null,
  saveConfig = updateSiteRepoConfig,
  recordAudit = recordAuditEvent,
  persistTemplatesFn = persistDerivedComponentTemplates,
} = {}) {
  const profile = stampDesignProfile(rawProfile, {
    derivedBy: TEMPLATE_VERIFIED_BY.DESIGN_AGENT,
    derivedRef: jobId,
  });
  if (!isProfileUsable(profile)) {
    return { ok: false, reason: 'invalid-profile', profile: null, projected: {} };
  }

  const urlFileMap = {
    ...site.url_file_map,
    siteRoot: { ...site.url_file_map?.siteRoot, designProfile: profile },
  };
  const saved = await saveConfig({ siteId: site.id, urlFileMap });
  await recordAudit(systemActorReq(site.id), {
    action: 'tenant.design_profile_derived',
    targetType: 'site',
    targetId: String(site.id),
    tenantSiteId: site.id,
    tenantName: site.name,
    metadata: { styling: profile.styling || null, framework: profile.framework || null, jobId },
    success: true,
  }).catch(() => {});

  // Project from the profile we just saved, against the site row the save
  // returned, so the templates land on top of the profile rather than
  // racing it.
  const siteWithProfile = saved?.url_file_map ? { ...site, url_file_map: saved.url_file_map } : { ...site, url_file_map: urlFileMap };
  const projected = projectAllComponentTemplates(profile);
  const result = await persistTemplatesFn(siteWithProfile, projected, { jobId });

  return { ok: true, profile, projected: result?.saved || {}, rejected: result?.rejected || [] };
}

export async function persistDerivedComponentTemplates(site, componentTemplates, {
  jobId = null,
  saveConfig = updateSiteRepoConfig,
  recordAudit = recordAuditEvent,
  recordFixOutcomeFn = recordFixOutcome,
} = {}) {
  const accepted = [];
  const rejected = [];

  for (const [actionType, derived] of Object.entries(componentTemplates || {})) {
    const componentKey = COMPONENT_TEMPLATE_KEY[actionType];
    if (!componentKey) { rejected.push({ actionType, reason: 'no-concept' }); continue; }
    if (!derived?.wrapper) { rejected.push({ actionType, reason: 'not-derived' }); continue; }

    const check = validatePlaceholders(actionType, derived);
    if (!check.ok) {
      recordRejectedTemplateLesson({ siteId: site.id, actionType, error: check.error, recordFixOutcomeFn });
      rejected.push({ actionType, reason: 'invalid-placeholders', error: check.error });
      continue;
    }

    // Stamped verified-by-design-agent at the moment of derivation: this
    // template was just read out of the site's REAL repo by a live-site
    // analysis session (live-analysis-handler.js), which is exactly the
    // grounding the gate in generateDraft is asking for. `jobId` is the evidence trail — null for
    // the inline (non-job) path, which is fine; the stamp's value is
    // `verifiedBy`, and `verifiedRef` is supporting detail.
    accepted.push({
      actionType,
      componentKey,
      template: stampTemplateVerification(derived, {
        verifiedBy: TEMPLATE_VERIFIED_BY.DESIGN_AGENT,
        verifiedRef: jobId,
      }),
    });
  }

  if (!accepted.length) return { ok: false, saved: {}, rejected };

  const urlFileMap = {
    ...site.url_file_map,
    siteRoot: {
      ...site.url_file_map?.siteRoot,
      componentTemplates: {
        ...site.url_file_map?.siteRoot?.componentTemplates,
        ...Object.fromEntries(accepted.map((a) => [a.componentKey, a.template])),
      },
    },
  };
  await saveConfig({ siteId: site.id, urlFileMap });

  for (const { actionType, componentKey } of accepted) {
    await recordAudit(systemActorReq(site.id), {
      action: 'tenant.component_template_auto_created',
      targetType: 'site',
      targetId: String(site.id),
      tenantSiteId: site.id,
      tenantName: site.name,
      metadata: { actionType, componentKey, source: 'design-agent-auto', verifiedBy: TEMPLATE_VERIFIED_BY.DESIGN_AGENT, jobId },
      success: true,
    });
  }

  return {
    ok: true,
    saved: Object.fromEntries(accepted.map((a) => [a.actionType, a.template])),
    rejected,
  };
}

// The find-or-create entry point every draft-generation/apply call site
// should use instead of reading site.url_file_map.siteRoot.componentTemplates
// directly: returns the site's real template if one is already configured
// (the fast path — true for every recommendation after the first, on any
// given site+actionType), or derives one from the site's real repo via the
// Design Agent and saves it — with no staff button, manual "seed" step, or
// human confirmation of any kind. This is the ONLY path that creates or
// verifies a componentTemplate in production; there is no separate
// staff-triggered inspection UI to keep in sync with it.
//
// Never throws and never blocks the caller on a Design Agent failure —
// `ok: false` (site.auto_remediation_enabled off, no repo configured, the
// OpenHands session itself failing, or an invalid derived template) means
// "nothing to use," and every caller of this function already has its own
// safe, zero-config fallback (marker-merge.js's DEFAULT_* templates,
// newpage-render.js's plain-markdown output) for exactly this case — a
// site that hasn't been through the one-time auto-remediation review (or
// can't currently reach the Design Agent) keeps working exactly as it did
// before this function existed.
// How long the cron/auto-remediation path (waitForCompletion: true) will sit
// polling a freshly-queued design-profile derivation before giving up and
// falling back to the ordinary "queued, unblocks on its own" result. Bounded
// well under the worker's own bounded-retry budget in worker.js — this is a
// same-pass convenience (let today's 07:00 run actually ship a PR instead of
// only unblocking tomorrow's), not a substitute for that retry logic. Never
// applied to the interactive HTTP path (routes/action-center.js's ordinary
// generateDraft callers) — a user's own click should fail fast, not hang.
const DESIGN_AGENT_WAIT_MS = Number(process.env.DESIGN_AGENT_WAIT_MS) || 15 * 60 * 1000;
const DESIGN_AGENT_POLL_INTERVAL_MS = 5000;

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function resolveOrCreateComponentTemplate(site, actionType, {
  saveConfig = updateSiteRepoConfig,
  recordAudit = recordAuditEvent,
  recordFixOutcomeFn = recordFixOutcome,
  enqueueDerivation = createComponentTemplateJob,
  findQueuedDerivation = getQueuedComponentTemplateJob,
  enqueueProfileDerivation = createDesignProfileJob,
  latestDesignAgentJob = getLatestDesignAgentJob,
  // waitForCompletion: only the cron/auto-remediation path sets this true
  // (via generateDraft's waitForDesignAgent option) — see the constant above.
  waitForCompletion = false,
  pollJobStatus = getDesignAgentJobById,
  refetchSite = getSiteById,
  sleep = defaultSleep,
  waitBudgetMs = DESIGN_AGENT_WAIT_MS,
  // Injected only so the self-heal below is testable without a network — the
  // defaults are checkTemplateFreshness's own.
  fetchPage,
  fetchStylesheet,
} = {}) {
  const componentKey = COMPONENT_TEMPLATE_KEY[actionType];
  if (!componentKey) return { ok: false, reason: 'no-concept', template: null, componentKey: null };

  const existing = site.url_file_map?.siteRoot?.componentTemplates?.[componentKey];

  // The fast path now requires the template to be VERIFIED, not merely to
  // exist. That distinction is the whole bug this branch shipped with: an
  // existing-but-unstamped template returned ok:true here, which meant the
  // Design Agent was never invoked to re-derive it — and only a fresh
  // derivation stamps verifiedBy. The generateDraft gate directly downstream
  // then rejected that same template with a 422, permanently, with no
  // autonomous way out. Confirmed live: all four templates on the only
  // repo-connected site were in exactly this state, blocking every faq /
  // qa-content / expand-content / internal-links draft, escapable only by
  // running `npm run verify-component-templates` by hand — precisely the
  // human-confirmation dependency f7156ef set out to remove.
  if (existing && isTemplateVerified(actionType, existing).ok) {
    return { ok: true, template: existing, source: 'existing', componentKey };
  }

  // SELF-HEAL AN UNSTAMPED TEMPLATE BEFORE RE-DERIVING ANYTHING.
  //
  // The fast path above requires a stamp, and correctly so. But "no stamp"
  // and "wrong markup" are different problems with wildly different costs,
  // and the code above conflated them: it sent a template that was merely
  // unstamped down the same path as one that was genuinely broken — an
  // OpenHands container job, or a design-profile projection that overwrites
  // real repo-derived markup with a composed approximation.
  //
  // Site 1's faq, qaContent and internalLinks templates were all in exactly
  // this state: real markup captured from the repo, every class live in the
  // shipped CSS, blocked only for want of a stamp. The honest repair is to
  // check, and stamp what passes.
  //
  // Deliberately NOT gated on auto_remediation_enabled or on a connected
  // repo: this is one page fetch against the public site, not a repo
  // analysis. A tenant who hasn't been through the auto-remediation review
  // still gets their existing templates verified, which is the whole point
  // — it removes a human step rather than relocating it.
  if (existing?.wrapper && isTemplateVerified(actionType, existing).reason === 'unverified') {
    const verified = await verifyTemplateAgainstLiveSite(actionType, existing, {
      pageUrl: sitePageUrl(site), fetchPage, fetchStylesheet,
    }).catch((err) => ({ ok: false, reason: 'unreachable', error: err.message }));

    if (verified.ok) {
      const urlFileMap = {
        ...site.url_file_map,
        siteRoot: {
          ...site.url_file_map?.siteRoot,
          componentTemplates: { ...site.url_file_map?.siteRoot?.componentTemplates, [componentKey]: verified.stamped },
        },
      };
      await saveConfig({ siteId: site.id, urlFileMap });
      await recordAudit(systemActorReq(site.id), {
        action: 'tenant.component_template_freshness_verified',
        targetType: 'site',
        targetId: String(site.id),
        tenantSiteId: site.id,
        tenantName: site.name,
        metadata: { actionType, componentKey, checkedClasses: verified.checkedClasses?.length ?? 0 },
        success: true,
      }).catch(() => {});
      return { ok: true, template: verified.stamped, source: 'freshness-check', componentKey };
    }

    // Any other outcome falls through to the existing logic below exactly as
    // it always has — this self-heal is purely an early optimization in front
    // of it, not a new gate. In particular 'unreachable' (a network blip
    // fetching the LIVE page) says nothing about whether a cheap
    // design-profile projection can succeed just below, so it must not block
    // that path — only the expensive container-derivation path further down
    // was ever meant to wait for real evidence, and that path already re-runs
    // on every unverified template regardless of reason, same as before this
    // self-heal existed.
  }

  // Eligibility used to also require auto_remediation_enabled ("the same
  // real-repo-edit/PR consent... a repo-connected site becomes eligible the
  // moment that one review has happened"). The design-integrity gate
  // inverted the dependency it relied on: auto_remediation_enabled can no
  // longer become true until the design HAS been reviewed (routes/
  // clients.js's validateAutoRemediationRequest), and there is nothing to
  // review until a profile has been resolved/derived at least once — so
  // requiring it here made this permanently unreachable pre-review,
  // deadlocked on itself. Composing or deriving a template is read-only; it
  // never needed shipping consent. What DOES still require that consent —
  // actually splicing the resulting markup into a real PR — is gated
  // directly at apply time (designReviewState, backend.js/frontend.js), not
  // here. A connected repo is still required: self-heal/derivation below
  // both read/write real repo state.
  if (!site.repo_owner || !site.repo_name) {
    return { ok: false, reason: 'not-available', template: null, componentKey };
  }

  // PROJECT FROM THE SITE'S DESIGN LANGUAGE FIRST.
  //
  // This is the architecture: the design profile is the source and component
  // templates are projections of it, so a site that already knows its own
  // design language never needs another repo analysis to gain a new
  // design-sensitive content type — it composes one instantly, in the site's
  // real typography/spacing/component conventions, from knowledge it already
  // has. That is also what stops two generators on the same site presenting
  // content in two different visual languages.
  //
  // Runs BEFORE the queue/derive paths below because it is both cheaper (pure
  // string composition, no container) and better grounded (the whole site,
  // not one block re-read in isolation).
  const profile = getDesignProfile(site);
  if (isProjectable(actionType) && isProfileUsable(profile)) {
    const projected = projectComponentTemplate(profile, actionType);
    // Re-validated against the same placeholder contract a Design-Agent-derived
    // template must satisfy — a projection is not trusted just because it was
    // composed locally.
    if (projected && validatePlaceholders(actionType, projected).ok) {
      // NEVER STAMP A PROJECTION WITHOUT LIVE EVIDENCE WHEN A LIVE URL EXISTS.
      //
      // A projection composes from designProfile fields the Design Agent
      // recorded, and those can go stale exactly like repo-derived markup
      // does — or worse, describe a class the site's CSS pipeline never
      // shipped in the first place. Concretely: zunkireelabs.com's profile
      // would record layout.prose as `prose prose-lg prose-gray max-w-none`
      // (read straight off blog-post.njk/glossary-term.njk), but
      // @tailwindcss/typography is not installed there, so .prose* ships
      // zero rules. Stamping that unconditionally would "unblock" a
      // contentWrapper recommendation with a wrapper that renders invisibly
      // — worse than staying blocked, since it looks fixed.
      //
      // So a projection with a live page to check against is checked, same as
      // an existing template above. Three outcomes:
      //   - passes as-is: stamp FRESHNESS_CHECK, the strongest evidence.
      //   - some classes are missing: filter them out and re-check what
      //     remains — this is fidelity, not a downgrade, since those same
      //     classes have no effect on the real site's own live pages either.
      //   - genuinely unreachable (no live URL, or a network blip): fall back
      //     to the old unconditional DESIGN_AGENT stamp, since that is still
      //     strictly better evidence than nothing for a site we cannot check.
      let finalTemplate = projected;
      let verifiedBy = TEMPLATE_VERIFIED_BY.DESIGN_AGENT;
      let verifiedRef = profile.derivedRef ?? null;
      let droppedClasses;

      const pageUrl = sitePageUrl(site);
      if (pageUrl) {
        const checked = await verifyTemplateAgainstLiveSite(actionType, projected, { pageUrl, fetchPage, fetchStylesheet })
          .catch((err) => ({ ok: false, reason: 'unreachable', error: err.message }));

        if (checked.ok) {
          finalTemplate = checked.stamped;
          verifiedBy = null; // already stamped by verifyTemplateAgainstLiveSite
        } else if (checked.reason === 'stale') {
          // checked.css is the exact concatenated stylesheet text
          // checkTemplateFreshness already fetched for this check — reused
          // here rather than re-fetched, since it is the same page.
          const filtered = filterTemplateToLiveClasses(projected, checked.css || '');
          const reChecked = validatePlaceholders(actionType, filtered.template).ok
            ? await verifyTemplateAgainstLiveSite(actionType, filtered.template, { pageUrl, fetchPage, fetchStylesheet })
                .catch(() => ({ ok: false }))
            : { ok: false };
          if (reChecked.ok) {
            finalTemplate = reChecked.stamped;
            verifiedBy = null;
            droppedClasses = filtered.dropped;
          }
          // If even the filtered version doesn't verify (e.g. every class was
          // stripped and validatePlaceholders now fails, or the CSS fetch
          // itself failed), finalTemplate/verifiedBy/verifiedRef stay at
          // their DESIGN_AGENT defaults above — still a projection, just
          // without a live-evidence upgrade.
        }
        // 'unreachable' and 'invalid-placeholders' both fall through to the
        // DESIGN_AGENT defaults untouched — this branch already re-validated
        // placeholders before verifying, so 'invalid-placeholders' here would
        // only mean the LIVE check disagreed, which should never happen.
        //
        // 'body-slot-is-label' is the one verdict that must NOT fall through.
        // Every other failure here means "we could not confirm this template",
        // and the DESIGN_AGENT default is defensible for those. This one means
        // the opposite — we DID confirm it, and it is wrong: the body slot
        // carries the site's eyebrow/kicker styling, so generated prose ships
        // as a caption. Falling through stamped it `verifiedBy: design-agent`
        // anyway, which is exactly how the original incident's five templates
        // came to be marked verified while rendering every paragraph wrong.
        // The defect is in the PROFILE (typography.body is a label class), not
        // in this projection, so re-deriving the profile is the real repair —
        // and correctBodyTypography now rejects a label-styled body pick.
        if (checked.reason === 'body-slot-is-label') {
          const alreadyQueued = await findQueuedDerivation(site.id, DESIGN_PROFILE_JOB_KEY).catch(() => null);
          if (!alreadyQueued) {
            await enqueueProfileDerivation(site.id, { requestedBy: null, pageUrl }).catch((err) => {
              console.error(`[design-drift] could not queue design-profile re-derivation for site ${site.id}:`, err.message);
            });
          }
          return {
            ok: false,
            reason: 'body-slot-is-label',
            detail: `This site's design profile describes its body text with a class the live CSS defines as a label, `
              + `so a generated "${actionType}" block would render as a caption rather than prose. ${checked.error} `
              + 'The Design Agent has been queued to re-derive the site\'s typography; this stays blocked until it does, '
              + 'deliberately — shipping no block is recoverable, shipping every paragraph as a label is not.',
            template: null,
            componentKey,
          };
        }
      }

      const stamped = verifiedBy
        ? stampTemplateVerification(finalTemplate, { verifiedBy, verifiedRef })
        : finalTemplate;
      if (droppedClasses?.length) {
        stamped.droppedClasses = droppedClasses; // audit trail only — inert to every reader, same as verifiedBy/verifiedRef
      }
      const urlFileMap = {
        ...site.url_file_map,
        siteRoot: {
          ...site.url_file_map?.siteRoot,
          componentTemplates: { ...site.url_file_map?.siteRoot?.componentTemplates, [componentKey]: stamped },
        },
      };
      await saveConfig({ siteId: site.id, urlFileMap });
      await recordAudit(systemActorReq(site.id), {
        action: 'tenant.component_template_projected',
        targetType: 'site',
        targetId: String(site.id),
        tenantSiteId: site.id,
        tenantName: site.name,
        metadata: { actionType, componentKey, from: 'design-profile', verifiedBy: stamped.verifiedBy, droppedClasses: droppedClasses?.length ?? 0 },
        success: true,
      }).catch(() => {});
      return { ok: true, template: stamped, source: 'design-profile', componentKey, justCreated: true };
    }
  }

  // No usable design profile yet — derive the SITE'S design language rather
  // than this one component's markup. One queued job now yields every
  // projectable template at once (persistDesignProfile projects them all),
  // instead of one queued job per content type each re-reading the same repo.
  if (!isProfileUsable(profile)) {
    const queuedProfile = await findQueuedDerivation(site.id, DESIGN_PROFILE_JOB_KEY).catch(() => null);
    let enqueueError = null;
    let freshlyQueued = null;
    if (!queuedProfile) {
      freshlyQueued = await enqueueProfileDerivation(site.id, { requestedBy: null, pageUrl: sitePageUrl(site) }).catch((err) => {
        enqueueError = err;
        console.error(`[design-drift] could not queue design-profile derivation for site ${site.id}:`, err.message);
        return null;
      });
    }

    // Same-pass wait: the cron/auto-remediation path would otherwise queue
    // this job and then immediately fail the draft anyway, only to retry
    // (successfully) on tomorrow's run. Poll the job we just found or
    // created up to waitBudgetMs; if it finishes in time, refetch the site
    // (the profile lives in url_file_map, saved by the worker via saveConfig
    // — this in-memory `site` is now stale) and retry ONCE with
    // waitForCompletion off, so a second derivation can never be queued and
    // this can never loop.
    const jobToAwait = queuedProfile || freshlyQueued;
    if (waitForCompletion && jobToAwait?.id && !enqueueError) {
      const deadline = Date.now() + waitBudgetMs;
      let finished = null;
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        const job = await pollJobStatus(jobToAwait.id).catch(() => null);
        if (job && job.status !== 'queued' && job.status !== 'executing') {
          finished = job;
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(DESIGN_AGENT_POLL_INTERVAL_MS);
      }
      if (finished?.status === 'completed') {
        const freshSite = await refetchSite(site.id).catch(() => null);
        if (freshSite) {
          return resolveOrCreateComponentTemplate(freshSite, actionType, {
            saveConfig, recordAudit, recordFixOutcomeFn, enqueueDerivation, findQueuedDerivation,
            enqueueProfileDerivation, latestDesignAgentJob, waitForCompletion: false,
            pollJobStatus, refetchSite, sleep, waitBudgetMs, fetchPage, fetchStylesheet,
          });
        }
      }
      // Failed, timed out, or the refetch itself failed — fall through to the
      // ordinary messaging below exactly as the non-waiting path would.
    }

    // The "no action needed, will unblock automatically" claim below used to
    // fire unconditionally — including when the queue insert above just
    // failed, or when nothing has actually been re-queued since a PRIOR
    // attempt failed (no queued/executing row exists, so this same branch
    // re-runs on every check, but a transient failure between here and the
    // worker claiming the job could still leave nothing pending). Surface
    // that honestly instead of repeating a claim that's stopped being true.
    if (enqueueError) {
      const { message, id } = safeMessage('design-drift.projectComponentTemplate', enqueueError, 'queuing the Design Agent to learn it just failed');
      return {
        ok: false,
        reason: 'derivation-queue-failed',
        detail: `This site's design language has not been derived yet, and ${message} (ref ${id}). This needs an `
          + 'engineer to check the system logs — it will not resolve on its own.',
        template: null,
        componentKey,
      };
    }
    if (!queuedProfile) {
      const latest = await latestDesignAgentJob(site.id, DESIGN_PROFILE_JOB_KEY).catch(() => null);
      if (latest?.status === 'failed') {
        return {
          ok: false,
          reason: 'derivation-retry-queued',
          detail: `The Design Agent's last attempt to learn this site's design failed (job #${latest.id}, `
            + `${latest.finished_at}). A fresh attempt has just been queued — if this keeps failing, an engineer `
            + 'needs to check the worker logs rather than waiting on it again.',
          template: null,
          componentKey,
        };
      }
    }
    return {
      ok: false,
      reason: 'derivation-queued',
      detail: 'This site\'s design language has not been derived yet. The Design Agent has been queued to analyse the '
        + 'site and learn its typography, spacing and component conventions — every design-sensitive template is built '
        + 'from that in one pass.',
      template: null,
      componentKey,
    };
  }

  // A component key that is not yet projectable (none today — the projectable
  // set and COMPONENT_TEMPLATE_KEY are currently identical) would land here
  // with a usable profile. Queue a per-type derivation for it rather than
  // silently returning nothing, so adding a future component key that the
  // projector doesn't understand yet degrades to the old behaviour instead of
  // breaking.
  const queued = await findQueuedDerivation(site.id, actionType).catch(() => null);
  if (!queued) {
    await enqueueDerivation(site.id, [actionType], { requestedBy: null, pageUrl: sitePageUrl(site) }).catch((err) => {
      console.error(`[design-drift] could not queue derivation for site ${site.id}/${actionType}:`, err.message);
    });
  }
  return {
    ok: false,
    reason: 'derivation-queued',
    detail: `This site's "${actionType}" template cannot be composed from its design profile yet. The Design Agent has been queued to derive it.`,
    template: null,
    componentKey,
  };
}

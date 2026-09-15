import { buildMergeValues } from '../../implementers/lib/marker-merge.js';

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

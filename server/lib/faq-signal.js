import { stripManagedMarkers } from './managed-markers.js';

// Cheap regex/structural evidence that a page already has a real, organic
// (non tool-managed) FAQ/Q&A block — used to decide whether a generator may
// safely fabricate FAQ content, or must refuse rather than risk drafting a
// SECOND, possibly mismatched FAQ over one a human/template already
// authored (real incident, 2026-08-25: zunkireelabs.com's /resources/ page
// already renders a genuine {% for item in faq %} accordion from real site
// data, but faq.js/qa-content.js had no way to notice and both drafted
// their own, different, LLM-fabricated Q&A content for the same page).
//
// Deliberately a smaller, unscored version of implementers/lib/render-
// inspector.js's scanVisibleFaqSignals/hasVisibleFaqSignal (which serve a
// different purpose — deciding a draft's visible-vs-schema-only RENDER MODE
// against a template file already known to be this tool's own target, with
// a full confidence-scored evidence trail). This one is used by generators
// deciding whether to draft AT ALL, against a page/template they don't yet
// own a marker on, so it only needs a plain boolean — not a duplicate of
// that module's scoring; kept as two small, independently-understandable
// checks rather than one shared abstraction spanning generators and
// implementers, which this codebase doesn't otherwise cross.
const LOOP_QA_PATTERNS = [
  /\{%\s*for\s+\w+\s+in\s+\w*faq\w*\s*%\}/i, // Nunjucks: {% for item in faq %}
  /\.map\(\s*\(?[\w,\s]*\)?\s*=>[\s\S]{0,200}?\.question[\s\S]{0,200}?\.answer/i, // React/JS .map with .question/.answer
  /v-for\s*=\s*"[^"]*"[\s\S]{0,300}?\{\{\s*\w*\.?question/i, // Vue v-for near {{ x.question }}
];
const ACCORDION_KEYWORD_PATTERN = /accordion|faq-item|faqitem|expandAll|activeIndex/i;
const FAQ_TEXT_PATTERN = /frequently asked questions|\bfaqs?\b/i;

export function hasOrganicFaqSignal(text) {
  const organic = stripManagedMarkers(text || '');
  return LOOP_QA_PATTERNS.some((re) => re.test(organic)) ||
    (ACCORDION_KEYWORD_PATTERN.test(organic) && FAQ_TEXT_PATTERN.test(organic));
}

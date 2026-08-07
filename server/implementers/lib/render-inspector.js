import { callLLM } from '../../llm.js';
import { safeMessage } from '../../lib/errors.js';

// Deterministic-first, fully autonomous render-mode inspection: replaces the
// old static url_file_map.pages[url].render config as the source of truth
// for visible-vs-schema-only. Cheap regex/structural evidence is tried first
// and short-circuits whenever it's decisive; a sitewide visible-FAQ cap
// (visibleFaqCount/visibleFaqCap, see countVisibleFaqPages in
// server/store/drafts.js — tool-injected count PLUS the site's organic
// baseline, migration 074) is checked next, since visible FAQ blocks are
// meant to stay selective across a site rather than appear on every eligible
// page; only genuinely ambiguous evidence under an unfilled cap reaches the
// LLM, which decides the mode directly. This module never stops to ask a
// human for a policy judgment call — the one remaining escalation
// (render-mode-uncertain, confidence 0) is reserved for a real LLM/infra
// failure, not ambiguity.

// Only content types with more than one real representation have a mode
// decision to make at all — see lib/marker-merge.js's buildMergeValues:
// schema is inherently schema-only always, meta-title/internal-links have no
// schema fragment. Adding a future dual-representation type is a one-line
// addition here.
export const INSPECTABLE_ACTION_TYPES = ['faq'];

export const CONFIDENCE_THRESHOLD = 70;

// Signal B below (a templating loop rendering .question/.answer fields) is
// deliberately weighted higher than a literal "FAQ" text match — a page can
// have a real Q&A rendering mechanism under a creative, non-"FAQ" heading
// (seen in production: "Get to know Zunkiree"), and a literal "FAQ" mention
// can just as easily be a nav link to a different page. Specific rendering
// evidence beats a keyword match.
const LOOP_QA_PATTERNS = [
  /\{%\s*for\s+\w+\s+in\s+\w*faq\w*\s*%\}/i, // Nunjucks: {% for item in faq %}
  /\.map\(\s*\(?[\w,\s]*\)?\s*=>[\s\S]{0,200}?\.question[\s\S]{0,200}?\.answer/i, // React/JS .map with .question/.answer
  /v-for\s*=\s*"[^"]*"[\s\S]{0,300}?\{\{\s*\w*\.?question/i, // Vue v-for near {{ x.question }}
];
const ACCORDION_KEYWORD_PATTERN = /accordion|faq-item|faqitem|expandAll|activeIndex/i;
const FAQ_TEXT_PATTERN = /frequently asked questions|\bfaqs?\b/i;
const FAQ_SCHEMA_PATTERN = /"@type"\s*:\s*"FAQPage"/i;

function hasLoopQaPattern(fileContent) {
  return LOOP_QA_PATTERNS.some((re) => re.test(fileContent));
}

// Regex/structural evidence only — no LLM, no cost, instant. Returns a
// strength bucket plus the human-readable evidence that produced it, so a
// resulting decision can always cite what it actually saw.
//
// 'strong' (skips the LLM entirely, 95% confidence) is reserved for signals
// that are structurally unambiguous on their own: a real templating loop
// rendering question/answer fields, or an existing FAQPage schema block.
// Generic signals (an "accordion" keyword, a lone "FAQ" text mention) never
// combine into 'strong' by themselves — two weak, non-specific signals
// stacking up is not the same as one piece of real structural evidence, and
// letting them combine skipped the LLM sanity check on exactly the pages
// that needed it most (an unrelated accordion component + an incidental
// "FAQ" mention elsewhere on the page). Anything short of that always goes
// through llmAssistedInspection below, never auto-decided from a keyword
// count alone.
export function scanVisibleFaqSignals(fileContent) {
  const evidence = [];
  let score = 0;
  const hasLoopQa = hasLoopQaPattern(fileContent);
  const hasSchema = FAQ_SCHEMA_PATTERN.test(fileContent);
  if (hasLoopQa) {
    score += 2;
    evidence.push('a templating loop renders question/answer fields (e.g. "{% for item in faq %}" or .map with .question/.answer)');
  }
  if (ACCORDION_KEYWORD_PATTERN.test(fileContent)) {
    score += 1;
    evidence.push('accordion/expand-related component keywords found (accordion, expandAll, activeIndex, faq-item)');
  }
  if (FAQ_TEXT_PATTERN.test(fileContent)) {
    score += 1;
    evidence.push('the text "FAQ" or "Frequently Asked Questions" appears in the file');
  }
  if (hasSchema) {
    score += 1;
    evidence.push('an existing FAQPage JSON-LD schema block is already present');
  }
  const strength = (hasLoopQa || hasSchema) ? 'strong' : score >= 1 ? 'weak' : 'none';
  return { strength, score, evidence };
}

export function hasExistingFaqSchema(fileContent) {
  return FAQ_SCHEMA_PATTERN.test(fileContent);
}

// Narrower than scanVisibleFaqSignals' 'strong' bucket on purpose: that
// bucket also fires on schema-only presence (correctly — duplicating a
// schema-only page still shouldn't get a second visible block), but the
// "Recalculate FAQ baseline" action (routes/clients.js) needs to count only
// pages with a genuinely VISIBLE, human-readable FAQ already on them, not
// ones that merely publish FAQPage JSON-LD with no on-page rendering.
// Managed SEOAI markers are stripped first for the same reason
// scanVisibleFaqSignals does — this tool's own empty markers must never
// count as "already has a visible FAQ".
export function hasVisibleFaqSignal(fileContent) {
  const organicContent = stripManagedMarkers(fileContent);
  return hasLoopQaPattern(organicContent) ||
    (ACCORDION_KEYWORD_PATTERN.test(organicContent) && FAQ_TEXT_PATTERN.test(organicContent));
}

// The Action Center's own SEOAI marker comments are infrastructure, not
// organic page content — an empty `<!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END -->`
// marker literally contains the substring "FAQ", which would otherwise
// falsely trip scanVisibleFaqSignals' text-match signal on a page that has
// no real visible FAQ at all (confirmed in practice: /contact/ went from a
// clean 'none'/90%-confidence read to a false 'weak' escalation the moment
// its marker was added). Evidence-gathering must only ever look at what a
// human/existing component actually put on the page.
const MANAGED_MARKER_PATTERN = /<!--\s*SEOAI:\w+:START\s*-->[\s\S]*?<!--\s*SEOAI:\w+:END\s*-->|(?:#\s*SEOAI:\w+\s*|<!--\s*SEOAI:\w+\s*-->)/gi;
function stripManagedMarkers(fileContent) {
  return fileContent.replace(MANAGED_MARKER_PATTERN, '');
}

// Structural sanity only — true for the overwhelming majority of real
// files; this exists to rule out genuinely empty/broken targets, not to
// judge template quality.
export function hasSafeInsertionPoint(fileContent) {
  return typeof fileContent === 'string' && fileContent.trim().length > 0;
}

const TRUNCATE_CHARS = 8000;

// Reached only when deterministic signals are ambiguous and the sitewide cap
// isn't already exhausted. The LLM decides the mode directly (not just facts
// for a human to act on) — visible FAQ blocks are meant to stay selective
// across a site, so the model is told to err toward schema-only whenever
// it's genuinely unsure, rather than escalating. Any parse/call failure is a
// real infra problem, not a policy judgment call — that's the one case still
// allowed to stop and ask a human (confidence 0, below CONFIDENCE_THRESHOLD).
async function llmAssistedInspection(fileContent, deterministicSignals, { visibleFaqCount, visibleFaqCap }) {
  const excerpt = fileContent.slice(0, TRUNCATE_CHARS);

  const system = 'You are deciding, for one page, whether to publish a NEW VISIBLE on-page FAQ block or ' +
    'structured (schema-only, invisible) FAQ data instead. Choose "visible" only if: (a) no real visible FAQ/Q&A ' +
    'section already exists on this page — if one does, always choose "schema-only" to avoid duplicating it; and ' +
    '(b) this specific page substantively benefits from an on-page FAQ (e.g. a product/service/pricing page where ' +
    'visitors commonly have concrete questions), not a generic page where an FAQ would feel bolted on. Visible FAQ ' +
    'blocks should stay selective across a site, not appear on every page that could technically have one — err ' +
    'toward "schema-only" when genuinely unsure. Respond with ONLY JSON: ' +
    '{"mode": "visible"|"schema-only", "reasoning": "one sentence", "evidenceQuotes": ["short exact quotes, if any"]}.';
  const user = `Sitewide context: ${visibleFaqCount} of ${visibleFaqCap} allowed visible-FAQ pages already used.\n` +
    `Deterministic signals already found: ${deterministicSignals.evidence.join('; ') || 'none'}.\n\nFile excerpt:\n${excerpt}`;

  let parsed;
  try {
    const raw = await callLLM(system, user, { maxTokens: 300 });
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch (err) {
    const { message } = safeMessage('render-inspector.inspectRenderMode', err, 'Could not determine render mode automatically right now.');
    return { mode: null, confidence: 0, reason: message, source: 'llm-assisted' };
  }

  const mode = parsed.mode === 'visible' ? 'visible' : 'schema-only'; // any unexpected value defaults safe
  return {
    mode, confidence: 75,
    reason: parsed.reasoning || (mode === 'visible'
      ? 'No existing visible FAQ found; page benefits from one.'
      : 'Defaulting to schema-only — kept visible FAQs selective.'),
    source: 'llm-assisted',
  };
}

// Single entry point. Deterministic-first: a 'strong' or 'none' signal
// short-circuits with no LLM call at all. Only a 'weak'/ambiguous signal
// escalates. `fileContent` should be the SAME content the caller already
// fetched for the marker-splice step — this function never fetches on its
// own, keeping it a pure, easily-testable function of (content, actionType).
export async function inspectRenderMode(fileContent, actionType, { visibleFaqCount = 0, visibleFaqCap = Infinity } = {}) {
  if (!INSPECTABLE_ACTION_TYPES.includes(actionType)) {
    return {
      mode: 'visible', confidence: 100,
      reason: `"${actionType}" has only one representation — no mode decision to make.`,
      source: 'deterministic',
    };
  }

  const insertionPointOk = hasSafeInsertionPoint(fileContent);
  if (!insertionPointOk) {
    return {
      mode: null, confidence: 0,
      reason: 'The target file appears empty or malformed — cannot determine a safe insertion point.',
      source: 'deterministic',
    };
  }

  const organicContent = stripManagedMarkers(fileContent);
  const signals = scanVisibleFaqSignals(organicContent);

  if (signals.strength === 'strong') {
    return {
      mode: 'schema-only', confidence: 95,
      reason: `Existing visible FAQ content detected: ${signals.evidence.join('; ')}. Adding another visible FAQ block would duplicate it — publishing structured data only.`,
      source: 'deterministic',
    };
  }

  // Cap check comes before the 'none' short-circuit and before the LLM — a
  // page with no existing FAQ still doesn't get a visible one once the site
  // is already at its selective-visibility limit.
  if (visibleFaqCount >= visibleFaqCap) {
    return {
      mode: 'schema-only', confidence: 90,
      reason: `Sitewide visible-FAQ limit reached (${visibleFaqCount}/${visibleFaqCap} pages already have a visible FAQ) — publishing structured data only to keep visible FAQs selective.`,
      source: 'cap',
    };
  }

  if (signals.strength === 'none') {
    return {
      mode: 'visible', confidence: 90,
      reason: 'No existing visible FAQ content detected, and the file has a valid insertion point — safe to add a visible FAQ block.',
      source: 'deterministic',
    };
  }

  return llmAssistedInspection(organicContent, signals, { visibleFaqCount, visibleFaqCap });
}

import { callLLM } from '../../llm.js';

// Deterministic-first render-mode inspection: replaces the old static
// url_file_map.pages[url].render config as the source of truth for
// visible-vs-schema-only. Cheap regex/structural evidence is tried first and
// short-circuits whenever it's decisive; the LLM is only ever consulted when
// that evidence is genuinely ambiguous, and even then it reports FACTS
// (hasVisibleFaqSection/evidenceQuotes/hasSafeInsertionPoint), never a mode
// directly — this module is the one place that turns evidence into a
// decision, whichever pass produced the evidence.

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

// Reached only when deterministic signals are ambiguous. Asks the LLM to
// report observations, not a decision — this function (not the model) turns
// those observations into a mode, exactly like the deterministic path above
// does with regex evidence. A resolved-but-escalated result is capped below
// a pure deterministic one; reaching this path is itself evidence of real
// ambiguity. Any parse/call failure is treated as confidence 0, never a crash.
async function llmAssistedInspection(fileContent, deterministicSignals) {
  const excerpt = fileContent.slice(0, TRUNCATE_CHARS);
  const truncated = fileContent.length > TRUNCATE_CHARS;

  const system = 'You are examining a website template file to gather FACTS, not to make a decision. ' +
    'A deterministic scan already found weak/ambiguous signals (e.g. the word "FAQ"/"FAQs" appearing somewhere, ' +
    'or generic accordion-related keywords) and could not confidently classify the page — those signals alone ' +
    'are NOT proof of a real FAQ section. Distinguish carefully: (a) a REAL, VISIBLE FAQ section — multiple ' +
    'question/answer pairs actually presented to site visitors as an FAQ or Q&A block — versus (b) any ' +
    'INCIDENTAL use of the word "FAQ"/"FAQs" in unrelated prose, a statistic, a nav link label, or a single ' +
    'passing sentence that is not itself a Q&A section. Only report hasVisibleFaqSection: true for case (a). If ' +
    'you report true, evidenceQuotes MUST be the actual visible question text(s) from a real Q&A section — if ' +
    'you cannot quote at least one genuine question a visitor would see and read as part of an FAQ, report ' +
    'hasVisibleFaqSection: false instead, even if the word "FAQ" appears elsewhere in the file.' +
    (truncated ? ' This excerpt may be truncated — if you cannot rule out something existing beyond it, say "unsure".' : '') +
    ' Respond with ONLY JSON: {"hasVisibleFaqSection": true|false|"unsure", "evidenceQuotes": ["short exact quotes"], "hasSafeInsertionPoint": true|false}.';
  const user = `Deterministic signals already found: ${deterministicSignals.evidence.join('; ') || 'none'}.\n\nFile excerpt:\n${excerpt}`;

  let parsed;
  try {
    const raw = await callLLM(system, user, { maxTokens: 400 });
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch (err) {
    return {
      mode: null, confidence: 0,
      reason: `Could not determine render mode automatically (analysis failed: ${err.message}).`,
      source: 'llm-assisted',
    };
  }

  if (parsed.hasVisibleFaqSection === true) {
    return {
      mode: 'schema-only', confidence: 80,
      reason: `Existing visible FAQ content found on closer review: ${(parsed.evidenceQuotes || []).join('; ') || 'see file'}.`,
      source: 'llm-assisted',
    };
  }
  if (parsed.hasVisibleFaqSection === false && parsed.hasSafeInsertionPoint) {
    return {
      mode: 'visible', confidence: 78,
      reason: 'No visible FAQ content found on closer review, and a safe insertion point exists.',
      source: 'llm-assisted',
    };
  }
  return {
    mode: null, confidence: 45,
    reason: `Could not confidently determine whether this page already has a visible FAQ section (deterministic signals: ${deterministicSignals.evidence.join('; ') || 'none'}). Manual confirmation required.`,
    source: 'llm-assisted',
  };
}

// Single entry point. Deterministic-first: a 'strong' or 'none' signal
// short-circuits with no LLM call at all. Only a 'weak'/ambiguous signal
// escalates. `fileContent` should be the SAME content the caller already
// fetched for the marker-splice step — this function never fetches on its
// own, keeping it a pure, easily-testable function of (content, actionType).
export async function inspectRenderMode(fileContent, actionType) {
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

  if (signals.strength === 'none') {
    return {
      mode: 'visible', confidence: 90,
      reason: 'No existing visible FAQ content detected, and the file has a valid insertion point — safe to add a visible FAQ block.',
      source: 'deterministic',
    };
  }

  return llmAssistedInspection(organicContent, signals);
}

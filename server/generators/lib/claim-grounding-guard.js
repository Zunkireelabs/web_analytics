// Catches an LLM inventing a specific pricing/scale/award/experience claim
// in a creative-draft generator (landing-page.js first; see
// CLAIM_GROUNDED_GENERATOR_IDS in quality-gate.js for the current scope)
// that isn't backed by anything in `content.groundingContext` — the exact
// "Supporting data" string the generator actually gave the model (see
// landing-page.js's `user` prompt construction). The generator's system
// prompt already instructs the model not to invent such claims, but that's
// trust-the-model, not enforced — same gap legal-fact-guard.js already
// closed for the three legal generators, applied here to the "pricing,
// awards, client counts" category landing-page.js's own prompt explicitly
// warns about but never checks for.
//
// Same conservative-toward-false-positives posture as legal-fact-guard.js:
// a claim that's actually real but phrased differently than the context
// text stays open for a human glance — no different from any other Quality
// Gate failure — which is the safe failure direction. A missed fabrication
// shipping unattended is the real risk.
//
// Each issue carries a `correction` (design-repair-feedback.js's contract),
// so a failure here routes into the SAME generate -> verify -> diagnose ->
// regenerate-with-feedback -> verify-again loop every other correctable
// Quality Gate issue already uses (routes/action-center.js's
// MAX_GENERATION_ATTEMPTS retry) — not a new mechanism, just a new
// participant in the existing one. Only a claim that survives every attempt
// stays unresolved, at which point the existing "could not be generated
// cleanly after N attempts" refusal is the escalation — the draft stays
// open for a human, it is never silently shipped.

// A specific number attached to a scale/experience/social-proof word —
// the shape a fabricated "500+ clients" or "15 years of experience" claim
// takes. Captures the number itself so it can be checked against context
// independently of exact phrasing (a real claim rephrased slightly should
// not false-positive).
const SCALE_CLAIM_RE = /\b(\d[\d,]*)\+?\s*(years?|clients?|customers?|businesses|companies|projects?|reviews?|five-star|awards?)\b/gi;

// A dollar/currency amount — pricing is explicitly named in landing-page.js's
// own prompt as a fabrication-risk category.
const PRICE_CLAIM_RE = /\$\s?[\d,]+(?:\.\d+)?/g;

// A bare percentage claim ("40% faster", "99% satisfaction").
const PERCENT_CLAIM_RE = /\b\d{1,3}%/g;

// Superlative/authority phrases an LLM reaches for as generic filler when it
// has no real differentiator to write about — none of these have a "the
// number was right but phrased differently" escape hatch the way a scale
// claim does, so an exact substring match against context is the correct
// bar (not loose), and any of these NOT present verbatim in the real
// context is worth a human glance.
const SUPERLATIVE_PHRASES = [
  'award-winning', 'industry-leading', 'industry leading', 'best-in-class', 'best in class',
  '#1', 'number one', 'top-rated', 'top rated', 'market leader', 'market-leading',
  'official partner', 'certified partner', 'trusted by', 'as seen on', 'featured in',
];

function sectionText(content) {
  const parts = [content?.headline, content?.subheadline, ...(content?.sections || []).flatMap((s) => [s?.heading, s?.body])];
  return parts.filter(Boolean).join('\n');
}

export function findUngroundedClaims(content) {
  const issues = [];
  if (!content || typeof content !== 'object') return issues;
  const text = sectionText(content);
  if (!text) return issues;
  const context = (content.groundingContext || '').toLowerCase();

  const seenNumbers = new Set();
  for (const match of text.matchAll(SCALE_CLAIM_RE)) {
    const [full, rawNumber, unit] = match;
    const number = rawNumber.replace(/,/g, '');
    const key = `${number}:${unit.toLowerCase()}`;
    if (seenNumbers.has(key)) continue;
    seenNumbers.add(key);
    if (context.includes(number)) continue;
    issues.push({
      path: 'content', patternId: 'ungrounded-claim',
      detail: `"${full.trim()}" is a specific claim not present in the supporting data this draft was given`,
      correction: `Remove or rewrite "${full.trim()}" — this specific ${unit} figure isn't in the supporting data you were given. Only state a number if it's present in that data; otherwise write generally (e.g. "years of experience" instead of a made-up figure) or omit the claim entirely.`,
    });
  }

  for (const match of new Set((text.match(PRICE_CLAIM_RE) || []))) {
    if (context.includes(match.toLowerCase())) continue;
    issues.push({
      path: 'content', patternId: 'ungrounded-claim',
      detail: `Pricing claim "${match}" is not present in the supporting data this draft was given`,
      correction: `Remove the pricing claim "${match}" — no price was given in the supporting data. Never invent a price; omit pricing from this draft entirely unless a real figure was provided.`,
    });
  }

  for (const match of new Set((text.match(PERCENT_CLAIM_RE) || []))) {
    if (context.includes(match)) continue;
    issues.push({
      path: 'content', patternId: 'ungrounded-claim',
      detail: `"${match}" is a specific statistic not present in the supporting data this draft was given`,
      correction: `Remove or rewrite the "${match}" statistic — it isn't backed by the supporting data you were given. Only state a percentage if it's present in that data.`,
    });
  }

  const lowerText = text.toLowerCase();
  for (const phrase of SUPERLATIVE_PHRASES) {
    if (!lowerText.includes(phrase)) continue;
    if (context.includes(phrase)) continue;
    issues.push({
      path: 'content', patternId: 'ungrounded-claim',
      detail: `"${phrase}" is an authority/superlative claim not present in the supporting data this draft was given`,
      correction: `Remove the claim "${phrase}" — it isn't backed by anything in the supporting data you were given. Don't reach for a generic authority phrase (award-winning, industry-leading, #1, trusted by, etc.) unless the supporting data actually says so; write about a real, given differentiator instead, or omit the claim.`,
    });
  }

  return issues;
}

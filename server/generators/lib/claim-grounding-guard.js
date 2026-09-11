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

// First-person/possessive language a sentence uses when a claim is FRAMED
// AS being about the author's own business, as opposed to general industry
// commentary a blog post is explicitly allowed to write from general
// knowledge (blog-outline.js's own prompt: "General topic knowledge not
// specific to this business is fine to write from"). "we've helped 70% of
// our clients..." is a claim about THIS business specifically. A number
// with NO such framing is not automatically safe, though — see
// ATTRIBUTION_RE/isExemptGeneralStatistic below: it only gets a pass when
// it's ALSO presented as attributed general knowledge, not stated as a bare
// unqualified fact. Scoped to the scale/percent checks only (SCALE_CLAIM_RE,
// PERCENT_CLAIM_RE) — price and superlative claims (PRICE_CLAIM_RE,
// SUPERLATIVE_PHRASES) have no comparable "legitimately general" reading in
// this kind of content, so applying either exemption there would just
// weaken real coverage for no matching false-positive relief.
const OWN_BUSINESS_FRAMING_RE = /\b(we|we're|we've|we'll|our|ours|us|this (?:business|company)|the company)\b/i;

// A number with no first-person framing is not automatically safe just for
// being "general" — an unattributed invented statistic ("70% of businesses
// use AI") is still a fabrication, it's just fabricating about the topic
// instead of about this specific business. What actually makes a general
// stat legitimate is that it's presented as general knowledge, not stated
// as this draft's own unqualified fact — i.e. it's attributed/hedged
// ("according to...", "studies show...", "on average..."). No attribution
// and no business framing is the worst combination, not the safest one: a
// bare, confident-sounding invented number with nothing backing it either
// way.
const ATTRIBUTION_RE = /\b(according to|studies show|research shows|reports? (?:show|suggest|indicate)|survey|data suggests?|on average|typically|generally|industry (?:reports?|data|research))\b/i;

// The sentence containing `matchIndex` — split on real sentence-ending
// punctuation, not the whole paragraph, so a claim's framing is judged by
// its own sentence rather than borrowing "we" from an unrelated one two
// sentences away.
function sentenceAround(text, matchIndex) {
  const start = Math.max(text.lastIndexOf('.', matchIndex), text.lastIndexOf('!', matchIndex), text.lastIndexOf('?', matchIndex), text.lastIndexOf('\n', matchIndex));
  const endCandidates = ['.', '!', '?', '\n'].map((ch) => {
    const i = text.indexOf(ch, matchIndex);
    return i === -1 ? text.length : i;
  });
  const end = Math.min(...endCandidates);
  return text.slice(start + 1, end);
}

function isFramedAsOwnBusinessClaim(text, matchIndex) {
  return OWN_BUSINESS_FRAMING_RE.test(sentenceAround(text, matchIndex));
}

// True only when the claim is legitimately exempt: general (no first-person
// framing) AND explicitly attributed/hedged as general knowledge, not
// stated as a bare unqualified fact. Anything else — framed as this
// business's own claim, OR general-sounding but presented with no
// attribution at all — still needs to check out against groundingContext.
function isExemptGeneralStatistic(text, matchIndex) {
  const sentence = sentenceAround(text, matchIndex);
  return !OWN_BUSINESS_FRAMING_RE.test(sentence) && ATTRIBUTION_RE.test(sentence);
}

// Field names vary by generator (landing-page.js: headline/subheadline;
// blog-outline.js: title; direct-answer.js: title/heading/directAnswer +
// supportingSections instead of sections) — every field a claim could
// plausibly appear in across the currently-scoped generators (see
// CLAIM_GROUNDED_GENERATOR_IDS, quality-gate.js), not a per-generator
// branch, so a future generator added to that set only needs its own field
// names added here once rather than a whole new checker.
function sectionText(content) {
  const parts = [
    content?.headline, content?.subheadline, content?.title, content?.heading, content?.directAnswer,
    ...(content?.sections || []).flatMap((s) => [s?.heading, s?.body]),
    ...(content?.supportingSections || []).flatMap((s) => [s?.heading, s?.body]),
  ];
  return parts.filter(Boolean).join('\n');
}

export function findUngroundedClaims(content) {
  const issues = [];
  if (!content || typeof content !== 'object') return issues;
  const text = sectionText(content);
  if (!text) return issues;
  // Commas stripped here too, not just from the extracted claim number
  // below — real prose almost always writes a large number WITH thousands
  // separators ("500,000 customers"), so comparing a comma-stripped claim
  // against comma-formatted context would falsely report a genuinely
  // backed number as unsupported.
  const context = (content.groundingContext || '').toLowerCase().replace(/(\d),(\d)/g, '$1$2');

  const seenNumbers = new Set();
  for (const match of text.matchAll(SCALE_CLAIM_RE)) {
    const [full, rawNumber, unit] = match;
    const number = rawNumber.replace(/,/g, '');
    const key = `${number}:${unit.toLowerCase()}`;
    if (seenNumbers.has(key)) continue;
    seenNumbers.add(key);
    if (context.includes(number)) continue;
    // Exempt only when it's BOTH not framed as this business's own claim
    // AND explicitly attributed as general knowledge (e.g. "according to
    // industry reports") — a general-sounding number with no attribution
    // at all is still an unqualified invented statistic, just about the
    // topic instead of the business. See isExemptGeneralStatistic's own
    // comment.
    if (isExemptGeneralStatistic(text, match.index)) continue;
    const isOwnClaim = isFramedAsOwnBusinessClaim(text, match.index);
    issues.push({
      path: 'content', patternId: 'ungrounded-claim',
      detail: `"${full.trim()}" is a specific claim not present in the supporting data this draft was given`,
      correction: isOwnClaim
        ? `Remove or rewrite "${full.trim()}" — this specific ${unit} figure isn't in the supporting data you were given. Only state a number if it's present in that data; otherwise write generally (e.g. "years of experience" instead of a made-up figure) or omit the claim entirely.`
        : `Remove or rewrite "${full.trim()}" — this reads as a factual statistic but isn't backed by the supporting data and has no attribution (e.g. "according to..."). Either attribute it to a real, named source or state it more generally without a specific invented number.`,
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

  const seenPercents = new Set();
  for (const m of text.matchAll(PERCENT_CLAIM_RE)) {
    const match = m[0];
    if (seenPercents.has(match)) continue;
    seenPercents.add(match);
    if (context.includes(match)) continue;
    if (isExemptGeneralStatistic(text, m.index)) continue;
    const isOwnClaim = isFramedAsOwnBusinessClaim(text, m.index);
    issues.push({
      path: 'content', patternId: 'ungrounded-claim',
      detail: `"${match}" is a specific statistic not present in the supporting data this draft was given`,
      correction: isOwnClaim
        ? `Remove or rewrite the "${match}" statistic — it isn't backed by the supporting data you were given. Only state a percentage if it's present in that data.`
        : `Remove or rewrite the "${match}" statistic — it reads as a factual claim but isn't backed by the supporting data and has no attribution (e.g. "according to..."). Either attribute it to a real, named source or state it more generally without a specific invented number.`,
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

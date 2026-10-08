import { FEED_CATALOG_KEYS, industryIsMappable } from '../agents/lib/trend-feeds.js';

// Capture a tenant's industry at onboarding, from the best source available,
// and say honestly how good that source was.
//
// Why this exists: industry is currently only ever inferred by the Python
// keyword-clustering collector from a site's own Search Console queries. A
// product tenant has no Search Console, so its industry stays NULL forever
// — and feedsForTenant with no industry returns an EMPTY feed list, which
// makes trend radar report "too few recent headlines". The tenant reads as
// having no trends when in fact it was never classified. Nothing anywhere
// says so.
//
// The second, subtler failure this closes: an industry string outside the
// feed catalog's vocabulary ("B2B logistics software for cold chain") is
// just as useless as NULL, and looks exactly as healthy in the database.
// So capture is only complete when the value is MAPPABLE, and an unmappable
// one is recorded as such rather than stored as if it worked.

export const INDUSTRY_SOURCES = Object.freeze(['human', 'growth-config', 'llm-classified', 'inferred', 'unmapped']);

// Confidence by source, not by the value. A staff member typing the industry
// is ground truth; the growth config was also entered by a human but may be
// a selling-to list rather than what the tenant does; an LLM reading a
// homepage is a real signal and routinely wrong about a niche.
const CONFIDENCE_BY_SOURCE = {
  human: 'high',
  'growth-config': 'medium',
  'llm-classified': 'low',
  inferred: 'medium',
};

const CLASSIFY_SYSTEM =
  'Classify the business described below into EXACTLY ONE of these industry labels, chosen only from this list: ' +
  `${FEED_CATALOG_KEYS.join(', ')}. ` +
  'These are the only labels the system can act on. If the business does not genuinely belong to any of them, ' +
  'answer "none" — a wrong label is worse than none, because it would feed this tenant another industry\'s news. ' +
  'Respond with ONLY a JSON object: {"industry": "<one label or none>", "reasoning": "<one short sentence>"}';

// Pure. Given everything known, which industry to record and how it was
// obtained. No I/O, so the precedence is directly testable.
//
// Precedence: an explicit staff value, then the product growth config's
// first industry, then an LLM classification already performed by the
// caller. An LLM call is the last resort and never overrides a human.
export function resolveIndustry({ explicit = null, growthIndustries = null, classified = null } = {}) {
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

  const candidates = [
    { industry: clean(explicit), source: 'human' },
    { industry: clean(Array.isArray(growthIndustries) ? growthIndustries[0] : growthIndustries), source: 'growth-config' },
    { industry: clean(classified), source: 'llm-classified' },
  ].filter((c) => c.industry);

  if (!candidates.length) return { industry: null, source: null, confidence: null, mappable: false };

  const [best] = candidates;
  const mappable = industryIsMappable(best.industry);

  // An unmappable value is still RECORDED — losing it would mean asking
  // staff for it again, and it is genuinely informative to a human reading
  // the console. But the source is marked 'unmapped' so every consumer can
  // see that the trend-feed catalog cannot act on it, and so this never
  // masquerades as working capture.
  return {
    industry: best.industry,
    source: mappable ? best.source : 'unmapped',
    confidence: mappable ? CONFIDENCE_BY_SOURCE[best.source] : 'low',
    mappable,
    // Kept for the console / audit trail: which source actually supplied
    // the string, even when it turned out to be unusable.
    originalSource: best.source,
  };
}

// The LLM tier, kept separate from resolveIndustry so the precedence above
// stays pure and so a caller that already has a human value never pays for
// a model call.
//
// Returns null on anything other than a label the catalog can act on. "none"
// is a first-class answer, not a failure: a business genuinely outside these
// five industries must not be forced into one, because the only consequence
// of a wrong label is feeding this tenant another industry's news as if it
// were its own.
export async function classifyIndustryFromText(description, { callJson } = {}) {
  if (!description || !String(description).trim()) return null;
  if (typeof callJson !== 'function') return null;

  let parsed;
  try {
    parsed = await callJson(CLASSIFY_SYSTEM, String(description).slice(0, 4000));
  } catch {
    return null;
  }

  const label = typeof parsed?.industry === 'string' ? parsed.industry.trim().toLowerCase() : '';
  if (!label || label === 'none') return null;
  // Validated against the catalog's own keys, never trusted verbatim — a
  // model answering with a plausible near-miss ("ed-tech", "proptech") is
  // dropped rather than guessed into the nearest key, exactly as
  // blog-outline.js validates model-chosen categories against the real list.
  return FEED_CATALOG_KEYS.includes(label) ? label : null;
}

export { CLASSIFY_SYSTEM };

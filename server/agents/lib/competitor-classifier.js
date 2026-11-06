import { isKnownPlatformDomain, normalizeCompetitorDomain } from './competitor-analysis.js';

// Tells apart the three things a SERP tally lumps together (migration 232): a genuine business rival, a
// directory/publisher that merely occupies the same searches, and a domain that appeared for one keyword.
//
// Deliberately deterministic and free of LLM calls: every output is derived from signals the caller already measured
// (how many of this site's real queries the domain ranked for, how much of its homepage text overlaps the site's own
// service terms, whether it serves the same place). An LLM may be used by the CALLER to read a homepage, but the label
// itself must be explainable from numbers, because it decides whose keywords become content work.
//
// A signal that could not be measured is absent, never zero: `queriesChecked: 0` means "no evidence either way" and
// yields low confidence instead of a confident "irrelevant".

export const KINDS = Object.freeze({ BUSINESS: 'business', ORGANIC: 'organic', KEYWORD_SPECIFIC: 'keyword_specific' });

// Domains whose business model is listing or publishing about other businesses. They legitimately outrank real rivals
// on commercial searches, so they must never be presented as "your competitor" — but the topics they rank for are
// still real demand evidence. Matched as the domain or any subdomain of it, like isKnownPlatformDomain.
const AGGREGATOR_DOMAINS = new Set([
  'yelp.com', 'tripadvisor.com', 'trustpilot.com', 'glassdoor.com', 'indeed.com', 'justdial.com', 'sulekha.com',
  'yellowpages.com', 'bbb.org', 'angi.com', 'houzz.com', 'thumbtack.com', 'clutch.co', 'g2.com', 'capterra.com',
  'producthunt.com', 'crunchbase.com', 'zomato.com', 'swiggy.com', 'booking.com', 'airbnb.com', 'expedia.com',
  'makemytrip.com', 'practo.com', 'quora.com', 'forbes.com', 'bbc.com', 'cnn.com', 'nytimes.com', 'theguardian.com',
  'techcrunch.com', 'businessinsider.com', 'hubspot.com', 'wordpress.com', 'wix.com', 'squarespace.com', 'shopify.com',
]);

// Words a listing/publishing site uses about itself on its own homepage. Only consulted when the domain is not in the
// list above: a small local directory is not a famous one, but it still describes itself as a directory.
const AGGREGATOR_SELF_DESCRIPTIONS = [
  'directory', 'listings', 'compare quotes', 'compare prices', 'find a ', 'browse ', 'marketplace',
  'reviews of', 'top 10 best', 'read reviews', 'classifieds', 'advertise with us', 'list your business',
];

// Below this share of a site's checked queries, a domain is evidence about those keywords rather than a rival.
const KEYWORD_SPECIFIC_MAX_HITS = 1;
// Service-term overlap (0..1) at or above which a domain is talking about the same things this site sells.
const BUSINESS_MIN_OVERLAP = 0.25;

export function isAggregatorDomain(domain) {
  const d = normalizeCompetitorDomain(domain);
  if (!d) return false;
  for (const a of AGGREGATOR_DOMAINS) if (d === a || d.endsWith(`.${a}`)) return true;
  return false;
}

export function looksLikeAggregatorText(homepageText) {
  if (!homepageText) return null; // not measured — not the same as "no"
  const text = String(homepageText).toLowerCase();
  const hits = AGGREGATOR_SELF_DESCRIPTIONS.filter((phrase) => text.includes(phrase));
  return { matched: hits.length >= 2, phrases: hits.slice(0, 5) };
}

/**
 * Classify one candidate domain for one site.
 *
 * signals:
 *   serpQueryHits      how many of the site's own checked queries this domain ranked for (integer, required)
 *   queriesChecked     how many queries were actually checked (integer; 0 = no SERP evidence at all)
 *   serviceTermOverlap 0..1 share of the site's service terms found in the candidate's own homepage, or null if the
 *                      homepage could not be read
 *   locationMatch      true/false/null — does it serve the same market? null = not determined
 *   homepageText       the candidate's fetched homepage text, if any (used only for self-description)
 *   bestPosition       best SERP position seen, if known (used only as evidence, never to decide the kind)
 *
 * Returns { kind, relevanceScore, confidence, excludedReason, evidence } — or kind null with excludedReason 'platform'
 * for a domain that is not a competitor of any sort.
 */
export function classifyCompetitor(domain, signals = {}) {
  const d = normalizeCompetitorDomain(domain);
  const {
    serpQueryHits = 0, queriesChecked = 0, serviceTermOverlap = null,
    locationMatch = null, homepageText = null, bestPosition = null,
  } = signals;

  const selfDescription = looksLikeAggregatorText(homepageText);
  const evidence = {
    domain: d, serpQueryHits, queriesChecked,
    serviceTermOverlap, locationMatch, bestPosition,
    aggregatorListed: isAggregatorDomain(d),
    aggregatorSelfDescribed: selfDescription ? selfDescription.matched : null,
    aggregatorPhrases: selfDescription ? selfDescription.phrases : null,
    decidedAt: new Date().toISOString(),
  };

  if (!d) return { kind: null, relevanceScore: null, confidence: 'low', excludedReason: 'invalid_domain', evidence };
  if (isKnownPlatformDomain(d)) {
    return { kind: null, relevanceScore: null, confidence: 'high', excludedReason: 'platform', evidence, reason: 'Social/search platform, not a market participant.' };
  }

  // A listing or publishing business: real in the SERP, never a rival.
  if (evidence.aggregatorListed || evidence.aggregatorSelfDescribed) {
    return {
      kind: KINDS.ORGANIC, relevanceScore: 0, confidence: evidence.aggregatorListed ? 'high' : 'medium',
      excludedReason: null, evidence,
      reason: evidence.aggregatorListed
        ? 'Known directory, marketplace or publisher — competes for the searches, not for the customer.'
        : `Describes itself as a listing site (${(selfDescription.phrases || []).join(', ')}).`,
    };
  }

  // Appeared for at most one of the site's own queries: evidence about that keyword, not a competitor.
  if (queriesChecked > 0 && serpQueryHits <= KEYWORD_SPECIFIC_MAX_HITS) {
    return {
      kind: KINDS.KEYWORD_SPECIFIC,
      relevanceScore: score({ serpQueryHits, queriesChecked, serviceTermOverlap, locationMatch }),
      confidence: 'medium', excludedReason: null, evidence,
      reason: `Ranked for ${serpQueryHits} of ${queriesChecked} checked queries — treated as keyword evidence, not a rival.`,
    };
  }

  // Same offering, same market, seen across several real searches.
  const overlapKnown = typeof serviceTermOverlap === 'number';
  if (overlapKnown && serviceTermOverlap >= BUSINESS_MIN_OVERLAP && locationMatch !== false && serpQueryHits > KEYWORD_SPECIFIC_MAX_HITS) {
    return {
      kind: KINDS.BUSINESS,
      relevanceScore: score({ serpQueryHits, queriesChecked, serviceTermOverlap, locationMatch }),
      confidence: locationMatch === true ? 'high' : 'medium', excludedReason: null, evidence,
      reason: `Ranks for ${serpQueryHits} of ${queriesChecked} of this site's own searches and its homepage covers ${Math.round(serviceTermOverlap * 100)}% of this site's service terms.`,
    };
  }

  // Everything else: it is in these SERPs, but nothing shows it sells the same thing. Not promoted to 'business'
  // without evidence — the whole point of the split.
  return {
    kind: KINDS.ORGANIC,
    relevanceScore: score({ serpQueryHits, queriesChecked, serviceTermOverlap, locationMatch }),
    confidence: overlapKnown ? 'medium' : 'low', excludedReason: null, evidence,
    reason: overlapKnown
      ? `Shares ${serpQueryHits} of this site's searches but its homepage covers only ${Math.round((serviceTermOverlap || 0) * 100)}% of its service terms.`
      : 'Shares this site\'s searches; its homepage could not be read, so it is not treated as a business rival.',
  };
}

// 0..1, three bounded parts: how consistently it shows up, how much of the same thing it talks about, whether it serves
// the same market. Not a probability and not a business metric — only an ordering so the strongest evidence is looked
// at first. An unmeasured part contributes nothing rather than a guessed value.
function score({ serpQueryHits, queriesChecked, serviceTermOverlap, locationMatch }) {
  const presence = queriesChecked > 0 ? Math.min(serpQueryHits / queriesChecked, 1) : 0;
  const overlap = typeof serviceTermOverlap === 'number' ? Math.min(Math.max(serviceTermOverlap, 0), 1) : 0;
  const place = locationMatch === true ? 1 : 0;
  return Number((presence * 0.45 + overlap * 0.4 + place * 0.15).toFixed(3));
}

/**
 * Classify a batch and keep the ones worth acting on. Business rivals are capped because every one of them costs money
 * to research in Phase 3; organic and keyword-specific rows are kept as evidence but never counted against that cap.
 */
export function classifyAll(candidates, { maxBusiness = 5 } = {}) {
  const classified = candidates
    .map((c) => ({ domain: normalizeCompetitorDomain(c.domain), ...classifyCompetitor(c.domain, c) }))
    .filter((c) => c.domain);
  const business = classified
    .filter((c) => c.kind === KINDS.BUSINESS)
    .sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));
  return {
    business: business.slice(0, maxBusiness),
    overflowBusiness: business.slice(maxBusiness),
    organic: classified.filter((c) => c.kind === KINDS.ORGANIC),
    keywordSpecific: classified.filter((c) => c.kind === KINDS.KEYWORD_SPECIFIC),
    excluded: classified.filter((c) => c.kind === null),
  };
}

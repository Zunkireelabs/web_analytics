// Keyword -> existing-page coverage verdicts.
//
// SAME TOPIC DOES NOT MEAN SAME SEO TARGET. A page can share a topic with a
// keyword and still not satisfy it, because the language, the country, the
// audience or the search intent differs. This module decides which of those
// cases a gap is, from evidence, in the cheapest order that works:
//
//   1. deterministic signals (Unicode-aware tokens, language, market, intent,
//      pages already ranking for the keyword)         -> most gaps end here
//   2. one small LLM call, only when the deterministic overlap is ambiguous
//   3. cached on the gap row, so re-checking costs nothing unless the
//      evidence changed
//
// It extends analyst-seo-mapping.js's findExistingPageMatch (same candidate
// source, same domain scoping) instead of replacing it with a second system.
//
// Verdicts (COVERAGE_STATUSES):
//   duplicate    the exact keyword is already this page's target, same language/market/intent
//   covered      a page already satisfies the topic for this language, market and intent
//   opportunity  nothing on the site meaningfully covers it
//   market_gap   topic is covered, but not for this country/market
//   language_gap topic is covered, but not in this language
//   intent_gap   topic is covered, but by a page serving a different intent
//   uncertain    not enough evidence to say; never silently dropped

export const COVERAGE_STATUSES = ['duplicate', 'covered', 'opportunity', 'market_gap', 'language_gap', 'intent_gap', 'uncertain'];

// DataForSEO location code -> ISO market. Matches sites.target_markets (migration 162).
export const LOCATION_CODE_TO_MARKET = {
  2840: 'US', 2356: 'IN', 2826: 'GB', 2036: 'AU', 2124: 'CA', 2524: 'NP', 2756: 'CH', 2528: 'NL', 2276: 'DE',
};

// ---- text ------------------------------------------------------------------

// Fold for COMPARISON only (never for display or storage): NFKC, lowercase,
// sharp s -> ss (so Swiss "ss" and German "ß" spellings match), strip
// combining marks. Letters in any script survive, which is the point — the old
// [^a-z0-9] split turned "KI-Entwicklung" or Devanagari into an empty token set.
export function foldText(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '');
}

const STOPWORDS = new Set([
  // en
  'the', 'a', 'an', 'for', 'and', 'or', 'to', 'of', 'in', 'on', 'is', 'are', 'how', 'what', 'why', 'does', 'do', 'with', 'your', 'you',
  // de
  'und', 'der', 'die', 'das', 'den', 'dem', 'ein', 'eine', 'fur', 'mit', 'von', 'zu', 'im', 'ist', 'wie', 'was', 'bei', 'auf',
  // nl
  'het', 'een', 'voor', 'van', 'met', 'en', 'de', 'in', 'op', 'is', 'hoe', 'wat', 'bij',
]);

// Words that describe the kind of result, not the topic. "web development
// company" and "web development" are the same topic.
const GENERIC = new Set([
  'company', 'companies', 'service', 'services', 'solution', 'solutions', 'provider', 'providers', 'agency', 'agencies',
  'firm', 'firms', 'best', 'top', 'leading', 'near', 'guide', 'complete', 'comprehensive', 'overview',
  'dienstleistungen', 'dienstleister', 'anbieter', 'unternehmen', 'losungen', 'bedrijf', 'bedrijven', 'diensten', 'oplossingen',
]);

const YEAR = /^(?:19|20)\d{2}$/;

// Geo modifiers: market signals, not topic words. Compared folded.
const GEO_TERMS = {
  NP: ['nepal', 'nepali', 'nepalese', 'kathmandu', 'pokhara', 'lalitpur', 'bhaktapur'],
  CH: ['schweiz', 'suisse', 'svizzera', 'switzerland', 'swiss', 'zurich', 'bern', 'basel', 'genf', 'geneva'],
  DE: ['deutschland', 'germany', 'german', 'berlin', 'munchen', 'munich', 'hamburg'],
  NL: ['nederland', 'netherlands', 'dutch', 'holland', 'amsterdam', 'rotterdam'],
  GB: ['uk', 'britain', 'british', 'england', 'london', 'manchester'],
  CA: ['canada', 'canadian', 'toronto', 'vancouver', 'montreal'],
  AU: ['australia', 'australian', 'sydney', 'melbourne', 'brisbane'],
  IN: ['india', 'indian', 'delhi', 'mumbai', 'bangalore'],
  US: ['usa', 'america', 'american'],
};
const GEO_TO_MARKET = new Map(Object.entries(GEO_TERMS).flatMap(([m, terms]) => terms.map((t) => [t, m])));

function rawTokens(text) {
  return foldText(text).match(/[\p{L}\p{N}]+/gu) || [];
}

// Topic tokens: stopwords, generic result-type words, geo modifiers and years
// are removed, because none of them changes WHAT the topic is.
export function topicTokens(text) {
  return [...new Set(rawTokens(text).filter((t) => (
    t.length >= 2 && !STOPWORDS.has(t) && !GENERIC.has(t) && !GEO_TO_MARKET.has(t) && !YEAR.test(t)
  )))];
}

// Order-insensitive, year-insensitive identity of a topic.
export function topicKey(text) {
  return topicTokens(text).sort().join(' ');
}

export function detectMarkets(text) {
  return [...new Set(rawTokens(text).map((t) => GEO_TO_MARKET.get(t)).filter(Boolean))];
}

export function extractYears(text) {
  return (String(text || '').match(/\b(?:19|20)\d{2}\b/g) || []).map(Number);
}

// ---- language --------------------------------------------------------------

const LANG_MARKERS = {
  de: new Set(['und', 'der', 'die', 'das', 'fur', 'mit', 'ist', 'nicht', 'ki', 'schweiz', 'entwicklung', 'unternehmen', 'losungen', 'webentwicklung', 'kunstliche', 'intelligenz', 'wie', 'zukunft', 'beste', 'dienstleistungen', 'anbieter', 'preise', 'kosten']),
  nl: new Set(['het', 'een', 'voor', 'van', 'met', 'niet', 'ontwikkeling', 'oplossingen', 'bedrijf', 'bedrijven', 'diensten', 'toekomst', 'hoe', 'wat', 'beste', 'kosten', 'nederland']),
  en: new Set(['the', 'and', 'for', 'how', 'what', 'best', 'top', 'services', 'company', 'development', 'software', 'with', 'is', 'of', 'in', 'to', 'why', 'near', 'cost']),
};

// Cheap, deterministic. Returns { lang, confidence } where lang is a base ISO
// code or 'unknown'. A script match (Devanagari) is certain; Latin-script
// languages are scored on marker words and need a clear winner. When unsure it
// says so — the caller can consult the query_translations cache, never guess.
export function detectLanguage(text) {
  const raw = String(text || '');
  if (/[ऀ-ॿ]/.test(raw)) return { lang: 'ne', confidence: 'high' };
  if (/[؀-ۿ]/.test(raw)) return { lang: 'ar', confidence: 'high' };
  if (/[一-鿿]/.test(raw)) return { lang: 'zh', confidence: 'high' };
  const tokens = rawTokens(raw);
  if (!tokens.length) return { lang: 'unknown', confidence: 'none' };
  const score = Object.fromEntries(Object.entries(LANG_MARKERS).map(([l, set]) => [l, tokens.filter((t) => set.has(t)).length]));
  // Umlauts / eszett are weak but real German evidence on raw text.
  if (/[äöüß]/i.test(raw)) score.de += 1;
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (best[1] === 0) return { lang: 'unknown', confidence: 'none' };
  if (best[1] === second[1]) return { lang: 'unknown', confidence: 'low' };
  return { lang: best[0], confidence: best[1] - second[1] >= 2 ? 'high' : 'medium' };
}

const LANGUAGE_NAME_TO_CODE = {
  english: 'en', german: 'de', dutch: 'nl', nepali: 'ne', hindi: 'hi', french: 'fr', spanish: 'es', italian: 'it',
  arabic: 'ar', chinese: 'zh', portuguese: 'pt',
};
// query_translations stores the model's language NAME ("German"); normalize to a code.
export function languageNameToCode(name) {
  const n = foldText(name).trim();
  if (!n || n === 'unknown') return 'unknown';
  if (/^[a-z]{2}(-[a-z]{2})?$/.test(n)) return n.slice(0, 2);
  return LANGUAGE_NAME_TO_CODE[n] || 'unknown';
}

export const baseLang = (l) => String(l || '').toLowerCase().split('-')[0];

// ---- intent ----------------------------------------------------------------

const COMMERCIAL_SEGMENTS = new Set(['services', 'service', 'products', 'product', 'solutions', 'locations', 'pricing', 'industries', 'platform', 'agentic-as-a-service']);
const INFORMATIONAL_SEGMENTS = new Set(['blog', 'resources', 'glossary', 'guides', 'learn', 'news', 'insights', 'compare']);

function pathOf(url) {
  try { return new URL(url).pathname; } catch { return String(url || '').replace(/^https?:\/\/[^/]+/, ''); }
}

// What a page is FOR, from its URL. 'unknown' is a real answer: it never
// produces an intent mismatch on its own.
export function pageIntent(url) {
  const segs = pathOf(url).split('/').filter(Boolean);
  const first = segs.find((s) => !/^(de|nl|de-ch|fr|it)$/i.test(s));
  if (!first) return 'unknown';
  if (INFORMATIONAL_SEGMENTS.has(first)) return 'informational';
  if (COMMERCIAL_SEGMENTS.has(first)) return 'commercial';
  return 'unknown';
}

function gapIntentClass(searchIntent) {
  if (searchIntent === 'commercial' || searchIntent === 'transactional') return 'commercial';
  if (searchIntent === 'informational') return 'informational';
  return 'unknown';
}

// ---- page signals ----------------------------------------------------------

const LOCALE_PREFIX = { 'de-ch': { lang: 'de', market: 'CH' }, de: { lang: 'de', market: 'DE' }, nl: { lang: 'nl', market: 'NL' } };

// Language and market a page serves, from its URL (locale prefix, geo slug) and
// optionally what was read from its content. Un-prefixed pages are the site's
// default language and have no market of their own unless the URL names one.
export function pageSignals(url, { siteLanguage = 'en', htmlLang = null, text = '' } = {}) {
  const segs = pathOf(url).split('/').filter(Boolean);
  const prefix = LOCALE_PREFIX[String(segs[0] || '').toLowerCase()];
  const slugMarkets = detectMarkets(segs.join(' ').replace(/-/g, ' '));
  const textMarkets = text ? detectMarkets(text) : [];
  const markets = [...new Set([...(prefix ? [prefix.market] : []), ...slugMarkets, ...textMarkets])];
  // An un-prefixed page is the site default language UNLESS its own text says
  // otherwise with certainty (e.g. a German post living under /blog/).
  const fromText = !prefix && !htmlLang && text ? detectLanguage(text) : null;
  const textLang = fromText && fromText.confidence === 'high' ? fromText.lang : null;
  return {
    lang: prefix?.lang || baseLang(htmlLang) || textLang || baseLang(siteLanguage) || 'en',
    langSource: prefix ? 'url-prefix' : htmlLang ? 'html-lang' : textLang ? 'content' : 'site-default',
    markets,
    explicitMarkets: [...new Set([...(prefix ? [prefix.market] : []), ...slugMarkets])],
    intent: pageIntent(url),
  };
}

// ---- scoring ---------------------------------------------------------------

// Words that appear on a large share of THIS site's pages say almost nothing
// about which page covers a topic ("ai" on an AI company's site). They still
// count, but weigh less, so one shared word can't make a page look like a match.
// Computed from the site's own URLs, so it adapts to each tenant.
export function buildTokenWeights(urls, { commonShare = 0.25, minPages = 12, commonWeight = 0.3 } = {}) {
  const pages = (urls || []).map((u) => new Set(topicTokens(pathOf(u).replace(/[-_/]+/g, ' '))));
  const weights = new Map();
  if (pages.length < minPages) return weights;
  const df = new Map();
  for (const set of pages) for (const t of set) df.set(t, (df.get(t) || 0) + 1);
  for (const [t, n] of df) if (n / pages.length >= commonShare) weights.set(t, commonWeight);
  return weights;
}

// Weighted share of the gap's topic tokens that the evidence contains (0..1).
function containment(gapSet, evidenceText, weights) {
  if (!gapSet.size) return 0;
  const ev = new Set(topicTokens(evidenceText));
  const w = (t) => (weights && weights.get(t)) ?? 1;
  let hit = 0; let total = 0;
  for (const t of gapSet) { total += w(t); if (ev.has(t)) hit += w(t); }
  return total ? hit / total : 0;
}

export const STRONG_OVERLAP = 0.75;
export const AMBIGUOUS_OVERLAP = 0.4;

// candidate: { url, queries?: [{query, impressions, clicks, position}], title?, excerpt? }
// Evidence order: a query that already ranks this page, then the URL slug, then
// the title. Body text is only used to confirm a market, never to score topic —
// a passing mention is not coverage.
// A page only counts as already RANKING for a keyword when it really does:
// near enough to the results and with enough impressions to be more than noise.
export const MIN_RANKING_IMPRESSIONS = 3;
export const MAX_RANKING_POSITION = 40;
// The homepage ranks for everything a little. That is not coverage; cap it so a
// homepage match is always sent for judgment instead of being accepted.
export const HOMEPAGE_STRENGTH_CAP = 0.7;

const isRealRanking = (q) => (q.impressions == null || q.impressions >= MIN_RANKING_IMPRESSIONS)
  && (q.position == null || q.position <= MAX_RANKING_POSITION);

export function scoreCandidate(gapTokenList, candidate, weights) {
  const gapSet = new Set(gapTokenList);
  const slug = pathOf(candidate.url).replace(/[-_/]+/g, ' ');
  const gapKey = [...gapSet].sort().join(' ');
  let best = { strength: 0, source: null, exact: false };
  const consider = (strength, source, text) => {
    // `exact` = a page BUILT AROUND this keyword (slug/title). A page that merely
    // already ranks for it is covered, not a duplicate target.
    if (strength > best.strength) best = { strength, source, exact: source !== 'ranking-query' && topicKey(text) === gapKey && gapKey !== '' };
  };
  for (const q of candidate.queries || []) if (isRealRanking(q)) consider(containment(gapSet, q.query, weights), 'ranking-query', q.query);
  consider(containment(gapSet, slug, weights), 'url-slug', slug);
  if (candidate.title) consider(containment(gapSet, candidate.title, weights), 'title', candidate.title);
  if (pathOf(candidate.url).replace(/\/+$/, '') === '' && best.strength > HOMEPAGE_STRENGTH_CAP) best = { ...best, strength: HOMEPAGE_STRENGTH_CAP, exact: false };
  return best;
}

// ---- verdict ---------------------------------------------------------------

function intentMismatch(gapIntent, pageIntentClass) {
  return gapIntent !== 'unknown' && pageIntentClass !== 'unknown' && gapIntent !== pageIntentClass;
}

// Does this page actually serve every explicit market the gap names? A page
// with no market of its own is "global": it does NOT satisfy a gap that names a
// country, but it does satisfy one that names none.
function marketUnserved(gapMarkets, page) {
  if (!gapMarkets.length) return false;
  return !gapMarkets.every((m) => page.markets.includes(m));
}

// Pure and synchronous: everything it needs is passed in, so it is cheap to run
// over every gap and easy to test.
//   gap:        { topic, search_intent, location_code }
//   gapSignals: { lang, markets (explicit modifiers), englishTopic? }
//   candidates: [{ url, queries?, title?, excerpt?, htmlLang? }]
export function decideCoverage({ gap, gapSignals, candidates, siteLanguage = 'en', now = new Date(), tokenWeights = null }) {
  const topic = gap?.topic || '';
  // Cross-language: score on the topic's English reading too, so a German
  // keyword can find the English page that already covers the subject.
  const tokenSets = [topicTokens(topic)];
  if (gapSignals?.englishTopic && foldText(gapSignals.englishTopic) !== foldText(topic)) tokenSets.push(topicTokens(gapSignals.englishTopic));
  const gapTokens = [...new Set(tokenSets.flat())];
  if (!gapTokens.length) {
    return { status: 'uncertain', reason: 'No usable topic words after normalization.', url: null, method: 'deterministic', evidence: { gapTokens: [] } };
  }

  const gapIntent = gapIntentClass(gap?.search_intent);
  const gapLang = gapSignals?.lang && gapSignals.lang !== 'unknown' ? baseLang(gapSignals.lang) : null;
  const gapMarkets = gapSignals?.markets || [];

  const scored = (candidates || []).map((c) => {
    const sig = pageSignals(c.url, { siteLanguage, htmlLang: c.htmlLang, text: [c.title, c.excerpt].filter(Boolean).join(' ') });
    // Score against each reading of the topic and keep the best.
    const best = tokenSets.map((ts) => scoreCandidate(ts, c, tokenWeights)).sort((a, b) => b.strength - a.strength)[0];
    return { url: c.url, sig, ...best };
  }).filter((c) => c.strength >= AMBIGUOUS_OVERLAP)
    .sort((a, b) => b.strength - a.strength);

  const evidenceBase = { gapTokens, gapLang, gapMarkets, gapIntent };
  if (!scored.length) {
    return { status: 'opportunity', reason: 'No existing page meaningfully overlaps this topic.', url: null, method: 'deterministic', evidence: evidenceBase };
  }

  // Prefer the strongest page; among near-equals prefer the one that already
  // serves this language and market.
  const top = scored[0].strength;
  const near = scored.filter((c) => top - c.strength < 0.1);
  const fits = (c) => (!gapLang || baseLang(c.sig.lang) === gapLang) && !marketUnserved(gapMarkets, c.sig);
  const best = near.find(fits) || scored[0];

  const out = (status, reason, extra = {}) => ({
    status, reason, url: best.url, method: 'deterministic',
    evidence: { ...evidenceBase, nearestUrl: best.url, strength: Number(best.strength.toFixed(2)), matchedOn: best.source, pageLang: best.sig.lang, pageMarkets: best.sig.markets, pageIntent: best.sig.intent, ...extra },
  });

  // Ambiguous overlap: ask for judgment rather than guess either way.
  if (best.strength < STRONG_OVERLAP) {
    return { ...out('uncertain', `Partial overlap (${best.strength.toFixed(2)}) with ${best.url}; needs judgment.`), needsLLM: true };
  }

  const stale = staleYearSignal(best.url, topic, now);
  const langMiss = gapLang && baseLang(best.sig.lang) !== gapLang;
  if (langMiss) {
    return out('language_gap', `${best.url} covers the topic in ${best.sig.lang}, not ${gapLang}.`, { needsRefresh: stale.stale });
  }
  if (marketUnserved(gapMarkets, best.sig)) {
    return out('market_gap', `${best.url} covers the topic but not for ${gapMarkets.join('/')}.`, { needsRefresh: stale.stale });
  }
  if (intentMismatch(gapIntent, best.sig.intent)) {
    return out('intent_gap', `${best.url} is a ${best.sig.intent} page; this keyword is ${gapIntent}.`, { needsRefresh: stale.stale });
  }
  if (best.exact) {
    return out('duplicate', `${best.url} already targets this exact keyword.`, { needsRefresh: stale.stale, staleReason: stale.reason });
  }
  return out('covered', `${best.url} already covers this topic for the same language, market and intent.`, { needsRefresh: stale.stale, staleReason: stale.reason });
}

// ---- dated content ---------------------------------------------------------

// A page whose slug/title carries an older year than the keyword asks for needs
// REFRESHING, with real research. It must never be satisfied by swapping the
// year in the title: that is how last year's facts get republished as this year's.
export function staleYearSignal(pageUrl, topic, now = new Date()) {
  const gapYears = extractYears(topic);
  const pageYears = extractYears(pathOf(pageUrl));
  const current = now.getFullYear();
  const wanted = gapYears.length ? Math.max(...gapYears) : null;
  const have = pageYears.length ? Math.max(...pageYears) : null;
  if (have != null && have < current - 0 && (wanted == null || wanted > have)) {
    return { stale: true, reason: `Page is dated ${have}; ${wanted ?? current} is current. Refresh with verified sources — do not just change the year.` };
  }
  return { stale: false, reason: null };
}

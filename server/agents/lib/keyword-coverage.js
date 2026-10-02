// Decides whether a keyword is ALREADY COVERED by an existing page of the site.
//
// "Similar to an existing page" is not "covered by it". A generic
// /services/web-development/ page covers "web development" but not
// "Webentwicklung Schweiz": same core topic, different language AND market,
// so it is a legitimate SEO opportunity. Treating topical similarity as
// coverage would hide exactly the keywords worth acting on.
//
// Multi-stage, cheapest first, and only the first two stages are free:
//
//   1. shortlistCandidates — deterministic. Normalizes the keyword and picks a
//      handful of LIKELY pages from their URL slugs. Never decides coverage.
//   2. assessCandidate     — deterministic. For each fetched candidate compares
//      core topic (slug/title/H1/meta/body), market, language and intent.
//      Returns covered / not_covered when the signals are unambiguous, and
//      'ambiguous' otherwise.
//   3. LLM                 — only when stage 2 left candidates ambiguous and none
//      confidently covered. Gets the structured signals, not just raw text.
//
// Decision values: 'covered' (hide the keyword), 'partially_covered' (an
// existing page overlaps but does not satisfy this query — keep the keyword),
// 'not_covered' (keep the keyword). Only 'covered' ever suppresses anything.
//
// Fetching and the LLM are injected so this module imports nothing heavy and
// is testable without network.

export const COVERAGE = Object.freeze({
  COVERED: 'covered',
  PARTIAL: 'partially_covered',
  NOT_COVERED: 'not_covered',
});

const STOPWORDS = new Set(['the', 'a', 'an', 'for', 'and', 'or', 'to', 'of', 'in', 'on', 'is', 'are', 'how', 'what', 'why', 'does', 'do', 'with', 'near', 'me']);

// Words that describe the KIND of search, not the subject. Excluded from the
// core-topic comparison so "custom AI development services" is judged on
// "ai development", while still feeding intent detection below.
const GENERIC_WORDS = new Set([
  'service', 'services', 'company', 'companies', 'agency', 'agencies', 'solution', 'solutions', 'provider', 'providers',
  'best', 'top', 'custom', 'cheap', 'affordable', 'hire', 'outsourcing', 'consulting', 'consultant', 'consultants', 'firm', 'firms',
  'guide', 'tutorial', 'examples', 'example', 'tips', 'cost', 'costs', 'pricing', 'price', 'prices',
]);

const COMMERCIAL_WORDS = new Set([
  'service', 'services', 'company', 'companies', 'agency', 'agencies', 'solution', 'solutions', 'provider', 'providers',
  'hire', 'cost', 'costs', 'pricing', 'price', 'prices', 'buy', 'best', 'top', 'cheap', 'affordable', 'consultant',
  'consultants', 'consulting', 'firm', 'firms', 'outsourcing', 'vendor', 'quote',
  // non-English commercial markers
  'agentur', 'unternehmen', 'kosten', 'preise', 'anbieter', 'entreprise', 'prix', 'empresa', 'precio', 'azienda', 'prezzo',
]);
const INFORMATIONAL_WORDS = new Set(['what', 'how', 'why', 'guide', 'tutorial', 'tutorials', 'examples', 'example', 'tips', 'meaning', 'definition', 'vs', 'versus', 'explained', 'learn']);

// canonical market -> aliases (country names, native spellings, major cities).
// Not exhaustive on purpose: an unknown market simply isn't detected, which
// degrades to the LLM stage rather than to a wrong deterministic answer.
const MARKETS = {
  india: ['india', 'indian', 'mumbai', 'delhi', 'bangalore', 'bengaluru', 'hyderabad', 'pune', 'chennai'],
  nepal: ['nepal', 'nepali', 'kathmandu', 'pokhara'],
  switzerland: ['switzerland', 'swiss', 'schweiz', 'suisse', 'svizzera', 'zurich', 'zuerich', 'geneva', 'basel'],
  germany: ['germany', 'german', 'deutschland', 'berlin', 'munich', 'muenchen', 'hamburg'],
  austria: ['austria', 'osterreich', 'oesterreich', 'vienna', 'wien'],
  france: ['france', 'french', 'paris'],
  spain: ['spain', 'espana', 'madrid', 'barcelona'],
  italy: ['italy', 'italia', 'italian', 'rome', 'milan', 'milano'],
  netherlands: ['netherlands', 'nederland', 'dutch', 'amsterdam'],
  uk: ['uk', 'united kingdom', 'britain', 'british', 'england', 'london'],
  usa: ['usa', 'united states', 'america', 'american', 'new york', 'california'],
  canada: ['canada', 'canadian', 'toronto', 'vancouver'],
  australia: ['australia', 'australian', 'sydney', 'melbourne'],
  uae: ['uae', 'dubai', 'emirates', 'abu dhabi'],
  singapore: ['singapore'],
  japan: ['japan', 'tokyo'],
  bangladesh: ['bangladesh', 'dhaka'],
};

// Distinctive (not shared with English) function words / domain words per
// language. A hit count, not a classifier: used only to notice that a keyword
// is plainly not English.
const LANGUAGE_MARKERS = {
  de: ['der', 'die', 'das', 'und', 'fur', 'mit', 'von', 'entwicklung', 'agentur', 'unternehmen', 'kosten', 'preise', 'anbieter', 'schweiz', 'deutschland', 'ki', 'webentwicklung', 'erstellen', 'lassen'],
  fr: ['le', 'les', 'des', 'pour', 'et', 'developpement', 'entreprise', 'prix', 'suisse', 'creation', 'agence', 'sur'],
  es: ['los', 'las', 'para', 'desarrollo', 'empresa', 'precio', 'espana', 'creacion', 'agencia'],
  it: ['il', 'gli', 'per', 'sviluppo', 'azienda', 'prezzo', 'italia', 'creazione', 'agenzia'],
  pt: ['para', 'desenvolvimento', 'empresa', 'preco', 'criacao', 'agencia'],
  nl: ['het', 'een', 'voor', 'ontwikkeling', 'bedrijf', 'prijs', 'nederland', 'maken'],
};

function fold(text) {
  return (text || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

function words(text) {
  return fold(text).split(/[^a-z0-9]+/).filter(Boolean);
}

// Plural/derivation folding good enough to match "development"/"developments"
// and "service"/"services" without pretending to be a real stemmer.
function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function containsPhrase(haystackWords, phrase) {
  const p = words(phrase);
  if (!p.length) return false;
  for (let i = 0; i + p.length <= haystackWords.length; i += 1) {
    if (p.every((w, j) => haystackWords[i + j] === w)) return true;
  }
  return false;
}

function detectMarket(tokenList) {
  for (const [market, aliases] of Object.entries(MARKETS)) {
    if (aliases.some((a) => containsPhrase(tokenList, a))) return market;
  }
  return null;
}

function marketTokenSet(market) {
  return new Set(market ? MARKETS[market].flatMap((a) => words(a)) : []);
}

function detectLanguage(tokenList) {
  let best = { lang: 'en', hits: 0 };
  for (const [lang, markers] of Object.entries(LANGUAGE_MARKERS)) {
    const hits = tokenList.filter((w) => markers.includes(w)).length;
    if (hits > best.hits) best = { lang, hits };
  }
  // One marker is enough for a distinctive compound ("webentwicklung"), but
  // a single short function word ("per", "para") is too weak to call a
  // language, so those need a second hit.
  const strong = best.hits >= 2 || tokenList.some((w) => w.length >= 9 && (LANGUAGE_MARKERS[best.lang] || []).includes(w));
  return strong ? { lang: best.lang, confident: true } : { lang: 'en', confident: false };
}

function detectIntent(tokenList) {
  const commercial = tokenList.some((w) => COMMERCIAL_WORDS.has(w));
  const informational = tokenList.some((w) => INFORMATIONAL_WORDS.has(w));
  if (commercial && !informational) return 'commercial';
  if (informational && !commercial) return 'informational';
  return 'unknown';
}

export function keywordSignals(topic) {
  const tokenList = words(topic);
  const market = detectMarket(tokenList);
  const marketTokens = marketTokenSet(market);
  // length >= 2 on purpose: "ai", "ml", "ki", "ux" ARE the subject. Dropping them
  // made "custom AI development" look identical to "web development".
  const significant = tokenList.filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  const core = significant.filter((w) => !marketTokens.has(w) && !GENERIC_WORDS.has(w)).map(stem);
  return {
    topic,
    tokens: tokenList,
    // Falls back to everything significant when the keyword is ONLY generic /
    // market words, so a core set is never empty for a real keyword.
    core: core.length ? [...new Set(core)] : [...new Set(significant.map(stem))],
    market,
    ...detectLanguage(tokenList),
    intent: detectIntent(tokenList),
  };
}

function pathOf(url) {
  return (url || '').replace(/^https?:\/\/[^/]+/, '');
}

function pageIntentFromUrl(url) {
  const p = fold(pathOf(url));
  if (/\/(blog|news|article|articles|guide|guides|learn|resources|insights|post|posts|faq|help|docs)(\/|$)/.test(p)) return 'informational';
  if (/\/(services?|solutions?|products?|pricing|hire|industries|offerings?)(\/|$)/.test(p)) return 'commercial';
  return 'unknown';
}

function pageLanguage(url, htmlLang) {
  const fromAttr = (htmlLang || '').split(/[-_]/)[0].toLowerCase();
  if (/^[a-z]{2}$/.test(fromAttr)) return fromAttr;
  const seg = pathOf(url).split('/').filter(Boolean)[0] || '';
  const m = seg.match(/^([a-z]{2})(?:-[a-z]{2})?$/i);
  return m ? m[1].toLowerCase() : null;
}

// Stage 1 — URL slugs only. Deliberately generous (a page that merely shares
// a word is still a candidate); stages 2 and 3 are what decide.
export const MAX_CANDIDATES = 5;
export function shortlistCandidates(signals, pages) {
  const coreSet = new Set(signals.core);
  return pages
    .map((p) => {
      const slugWords = words(pathOf(p.page)).filter((w) => w.length >= 2 && !STOPWORDS.has(w)).map(stem);
      return { page: p.page, overlap: slugWords.filter((w) => coreSet.has(w)).length };
    })
    .filter((p) => p.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, MAX_CANDIDATES);
}

function fraction(coreTokens, haystackWords) {
  if (!coreTokens.length) return 0;
  const set = new Set(haystackWords.map(stem));
  return coreTokens.filter((t) => set.has(t)).length / coreTokens.length;
}

// Stage 2 — returns { verdict: 'covered'|'not_covered'|'ambiguous', reasons, dimensions }.
export function assessCandidate(signals, page) {
  const { url, title, h1, metaDescription, bodyText, htmlLang } = page;
  const headlineWords = words(`${pathOf(url)} ${title || ''} ${h1 || ''}`);
  const supportWords = words(`${metaDescription || ''} ${(bodyText || '').slice(0, 3000)}`);

  const headline = fraction(signals.core, headlineWords);
  const anywhere = fraction(signals.core, [...headlineWords, ...supportWords]);

  let market = 'n/a';
  if (signals.market) {
    if (containsPhrase(headlineWords, signals.market) || MARKETS[signals.market].some((a) => containsPhrase(headlineWords, a))) market = 'match';
    else if (MARKETS[signals.market].some((a) => containsPhrase([...headlineWords, ...supportWords], a))) market = 'body-only';
    else market = 'missing';
  }

  const pageLang = pageLanguage(url, htmlLang);
  let language = 'unknown';
  if (pageLang && signals.confident) language = pageLang === signals.lang ? 'same' : 'different';
  else if (pageLang && !signals.confident) language = pageLang === 'en' ? 'same' : 'unknown';

  const pageIntent = pageIntentFromUrl(url);
  let intent = 'unknown';
  if (signals.intent !== 'unknown' && pageIntent !== 'unknown') intent = signals.intent === pageIntent ? 'same' : 'different';

  const dimensions = {
    coreInHeadline: Number(headline.toFixed(2)),
    coreAnywhere: Number(anywhere.toFixed(2)),
    market, language, intent,
    keywordMarket: signals.market, keywordLanguage: signals.confident ? signals.lang : null, pageLanguage: pageLang,
    keywordIntent: signals.intent, pageIntent,
  };

  // The keyword names a market the page never mentions at all: same topic in
  // a different market, which is its own search. Checked before the topic
  // comparison because it holds whatever the topic overlap is.
  if (market === 'missing') {
    return { verdict: 'not_covered', reasons: [`The page never mentions the ${signals.market} market this keyword targets.`], dimensions };
  }
  // Different language: core terms cannot be compared word-for-word ("KI" vs
  // "AI"), so a token mismatch proves nothing. Only a semantic judgment can
  // say whether the page would satisfy this query.
  if (language === 'different') {
    return { verdict: 'ambiguous', reasons: ['The keyword is in a different language than the page.'], dimensions };
  }
  if (headline < 0.5 && anywhere < 0.7) {
    return { verdict: 'not_covered', reasons: ['The page does not address the keyword\'s core topic.'], dimensions };
  }
  if (headline >= 0.99 && market !== 'body-only' && language !== 'different' && intent !== 'different') {
    return { verdict: 'covered', reasons: ['The page\'s URL/title/H1 address every core term, with no market, language or intent difference.'], dimensions };
  }
  return { verdict: 'ambiguous', reasons: ['Signals do not settle whether the page satisfies this query.'], dimensions };
}

const COVERAGE_SYSTEM = 'You judge whether an existing page ALREADY satisfies a target search query, so that a new page ' +
  'for it would be redundant. Mentioning the topic is NOT enough. Compare core topic, search intent, language, ' +
  'country/market, audience, and whether the page actually answers the query. A page on the generic topic does NOT cover ' +
  'a query that adds a different language, country/market, or intent. Respond with ONLY a JSON object: ' +
  '{"decision": "covered"|"partially_covered"|"not_covered", "covered_by": "<exact URL from the list>"|null, "reason": "<one short sentence>"}. ' +
  '"covered" only when one listed page fully satisfies the query; never pick a URL not in the list.';

function describe(c, i) {
  const d = c.assessment.dimensions;
  return `${i + 1}. ${c.url}\n   title: ${c.title || '—'} | h1: ${c.h1 || '—'}\n` +
    `   signals: coreInHeadline=${d.coreInHeadline}, market=${d.market}, language=${d.language}, intent=${d.intent}\n` +
    `   excerpt: ${(c.bodyText || '').slice(0, 600)}`;
}

/**
 * @param {object} args
 * @param {string} args.topic
 * @param {{page:string}[]} args.pages           this site's own-domain inventory
 * @param {(url:string)=>Promise<null|{title,h1,metaDescription,bodyText,htmlLang}>} args.fetchPage  null when unfetchable / too thin
 * @param {(system:string,user:string)=>Promise<object>} args.llm
 * @param {(signals,pages)=>Promise<{page:string}[]>} [args.shortlistForeign]  optional: cross-language shortlist when slugs share no word with the keyword
 * @returns {Promise<{decision, coveredBy, stage, checked, reasons, dimensions, candidates}>}
 */
export async function assessKeywordCoverage({ topic, pages, fetchPage, llm, shortlistForeign }) {
  const signals = keywordSignals(topic);
  if (!signals.core.length) {
    return { decision: COVERAGE.NOT_COVERED, coveredBy: null, stage: 'deterministic', checked: true, reasons: ['No meaningful terms in the keyword.'], dimensions: null, candidates: [] };
  }

  let shortlist = shortlistCandidates(signals, pages);
  if (!shortlist.length && signals.confident && shortlistForeign) {
    shortlist = (await shortlistForeign(signals, pages).catch(() => [])).slice(0, MAX_CANDIDATES);
  }
  if (!shortlist.length) {
    return { decision: COVERAGE.NOT_COVERED, coveredBy: null, stage: 'deterministic', checked: true, reasons: ['No existing page looks related to this keyword.'], dimensions: null, candidates: [] };
  }

  const fetched = await Promise.all(shortlist.map(async ({ page }) => {
    const content = await fetchPage(page).catch(() => null);
    return content ? { url: page, ...content } : null;
  }));
  const candidates = fetched.filter(Boolean).map((c) => ({ ...c, assessment: assessCandidate(signals, c) }));
  if (!candidates.length) {
    return { decision: COVERAGE.NOT_COVERED, coveredBy: null, stage: 'deterministic', checked: true, reasons: ['Related pages could not be read.'], dimensions: null, candidates: [] };
  }

  const summary = candidates.map((c) => ({ url: c.url, verdict: c.assessment.verdict, dimensions: c.assessment.dimensions }));

  const covered = candidates.find((c) => c.assessment.verdict === 'covered');
  if (covered) {
    return { decision: COVERAGE.COVERED, coveredBy: covered.url, stage: 'deterministic', checked: true, reasons: covered.assessment.reasons, dimensions: covered.assessment.dimensions, candidates: summary };
  }

  const ambiguous = candidates.filter((c) => c.assessment.verdict === 'ambiguous').slice(0, 3);
  if (!ambiguous.length) {
    // Every candidate was ruled out on a concrete difference. If one of them
    // shares the core topic and differs only in market/language/intent it is
    // "partially covered" — useful to show, and never suppresses the keyword.
    const sameTopic = candidates.find((c) => c.assessment.dimensions.coreInHeadline >= 0.5);
    return {
      decision: sameTopic ? COVERAGE.PARTIAL : COVERAGE.NOT_COVERED,
      coveredBy: null, stage: 'deterministic', checked: true,
      reasons: (sameTopic || candidates[0]).assessment.reasons,
      dimensions: (sameTopic || candidates[0]).assessment.dimensions,
      relatedPage: sameTopic?.url ?? null,
      candidates: summary,
    };
  }

  const user = `Target query: "${topic}"\n` +
    `Detected: language=${signals.confident ? signals.lang : 'unclear'}, market=${signals.market || 'none'}, intent=${signals.intent}\n\n` +
    `Candidate pages:\n${ambiguous.map(describe).join('\n\n')}`;
  try {
    const parsed = await llm(COVERAGE_SYSTEM, user);
    const url = typeof parsed?.covered_by === 'string' ? parsed.covered_by : null;
    const valid = url && ambiguous.some((c) => c.url === url);
    // A bare {covered_by} (the pre-pipeline response shape) means covered.
    const raw = parsed?.decision ?? (url ? COVERAGE.COVERED : COVERAGE.NOT_COVERED);
    const decision = Object.values(COVERAGE).includes(raw) ? raw : COVERAGE.NOT_COVERED;
    // Never trust a URL the model was not shown; "covered" without one cannot
    // suppress anything, so it degrades to partial.
    const final = decision === COVERAGE.COVERED && !valid ? COVERAGE.PARTIAL : decision;
    return {
      decision: final,
      coveredBy: final === COVERAGE.COVERED ? url : null,
      stage: 'llm', checked: true,
      reasons: [typeof parsed?.reason === 'string' && parsed.reason ? parsed.reason : 'Judged by comparing topic, intent, language and market.'],
      dimensions: ambiguous[0].assessment.dimensions,
      relatedPage: final === COVERAGE.PARTIAL ? (valid ? url : ambiguous[0].url) : null,
      candidates: summary,
    };
  } catch (e) {
    // Unknown, not "not covered": checked:false lets the caller retry later
    // instead of recording a verdict nothing actually reached.
    return { decision: COVERAGE.NOT_COVERED, coveredBy: null, stage: 'llm', checked: false, reasons: [`LLM unavailable: ${e.message}`], dimensions: ambiguous[0].assessment.dimensions, candidates: summary };
  }
}

// Pure helpers for news-based posts (agents/news-posts.js). The rule they enforce: a news article is a lead, never a source.
// A claim becomes a post topic only when the model can quote it from an official page we opened ourselves, and the quote is
// checked in code against that page's text, so a made-up quotation can never confirm anything.

const norm = (s) => String(s || '').toLowerCase().replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"').replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim();

const MIN_QUOTE_CHARS = 25;

/** Keeps only facts whose quote really appears (whitespace and case aside) in one of the opened pages. */
export function verifyFacts(facts, pages) {
  if (!Array.isArray(facts)) return [];
  const haystacks = pages.filter((p) => p?.ok && p.text).map((p) => ({ url: p.url, text: norm(p.text) }));
  const out = [];
  for (const f of facts) {
    const statement = typeof f?.statement === 'string' ? f.statement.trim() : '';
    const quote = typeof f?.quote === 'string' ? f.quote.trim() : '';
    if (!statement || quote.length < MIN_QUOTE_CHARS) continue;
    const q = norm(quote);
    const hit = haystacks.find((h) => h.text.includes(q));
    if (hit) out.push({ statement, quote, url: hit.url });
  }
  return out;
}

/** Cleans the model's candidate list: real headline indexes only, a country the project has official sources for, no repeats. */
export function validateCandidates(raw, items, countries) {
  if (!Array.isArray(raw)) return [];
  const byCountry = new Map(countries.map((c) => [norm(c), c]));
  const seen = new Set();
  const out = [];
  for (const c of raw) {
    const topic = typeof c?.topic === 'string' ? c.topic.trim() : '';
    const claim = typeof c?.claim === 'string' ? c.claim.trim() : '';
    const country = byCountry.get(norm(c?.country));
    const idxs = [...new Set((Array.isArray(c?.sources) ? c.sources : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < items.length))];
    if (!topic || !claim || !country || !idxs.length) continue;
    const key = `${country}|${norm(topic)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ topic, claim, country, leads: idxs.map((i) => ({ title: items[i].title, url: items[i].url, source: items[i].source, publishedAt: items[i].publishedAt })) });
  }
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthYear = (d = new Date()) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

const factLines = (facts) => facts.map((f) => `- ${f.statement}\n  Official wording: "${f.quote}"\n  Source: ${f.url}`).join('\n');

/** The context handed to the blog writer: only confirmed facts, every one with its official page. */
export function newsContext({ candidate, facts, styleRules, now = new Date() }) {
  const urls = [...new Set(facts.map((f) => f.url))];
  return `News-based article for readers considering study in ${candidate.country}. ` +
    `Topic: ${candidate.topic}. The change: ${candidate.claim}\n` +
    'Every number, fee, date or rule in the article must come ONLY from the confirmed official facts below, worded as the official page words it. ' +
    'General background is fine, but never add a figure, fee, date or rule that is not in the facts. If something would help the reader but is not confirmed, ' +
    'write that it should be checked on the official page and name the page, and never state it as fact. Do not quote or rely on news outlets. ' +
    'Open with a 1-3 sentence quick answer made only of facts that appear in the body; phrase most headings as the questions people search; keep paragraphs short; ' +
    'use a table for figures; end with a visible FAQ of 3-6 real questions. ' +
    `Add a "Sources" section linking these official pages: ${urls.join(', ')}. ` +
    `End with the line "Checked in ${monthYear(now)}" and say what to re-check and on which official page. No claims about named competitors.\n` +
    (styleRules ? `Client writing rules:\n${styleRules}\n` : '') +
    `Confirmed official facts:\n${factLines(facts)}`;
}

/** The same facts, for refreshing a page that already covers the topic. */
export function refreshFacts({ candidate, facts, now = new Date() }) {
  return `Official change to reflect on this page (${candidate.country}): ${candidate.claim}\n` +
    `Use ONLY these confirmed official facts, and update the "Checked in" line to ${monthYear(now)}.\n${factLines(facts)}`;
}

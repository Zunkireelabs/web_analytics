// REAL SOURCES ONLY (blog standard).
//
// The model may PROPOSE sources, but nothing it says is kept on its word. Every candidate is fetched by the server and kept only when ALL hold:
//   1. https, and a public host (the shared fetcher refuses private/local addresses);
//   2. the host is trusted: a government / education / intergovernmental domain, a short global list, or a domain the site itself lists
//      (newContentTargets['blog-outline'].trustedSourceDomains);
//   3. the page loads (HTTP 200, HTML) and was not redirected to a different host;
//   4. the page's own text actually contains the claim it is cited for (enough of the claim's distinctive words appear in it).
// The label shown to readers is the FETCHED page's own title, never the model's wording. A candidate failing any step is dropped, and a post with
// no verified source simply ships without a Sources list (a person adds it at review): never a guessed one.
import { analyzePageUrl } from '../../agents/lib/page-content.js';
import { callLLMForJson } from '../../llm.js';

export const MAX_SOURCES = 4;
const MAX_CANDIDATES = 8;

// Suffix match on the registrable end of the host. Government, education and intergovernmental bodies are trusted wherever they sit.
const TRUSTED_SUFFIXES = [
  '.gov', '.gov.uk', '.gov.au', '.gov.in', '.gov.np', '.gov.ie', '.gov.sg', '.gov.nz', '.gov.za', '.gc.ca', '.gouv.fr', '.europa.eu', '.mil',
  '.edu', '.ac.uk', '.edu.au', '.ac.nz', '.ac.in', '.edu.np',
  '.int',
];
const TRUSTED_HOSTS = [
  'wikipedia.org', 'who.int', 'nhs.uk', 'un.org', 'oecd.org', 'worldbank.org', 'imf.org', 'unesco.org', 'ons.gov.uk', 'legislation.gov.uk',
];

const STOP = new Set(['about', 'after', 'again', 'also', 'because', 'before', 'being', 'between', 'could', 'every', 'from', 'have', 'into', 'more', 'most',
  'other', 'over', 'should', 'since', 'some', 'such', 'than', 'that', 'their', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'until',
  'were', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'would', 'your', 'you', 'the', 'and', 'for', 'are', 'can', 'not', 'but']);

/** Host is a trusted source: a government/education/intergovernmental domain, the global list, or one the site named. Pure. */
export function isTrustedHost(hostname, extraDomains = []) {
  const h = String(hostname || '').toLowerCase().replace(/^www\./, '');
  if (!h || !h.includes('.')) return false;
  const matches = (d) => h === d || h.endsWith(`.${d}`);
  if (TRUSTED_SUFFIXES.some((s) => h.endsWith(s) || h === s.slice(1))) return true; // `.gov.uk` covers gov.uk itself and any subdomain, never `fakegov.uk`
  if (TRUSTED_HOSTS.some(matches)) return true;
  return (Array.isArray(extraDomains) ? extraDomains : []).map((d) => String(d).toLowerCase().replace(/^www\./, '')).filter(Boolean).some(matches);
}

const words = (text) => String(text || '').toLowerCase().match(/[a-z0-9£$%]+(?:'[a-z]+)?/g) || [];
const distinctive = (text) => [...new Set(words(text).filter((w) => w.length > 4 && !STOP.has(w)))];

/**
 * The claim is supported when enough of its distinctive words (at least 3, and at least half) appear in the fetched page. Deliberately a floor, not
 * a proof: it rejects a page that is merely on the same website, and the trusted-host rule rejects a page that is not an authority.
 */
export function claimSupported(claim, pageText) {
  const need = distinctive(claim);
  if (need.length < 3) return false; // a claim too vague to check supports nothing
  const have = new Set(words(pageText));
  const hit = need.filter((w) => have.has(w)).length;
  return hit >= 3 && hit / need.length >= 0.5;
}

// The page's own title as published, whitespace-collapsed. Never reworded.
function cleanTitle(title) {
  return String(title || '').replace(/\s+/g, ' ').trim().slice(0, 140);
}

/**
 * Verifies ONE proposed source. Returns { ok: true, source: { label, url } } or { ok: false, reason }.
 * `fetchPage` is injectable for tests (default: the shared page analyser, which refuses private hosts).
 */
export async function verifySource(candidate, { fetchPage = analyzePageUrl, extraDomains = [] } = {}) {
  let url;
  try { url = new URL(String(candidate?.url || '')); } catch { return { ok: false, reason: 'invalid-url' }; }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not-https' };
  if (!isTrustedHost(url.hostname, extraDomains)) return { ok: false, reason: 'untrusted-host' };
  const claim = String(candidate?.claim || '').trim();
  if (!claim) return { ok: false, reason: 'no-claim' };
  let res;
  try { res = await fetchPage(url.href); } catch { return { ok: false, reason: 'fetch-failed' }; }
  if (!res?.ok || !res.analysis) return { ok: false, reason: 'fetch-failed' };
  const a = res.analysis;
  if (a.wasRedirected) return { ok: false, reason: 'redirected' };
  const label = cleanTitle(a.title);
  if (!label) return { ok: false, reason: 'no-title' };
  if (!claimSupported(claim, `${a.title} ${a.bodyText || ''}`)) return { ok: false, reason: 'claim-not-on-page' };
  return { ok: true, source: { label, url: url.href } };
}

const PROPOSE_SYSTEM = 'You find authoritative sources for a finished blog post. For the most important factual claims in the post, give the exact page that ' +
  'states them: official government, regulator, university or intergovernmental pages are best. Give ONLY URLs you are confident really exist and really ' +
  'state the claim; if you are not sure of a URL, leave it out. Never invent a URL, never guess a path, prefer fewer sources over doubtful ones. ' +
  'Respond with ONLY a JSON array: [{"url": "https://...", "claim": "the sentence from the post this page supports"}].';

/**
 * Builds the verified Sources list for a post. Best-effort and NEVER throws: any failure means no sources, never a bad one.
 * Returns an array of { label, url } (possibly empty), at most MAX_SOURCES, one per URL, in the order proposed.
 */
export async function buildVerifiedSources(sections, topic, { extraDomains = [], fetchPage = analyzePageUrl, propose = null, max = MAX_SOURCES } = {}) {
  try {
    const post = (sections || []).filter((s) => s?.heading && s?.body).map((s) => `## ${s.heading}\n${s.body}`).join('\n\n');
    if (!post) return [];
    const proposed = propose
      ? await propose(post, topic)
      : await callLLMForJson(PROPOSE_SYSTEM, `Topic: ${topic}\n\nPost:\n${post.slice(0, 9000)}`, { task: 'content', maxTokens: 900 }).catch(() => null);
    if (!Array.isArray(proposed)) return [];
    const seen = new Set();
    const kept = [];
    for (const c of proposed.slice(0, MAX_CANDIDATES)) {
      if (kept.length >= max) break;
      const key = String(c?.url || '').replace(/#.*$/, '').replace(/\/$/, '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const v = await verifySource(c, { fetchPage, extraDomains });
      if (v.ok) kept.push(v.source);
    }
    return kept;
  } catch {
    return [];
  }
}

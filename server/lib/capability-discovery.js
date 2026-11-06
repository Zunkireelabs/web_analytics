import { analyzePageUrl } from '../agents/lib/page-content.js';
import { callLLMForJson } from '../llm.js';
import { proposeProductCapability, getProductCapabilities } from '../store/data-analyst.js';
import { siteOriginFor } from '../agents/lib/site-domain.js';

// Reads what a client actually sells, from the client's own site, when they arrive.
//
// Why this exists: product_capabilities is the foundation everything else stands on — market discovery seeds from it
// (market-seed-terms.js), gap relevance is judged against it (describeTenantForRelevance), and competitor footprints
// are filtered by it. Until now every row had to be typed in by hand at onboarding, so a client who was set up
// quickly had none, and the honest consequence was that paid research refused to run for them at all.
//
// TWO RULES, both deliberate:
//
//   1. PROPOSED, NEVER VERIFIED. Everything found here is written with status 'proposed', which the existing reads
//      deliberately ignore (getProductCapabilities(siteId, 'verified')). A person approves it before it steers a
//      single paid call or a single piece of content. A machine reading a homepage is a good first draft and a bad
//      source of truth — a tagline is not a service list, and "we help ambitious brands grow" is not an offering.
//   2. EVERY ROW CARRIES THE SENTENCE IT CAME FROM. The LLM must quote the page text that supports each capability,
//      and a candidate whose quote is not actually present on the page is dropped before storage. That makes the
//      reviewer's job reading rather than trusting, and makes an invented service impossible to approve by accident.

const MAX_CANDIDATES = 12;
// Below this there is not enough prose to state what a company sells, so reading it would be guessing. Deliberately
// low: a terse but legitimate homepage ("We offer X, Y and Z in <city>. Book online.") must not be refused, and the
// quote-grounding check below is the real protection against a vague page producing nonsense.
const MIN_PAGE_WORDS = 30;

const SYSTEM = 'You read a company\'s own web page and list ONLY the products or services it clearly states it offers. '
  + 'Return JSON: {"capabilities":[{"name":"...","category":"...","description":"...","evidence":"..."}]}. '
  + '"name" is 2-6 words, how the company itself names the thing. "category" is one short word if the page implies one, else null. '
  + '"description" is one plain sentence from what the page says, never invented. '
  + '"evidence" MUST be a verbatim sentence or phrase copied exactly from the page text that shows they offer it. '
  + 'Do NOT list: taglines, slogans, values, mission statements, industries served, technologies used, or anything you '
  + 'inferred rather than read. If the page does not clearly state what they sell, return an empty list. '
  + 'An empty list is the correct answer for a vague page.';

/**
 * Find what a site offers, propose it for review.
 *
 * Returns { ok, proposed, candidates[], skipped } — `skipped` names why nothing was found, so an empty result is
 * explainable ("the homepage says nothing concrete") rather than looking like a failure.
 */
export async function discoverCapabilities(site, { save = true, deps = {} } = {}) {
  const fetchPage = deps.analyzePageUrl || analyzePageUrl;
  const ask = deps.callLLMForJson || callLLMForJson;
  const propose = deps.proposeProductCapability || proposeProductCapability;

  const origin = (deps.siteOriginFor || siteOriginFor)(site);
  if (!origin) {
    return { ok: false, skipped: 'no_site_url', proposed: 0, candidates: [] };
  }

  const fetched = await fetchPage(origin).catch(() => null);
  if (!fetched || fetched.ok === false) {
    return { ok: false, skipped: 'page_unreadable', detail: fetched?.error || null, proposed: 0, candidates: [] };
  }
  // analyzePageUrl returns { ok, analysis: {...} }: the page's fields are on `.analysis`. Reading them off the result
  // itself found nothing on every real page and refused each one as "too thin" — caught only by running this on a real
  // client site, because the tests' fake returned the same wrong flat shape.
  const page = fetched.analysis || {};
  const pageText = `${page.title || ''}\n${page.metaDescription || ''}\n${(page.headingOutline || []).map((h) => h.text).join('\n')}\n${page.bodyText || ''}`.trim();
  if (pageText.split(/\s+/).filter(Boolean).length < MIN_PAGE_WORDS) {
    // Too little text to read anything from. Guessing from a near-empty page is how a wrong service list gets made.
    return { ok: false, skipped: 'page_too_thin', proposed: 0, candidates: [] };
  }

  const parsed = await ask(SYSTEM, `Company page:\n${pageText.slice(0, 6000)}`, {
    maxTokens: 900,
    generatorId: 'capability-discovery',
    siteId: site.id,
    validate: (p) => Array.isArray(p?.capabilities),
  }).catch(() => null);

  if (!parsed) return { ok: false, skipped: 'model_unavailable', proposed: 0, candidates: [] };

  const candidates = (parsed.capabilities || [])
    .map((c) => normalize(c))
    .filter(Boolean)
    // The grounding check: a quote the page does not contain means the model wrote it, not the company.
    .filter((c) => quoteAppearsOn(c.evidence, pageText))
    .slice(0, MAX_CANDIDATES);

  if (!candidates.length) {
    return { ok: true, skipped: 'nothing_clearly_offered', proposed: 0, candidates: [] };
  }

  let proposed = 0;
  if (save) {
    for (const c of candidates) {
      const row = await propose(site.id, {
        name: c.name,
        category: c.category,
        description: c.description,
        industries: [],
        details: { evidence: c.evidence, source: origin, discoveredAt: new Date().toISOString() },
      }).catch(() => null);
      if (row) proposed += 1;
    }
  }

  return { ok: true, skipped: null, proposed, candidates, source: origin };
}

function normalize(c) {
  const name = clean(c?.name, 80);
  const evidence = clean(c?.evidence, 400);
  if (!name || !evidence) return null;
  // A one-word name is a category ("Dental", "Marketing"), not something a company sells, and it is far too broad to
  // seed paid keyword research from. Rejected outright: a reviewer can add a genuinely one-word service by hand, and
  // that is the cheaper mistake to fix.
  if (name.split(/\s+/).filter(Boolean).length < 2) return null;
  return {
    name,
    category: clean(c?.category, 40) || null,
    description: clean(c?.description, 300) || null,
    evidence,
  };
}

const clean = (v, max) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s && s.length <= max ? s : (s ? s.slice(0, max) : null);
};

// Compared on letters and digits only, so punctuation, casing and collapsed whitespace do not cause a false reject on
// a quote that really is on the page.
export function quoteAppearsOn(quote, pageText) {
  const fold = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const needle = fold(quote);
  if (needle.length < 12) return false; // too short to prove anything
  return fold(pageText).includes(needle);
}

/**
 * Discovery for a site that has described nothing at all — the arrival case.
 *
 * Skipped the moment ANY capability exists in ANY state: a site with a verified list does not want a machine adding to
 * it, and one where a person rejected everything does not want the same proposals back. proposeProductCapability also
 * refuses a name a person already decided on, so this is belt and braces, and the early return is what keeps the paid
 * model call from being made at all.
 */
export async function discoverCapabilitiesIfNone(site, { deps = {} } = {}) {
  const existing = await (deps.getProductCapabilities || getProductCapabilities)(site.id, null).catch(() => null);
  if (existing === null) return { ok: false, skipped: 'could_not_check_existing', proposed: 0, candidates: [] };
  if (existing.length) return { ok: true, skipped: 'already_has_capabilities', proposed: 0, candidates: [] };
  return discoverCapabilities(site, { deps });
}

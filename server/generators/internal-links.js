import { getSearchPerformanceRange, getSiteById } from '../store/read.js';
import { analyzePageUrl, requireGroundedContent } from '../agents/lib/page-content.js';
import { ownDomains, filterOwnDomainPages, hostnameOf } from '../agents/lib/site-domain.js';
import { callLLMForJson } from '../llm.js';
import { findLinkSuggestionIssues } from './lib/output-guard.js';

export const meta = {
  id: 'internal-links',
  name: 'Internal Links Generator',
  description: 'Suggests internal link opportunities from a page\'s real text to other real ranking pages on the site.',
  recommendationTags: ['Add internal links', 'Missing internal links'],
};

const CANDIDATE_LIMIT = 30;
const DEFAULT_WINDOW_DAYS = 90;

function defaultRange() {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  return { start, end };
}

// params: { page: string, start?: string, end?: string, mustLinkTo?: string }
export async function generate({ siteId, params }) {
  const { page, mustLinkTo } = params;
  if (!page) throw Object.assign(new Error('page is required'), { status: 400 });
  const { start, end } = params.start && params.end ? params : defaultRange();

  const [fetched, site, otherPagesRaw] = await Promise.all([
    analyzePageUrl(page),
    getSiteById(siteId),
    getSearchPerformanceRange(siteId, start, end, 'page', CANDIDATE_LIMIT),
  ]);
  if (!fetched.ok) throw Object.assign(new Error(`Could not fetch page: ${fetched.error}`), { status: 400 });
  requireGroundedContent(fetched.analysis, { generatorId: meta.id });

  const domain = ownDomains(site);

  let candidates;
  if (mustLinkTo) {
    // Query-cannibalization resolution (query-intelligence.js's
    // pickCannibalizationWinner): the target is already decided by real
    // GSC-evidence scoring, not left for the model to pick — restricting the
    // candidate list to exactly that one URL routes it through the SAME
    // grounded-anchor-text/hallucination-safety pipeline as every other
    // internal-links draft (no bespoke content-injection path), while making
    // it structurally impossible for the model to link anywhere else.
    if (domain && !domain.includes(hostnameOf(mustLinkTo))) {
      throw Object.assign(new Error(`"${mustLinkTo}" is not on this site's own domain (${domain.join(', ')}) — refusing to link to a page we can't confirm is real.`), { status: 400 });
    }
    candidates = [mustLinkTo];
  } else {
    // Real candidate targets only — excludes the source page itself.
    candidates = filterOwnDomainPages(otherPagesRaw, domain)
      .map((p) => p.dim_value)
      .filter((url) => url !== page);
  }
  const candidateSet = new Set(candidates);

  if (!candidates.length) {
    return { content: { page, suggestions: [], note: 'No other ranking pages found in the recent window to link to.' }, summary: 'No internal link candidates found.' };
  }

  const system = 'You are an SEO editor. Given a page\'s real body text and a list of the site\'s other REAL ' +
    'ranking page URLs, suggest 3-5 internal link opportunities: a short anchor-text phrase drawn from or ' +
    'naturally insertable into the given page text, a targetUrl chosen ONLY from the candidate list given (never ' +
    'invent a URL not in that list), and a one-sentence rationale. Respond with ONLY a JSON array: ' +
    '[{"anchorText": "...", "targetUrl": "...", "rationale": "..."}]';
  const user = `Source page text: ${fetched.analysis.bodyText.slice(0, 2500)}\n\nCandidate target URLs:\n${candidates.join('\n')}`;
  let suggestions;
  try {
    suggestions = await callLLMForJson(system, user, { maxTokens: 600, generatorId: meta.id, siteId, pageUrl: page });
    if (!Array.isArray(suggestions)) throw new Error('not an array');
  } catch {
    throw Object.assign(new Error('Internal links generation failed: model did not return valid JSON'), { status: 400 });
  }

  // Deterministic safety check — never trust the model's URL alone: drop
  // any suggestion whose targetUrl isn't literally one of the real
  // candidates given, rather than let a hallucinated link through.
  const valid = suggestions.filter((s) => s && typeof s.anchorText === 'string' && candidateSet.has(s.targetUrl));
  const real = valid.slice(0, 5); // the cap is not a drop

  // Anchor guard (lib/output-guard.js): an anchor must describe the page it
  // links to. The target's real title is fetched once per distinct URL, so
  // "strong English proficiency" can't point at an AI guide. Best effort: a
  // page that can't be fetched is judged on its URL slug alone.
  const titles = new Map(await Promise.all([...new Set(real.map((s) => s.targetUrl))].map(async (url) => {
    const t = await analyzePageUrl(url).then((r) => (r.ok ? r.analysis.title : '')).catch(() => '');
    return [url, t || ''];
  })));
  const withTitles = real.map((s) => (titles.get(s.targetUrl) ? { ...s, targetTitle: titles.get(s.targetUrl) } : s));
  const badIdx = new Set(findLinkSuggestionIssues(withTitles).map((i) => Number(/^suggestions\[(\d+)\]/.exec(i.path)?.[1])));
  const clean = withTitles.filter((_, i) => !badIdx.has(i));
  const dropped = (suggestions.length - valid.length) + (real.length - clean.length);
  if (!clean.length && real.length) {
    throw Object.assign(
      new Error('Every suggested internal link had an anchor that does not describe its target page, so none was drafted.'),
      { status: 400, userFacing: true, refusal: true, reason: 'output-guard-failed' },
    );
  }

  const content = { page, suggestions: clean, droppedHallucinated: dropped };
  return { content, summary: `${clean.length} internal link suggestion(s)` + (dropped ? ` (${dropped} dropped — not a real candidate URL)` : '') };
}

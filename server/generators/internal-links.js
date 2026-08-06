import { getSearchPerformanceRange, getSiteById } from '../store/read.js';
import { analyzePageUrl } from '../agents/lib/page-content.js';
import { knownDomain, filterOwnDomainPages } from '../agents/lib/site-domain.js';
import { callLLMForJson } from '../llm.js';

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

// params: { page: string, start?: string, end?: string }
export async function generate({ siteId, params }) {
  const { page } = params;
  if (!page) throw Object.assign(new Error('page is required'), { status: 400 });
  const { start, end } = params.start && params.end ? params : defaultRange();

  const [fetched, site, otherPagesRaw] = await Promise.all([
    analyzePageUrl(page),
    getSiteById(siteId),
    getSearchPerformanceRange(siteId, start, end, 'page', CANDIDATE_LIMIT),
  ]);
  if (!fetched.ok) throw Object.assign(new Error(`Could not fetch page: ${fetched.error}`), { status: 400 });

  const domain = knownDomain(site);
  // Real candidate targets only — excludes the source page itself.
  const candidates = filterOwnDomainPages(otherPagesRaw, domain)
    .map((p) => p.dim_value)
    .filter((url) => url !== page);
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
    suggestions = await callLLMForJson(system, user, { maxTokens: 600 });
    if (!Array.isArray(suggestions)) throw new Error('not an array');
  } catch {
    throw Object.assign(new Error('Internal links generation failed: model did not return valid JSON'), { status: 400 });
  }

  // Deterministic safety check — never trust the model's URL alone: drop
  // any suggestion whose targetUrl isn't literally one of the real
  // candidates given, rather than let a hallucinated link through.
  const clean = suggestions.filter((s) => s && typeof s.anchorText === 'string' && candidateSet.has(s.targetUrl));
  const dropped = suggestions.length - clean.length;

  const content = { page, suggestions: clean.slice(0, 5), droppedHallucinated: dropped };
  return { content, summary: `${clean.length} internal link suggestion(s)` + (dropped ? ` (${dropped} dropped — not a real candidate URL)` : '') };
}

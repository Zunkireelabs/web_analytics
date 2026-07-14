import { getSiteById, getSearchPerformanceRange } from '../store/read.js';
import { analyzePageUrl, checkLlmsReadiness } from '../agents/lib/page-content.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'llms-txt',
  name: 'llms.txt & AI-Crawler Robots.txt Generator',
  description: 'Drafts a site-wide llms.txt discovery file and AI-crawler-aware robots.txt directives, grounded in the site\'s real top pages and current robots.txt/llms.txt status.',
  recommendationTags: [],
};

const KEY_PAGES_LIMIT = 8;
const MIN_IMPRESSIONS = 5;
const DEFAULT_WINDOW_DAYS = 90;
const PLACEHOLDER_NOTE = '[NEEDS INPUT — not verifiable from real site data]';

function defaultRange() {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  return { start, end };
}

// Site-level generator — no `page` param (unlike meta-title/faq/schema).
// params: { start?: string, end?: string, priorityPages?: string[] }
export async function generate({ siteId, params }) {
  const { start, end } = params.start && params.end ? params : defaultRange();
  const priorityPages = Array.isArray(params.priorityPages) ? params.priorityPages.slice(0, KEY_PAGES_LIMIT) : [];

  const [site, pagePerf] = await Promise.all([
    getSiteById(siteId),
    getSearchPerformanceRange(siteId, start, end, 'page', 100),
  ]);
  const siteName = site?.name || 'This site';

  // Real site origin, derived from an actual ranking page URL — same
  // technique ai-visibility.js uses, since gsc_property can be a
  // non-fetchable "sc-domain:" value and website_domain is freeform.
  let origin = null;
  for (const p of pagePerf) {
    try { origin = new URL(p.dim_value).origin; break; } catch { /* try next candidate */ }
  }
  if (!origin) {
    for (const url of priorityPages) {
      try { origin = new URL(url).origin; break; } catch { /* not usable either */ }
    }
  }
  if (!origin) {
    throw Object.assign(new Error('Could not determine the site\'s origin — no ranking page with a valid URL was found. Connect Search Console data first.'), { status: 400 });
  }

  const llmsReadiness = await checkLlmsReadiness(origin);

  // Ground "Key Pages" in real fetched titles/descriptions — never let the
  // model invent a page or its description. Priority pages always get a
  // slot; the rest fills from real top-impression pages.
  const rankedCandidates = pagePerf.filter((p) => Number(p.impressions) >= MIN_IMPRESSIONS).map((p) => p.dim_value);
  const candidateUrls = [...new Set([...priorityPages, ...rankedCandidates])].slice(0, KEY_PAGES_LIMIT);
  const impressionsByUrl = new Map(pagePerf.map((p) => [p.dim_value, Number(p.impressions)]));

  const keyPages = (await Promise.all(candidateUrls.map(async (url) => {
    const fetched = await analyzePageUrl(url);
    if (!fetched.ok) return null;
    return {
      url,
      title: fetched.analysis.title || null,
      metaDescription: fetched.analysis.metaDescription || null,
      impressions: impressionsByUrl.get(url) ?? null,
    };
  }))).filter(Boolean);

  const facts = { siteName, origin, llmsReadiness, keyPages };

  const system = 'You are an AEO (answer-engine optimization) foundations architect. Your job is discovery-layer ' +
    'infrastructure only: an llms.txt file and AI-crawler-aware robots.txt directives — not content or schema ' +
    'advice. Default posture is to ALLOW AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, ' +
    'Applebot-Extended) — in the robotsDirectives you output, every one of these MUST be set to Allow. This is ' +
    'not optional or a suggestion: blocking any of them by default is the most common AEO failure, and you must ' +
    'never emit a Disallow rule for any of them yourself. The ONLY crawler that defaults to Disallow is ' +
    'Bytespider (ByteDance, training-data scraping with no citation benefit). Separately — as a comment only, ' +
    'never as an actual directive you emit — you may note that blocking AI TRAINING crawlers specifically ' +
    '(GPTBot, ClaudeBot, Google-Extended, Applebot-Extended) while still allowing search-augmented crawlers like ' +
    'PerplexityBot is a business decision the site owner could choose to make later; do not act on that decision ' +
    'yourself under any circumstance — the directives you actually output must still Allow all of them. Ground the llms.txt ' +
    '"Key Pages" section ONLY in the real pages, titles, and meta descriptions given in `keyPages` below — never ' +
    'invent a page URL, title, or description not present there. If a fact needed for the file can\'t be ' +
    `verified from the data given, use the exact literal string "${PLACEHOLDER_NOTE}" — never invent it. State ` +
    'plainly in a comment whether robots.txt/llms.txt already exist for this site (from `llmsReadiness`) so the ' +
    'draft reads as "add this" vs "create this" appropriately. Respond with ONLY a JSON object: ' +
    '{"llmsTxt": "...", "robotsDirectives": "..."} — both values are full raw text file bodies (use \\n for ' +
    'newlines), not markdown-fenced.';
  const user = `Facts: ${JSON.stringify(facts)}`;
  const raw = await callLLM(system, user, { maxTokens: 900 });

  let parsed;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new Error('llms.txt generation failed: model did not return valid JSON');
  }

  const llmsTxt = typeof parsed.llmsTxt === 'string' ? parsed.llmsTxt : '';
  const robotsDirectives = typeof parsed.robotsDirectives === 'string' ? parsed.robotsDirectives : '';
  const placeholderCount = (llmsTxt.match(/\[NEEDS INPUT/g) || []).length + (robotsDirectives.match(/\[NEEDS INPUT/g) || []).length;

  const content = {
    siteName,
    origin,
    llmsReadiness,
    keyPages: keyPages.map(({ url, title, impressions }) => ({ url, title, impressions })),
    llmsTxt,
    robotsDirectives,
    placeholderCount,
  };
  return {
    content,
    summary: `llms.txt + AI-crawler robots.txt draft for ${origin} (${keyPages.length} key page(s)` +
      (placeholderCount ? `, ${placeholderCount} field(s) need manual input)` : ')'),
  };
}

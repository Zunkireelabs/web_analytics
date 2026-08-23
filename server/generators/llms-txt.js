import { getSiteById, getSearchPerformanceRange } from '../store/read.js';
import { analyzePageUrl, checkLlmsReadiness } from '../agents/lib/page-content.js';
import { ownDomains, filterOwnDomainPages } from '../agents/lib/site-domain.js';

export const meta = {
  id: 'llms-txt',
  name: 'llms.txt & AI-Crawler Robots.txt Generator',
  description: 'Drafts a site-wide llms.txt discovery file and AI-crawler-aware robots.txt directives, grounded entirely in the site\'s real top pages and current robots.txt/llms.txt content — no generated text.',
  recommendationTags: [],
};

const KEY_PAGES_LIMIT = 8;
const MIN_IMPRESSIONS = 5;
const DEFAULT_WINDOW_DAYS = 90;

// The exact answer-engine crawlers this tool advocates always allowing —
// same list ai-visibility.js's robotsAllowsAiCrawlers check already
// recognizes (page-content.js's ANSWER_ENGINE_CRAWLER_AGENTS), duplicated
// here as the literal set of User-agent blocks a fresh/appended robots.txt
// needs so a later check of the applied file actually passes.
const AI_CRAWLER_AGENTS = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended'];

// Deterministically builds robots.txt directives — never asks an LLM to
// invent robots rules, since (a) it has no way to know this site's real
// existing crawl rules (per-path Allow/Disallow, sitemap references, etc.)
// and a full-file overwrite from a model with no knowledge of that content
// would silently destroy them, and (b) the actual policy (always allow
// these 5 named answer-engine crawlers, disallow Bytespider) is fixed and
// fully known ahead of time — nothing here needs to be composed per-site.
// Returns null when the site's real robots.txt already passes
// robotsAllowsAiCrawlers (nothing to change — never fabricate a diff where
// none exists). Otherwise appends explicit named-bot Allow blocks to the
// END of the real existing file text (verbatim, untouched above that
// point) — a more specific named User-agent group taking precedence over a
// wildcard/blocking one is standard robots.txt matching behavior, so this
// never has to parse or rewrite the existing rules to take effect.
export function buildRobotsDirectives(llmsReadiness) {
  const botBlocks = AI_CRAWLER_AGENTS.map((bot) => `User-agent: ${bot}\nAllow: /`).join('\n\n');
  const bytespiderBlock = 'User-agent: Bytespider\nDisallow: /';

  if (!llmsReadiness.hasRobotsTxt) {
    return [
      '# AI answer-engine crawler access — added by Zunkiree Analytics',
      'User-agent: *',
      'Allow: /',
      '',
      botBlocks,
      '',
      bytespiderBlock,
    ].join('\n');
  }

  if (llmsReadiness.robotsAllowsAiCrawlers) return null;

  const existing = (llmsReadiness.robotsText || '').replace(/\s+$/, '');
  return [
    existing,
    '',
    '# AI answer-engine crawler access — appended by Zunkiree Analytics (existing rules above left untouched)',
    botBlocks,
    '',
    bytespiderBlock,
  ].join('\n');
}

function defaultRange() {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  return { start, end };
}

// A literal "[" or "]" in a real page title would otherwise break the
// markdown link syntax around it (e.g. a title containing "[Beta]").
function escapeLinkText(s) {
  return String(s ?? '').replace(/\[/g, '(').replace(/\]/g, ')');
}

// Deterministically assembles the actual llms.txt file body from real,
// verified facts only — siteName, keyPages, and now description (the
// site's own real homepage meta description, never LLM-composed).
// Guarantees the three real llms.txt convention signals (llmstxt.org) a
// compliance check looks for: a top-level "# Site Name" heading, real
// markdown links to key pages, and enough real content.
export function renderLlmsTxt({ siteName, description, keyPages }) {
  const lines = [`# ${siteName}`];
  if (description) lines.push('', description);
  lines.push('', '## Key Pages');
  for (const p of keyPages) {
    const title = escapeLinkText(p.title || p.url);
    const desc = p.metaDescription ? `: ${p.metaDescription}` : '';
    lines.push(`- [${title}](${p.url})${desc}`);
  }
  return lines.join('\n');
}

// Site-level generator — no `page` param (unlike meta-title/faq/schema).
// params: { start?: string, end?: string, priorityPages?: string[] }
export async function generate({ siteId, params }) {
  const { start, end } = params.start && params.end ? params : defaultRange();
  const priorityPages = Array.isArray(params.priorityPages) ? params.priorityPages.slice(0, KEY_PAGES_LIMIT) : [];

  const [site, pagePerfRaw] = await Promise.all([
    getSiteById(siteId),
    getSearchPerformanceRange(siteId, start, end, 'page', 100),
  ]);
  const siteName = site?.name || 'This site';
  const domain = ownDomains(site);
  const pagePerf = filterOwnDomainPages(pagePerfRaw, domain);

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

  // description is the site's own real, already-published homepage meta
  // description — verbatim, never LLM-paraphrased. If the homepage has
  // none, the description line is simply omitted (it's optional per the
  // llms.txt convention) rather than inventing one.
  const homepageFetch = await analyzePageUrl(`${origin}/`);
  const description = homepageFetch.ok ? (homepageFetch.analysis.metaDescription || '').trim() : '';

  const llmsTxt = renderLlmsTxt({ siteName, description, keyPages });
  // null when the real robots.txt already allows every AI crawler — never
  // fabricate a diff where none exists (see buildRobotsDirectives above).
  const robotsDirectives = buildRobotsDirectives(llmsReadiness);

  const content = {
    siteName,
    origin,
    llmsReadiness,
    keyPages: keyPages.map(({ url, title, impressions }) => ({ url, title, impressions })),
    llmsTxt,
    robotsDirectives,
  };
  return {
    content,
    summary: `llms.txt draft for ${origin} (${keyPages.length} key page(s))` +
      (robotsDirectives ? ' + robots.txt update' : ' — robots.txt already allows AI crawlers, no change needed'),
  };
}

import { getSiteById, getSearchPerformanceRange } from '../store/read.js';
import { analyzePageUrl, checkLlmsReadiness } from '../agents/lib/page-content.js';
import { knownDomain, filterOwnDomainPages } from '../agents/lib/site-domain.js';
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

// A literal "[" or "]" in a real page title would otherwise break the
// markdown link syntax around it (e.g. a title containing "[Beta]").
function escapeLinkText(s) {
  return String(s ?? '').replace(/\[/g, '(').replace(/\]/g, ')');
}

// Deterministically assembles the actual llms.txt file body — the only
// LLM-authored input is `description`; `siteName`/`keyPages` are already
// real, verified facts (never invented here). Guarantees the three real
// llms.txt convention signals (llmstxt.org) a compliance check looks for:
// a top-level "# Site Name" heading, real markdown links to key pages, and
// enough real content — regardless of how the model chose to phrase the
// description, unlike asking it to format the whole file itself.
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
  const domain = knownDomain(site);
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

  const facts = { siteName, origin, llmsReadiness, keyPages };

  // The LLM is asked for a short description + robots directives only —
  // never the llms.txt file's actual structure/headings/links. The real
  // llms.txt convention (llmstxt.org) requires a top-level "# Site Name"
  // heading and real markdown links to key pages; asking the model to
  // follow that format via instructions alone was unreliable in practice
  // (confirmed: a real merged draft came back as plain "Key Pages:\n- URL: ..."
  // labeled text, with no heading and no markdown links, failing a real
  // spec-compliance check). renderLlmsTxt() below builds that structure
  // deterministically from data already fully known/verified (siteName,
  // keyPages' real url/title/metaDescription) — same "never trust the LLM
  // for a checkable, derivable fact" discipline this codebase already
  // applies to FAQ JSON-LD (generators/faq.js) and detectMention
  // (agents/ai-recommendation.js).
  const system = 'You are an AEO (answer-engine optimization) foundations architect producing two things from ' +
    'the real facts given below: (1) a short 2-4 sentence PLAIN TEXT description of what this company/site does ' +
    '— grounded ONLY in the real page titles/meta descriptions in `keyPages`, never inventing a product, service, ' +
    'or fact not evidenced there — and (2) AI-crawler-aware robotsDirectives (full raw robots.txt directive text). ' +
    'Default posture is to ALLOW AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, ' +
    'Applebot-Extended) — in the robotsDirectives you output, every one of these MUST be set to Allow. This is ' +
    'not optional or a suggestion: blocking any of them by default is the most common AEO failure, and you must ' +
    'never emit a Disallow rule for any of them yourself. The ONLY crawler that defaults to Disallow is ' +
    'Bytespider (ByteDance, training-data scraping with no citation benefit). Separately — as a comment only, ' +
    'never as an actual directive you emit — you may note that blocking AI TRAINING crawlers specifically ' +
    '(GPTBot, ClaudeBot, Google-Extended, Applebot-Extended) while still allowing search-augmented crawlers like ' +
    'PerplexityBot is a business decision the site owner could choose to make later; do not act on that decision ' +
    'yourself under any circumstance — the directives you actually output must still Allow all of them. If a ' +
    'fact needed for either output can\'t be verified from the data given, use the exact literal string ' +
    `"${PLACEHOLDER_NOTE}" — never invent it. State plainly in a comment whether robots.txt already exists for ` +
    'this site (from `llmsReadiness`) so robotsDirectives reads as "add this" vs "update this" appropriately. ' +
    'Respond with ONLY a JSON object: {"description": "...", "robotsDirectives": "..."} — description is plain ' +
    'text (no markdown, no heading); robotsDirectives is the full raw file body (use \\n for newlines), not ' +
    'markdown-fenced.';
  const user = `Facts: ${JSON.stringify(facts)}`;
  const raw = await callLLM(system, user, { maxTokens: 700 });

  let parsed;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw Object.assign(new Error('llms.txt generation failed: model did not return valid JSON'), { status: 400 });
  }

  const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
  const robotsDirectives = typeof parsed.robotsDirectives === 'string' ? parsed.robotsDirectives : '';
  const llmsTxt = renderLlmsTxt({ siteName, description, keyPages });
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

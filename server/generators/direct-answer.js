import { getSearchPerformanceRange, getSiteById } from '../store/read.js';
import { knownDomain, filterOwnDomainPages } from '../agents/lib/site-domain.js';
import { callLLM, callLLMForJson } from '../llm.js';
import { analyzePageUrl, hasSufficientGroundingContent } from '../agents/lib/page-content.js';

// New file, not an extension of blog-outline.js — blog-outline's content
// shape is explicitly an OUTLINE (sections of heading+notes, no real prose),
// while a discovered search-query gap needs actual publishable body copy: a
// heading matching the query's own real phrasing, then a complete
// standalone direct-answer paragraph up front (the AI-citation
// "answer-first" pattern). Every generator in this codebase keeps one pure
// content shape per file rather than branching internally on shape.
export const meta = {
  id: 'direct-answer',
  name: 'Direct-Answer Content Generator',
  description: 'Drafts a real, publishable direct-answer section for a discovered search-query gap: a heading matching the query\'s real phrasing plus a 120-180 word direct-answer paragraph up front, grounded only in the site\'s own real services/content.',
  recommendationTags: [],
};

const CANDIDATE_LIMIT = 20;
const DEFAULT_WINDOW_DAYS = 90;
const MIN_WORDS = 120;
const MAX_WORDS = 180;
// Trimmed, not the whole page — this is grounding context for a prompt, not
// a page-repair task that needs the full body (c.f. qa-content.js's same
// 3000-char slice of bodyText for the same reason).
const GROUNDING_EXCERPT_CHARS = 3000;

function defaultRange() {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  return { start, end };
}

function wordCount(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

// One bounded retry, never a hard failure — a paragraph slightly outside
// 120-180 words is still a usable draft for a human reviewer, so this only
// improves the odds, it never blocks generation on a miss.
async function rewriteToWordCount(directAnswer, query) {
  const system = `Rewrite the given direct-answer paragraph to be between ${MIN_WORDS} and ${MAX_WORDS} words, keeping ` +
    'it a complete, standalone answer to the query, using ONLY facts already present in the given text — never add a ' +
    'new fact. Respond with ONLY the rewritten paragraph, no quotes, no markdown.';
  const user = `Query: ${query}\nCurrent paragraph (${wordCount(directAnswer)} words):\n${directAnswer}`;
  const raw = await callLLM(system, user, { maxTokens: 400 }).catch(() => null);
  return raw ? raw.trim() : directAnswer;
}

// params: { query: string, queryId?: number, context?: string, start?: string, end?: string }
export async function generate({ siteId, params }) {
  const { query, context } = params;
  if (!query) throw Object.assign(new Error('query is required'), { status: 400 });
  const { start, end } = params.start && params.end ? params : defaultRange();

  const [site, otherPagesRaw] = await Promise.all([
    getSiteById(siteId),
    getSearchPerformanceRange(siteId, start, end, 'page', CANDIDATE_LIMIT),
  ]);
  const domain = knownDomain(site);
  const otherPages = filterOwnDomainPages(otherPagesRaw, domain);
  const candidates = otherPages.map((p) => p.dim_value);
  const candidateSet = new Set(candidates);

  // Best-effort, not a hard gate: this generator drafts NEW content for a
  // query no existing page answers, so unlike qa-content.js/expand-content.js
  // (which refuse via requireGroundedContent when their one target page can't
  // be grounded), a homepage fetch failure here must not block a legitimate
  // new-topic draft over an unrelated homepage hiccup. When it succeeds, it
  // replaces "ground every claim, trust me" prompt wording with real fetched
  // text to ground against — see server/agents/lib/page-content.js.
  const homepage = domain ? `https://${domain}/` : null;
  const fetched = homepage ? await analyzePageUrl(homepage).catch(() => ({ ok: false })) : { ok: false };
  const grounded = fetched.ok && hasSufficientGroundingContent(fetched.analysis);
  const groundingExcerpt = grounded ? fetched.analysis.bodyText.slice(0, GROUNDING_EXCERPT_CHARS) : null;

  const system = 'You are a content strategist producing a real, publishable direct-answer section for a discovered ' +
    'search-query gap — the AI-citation "answer-first" pattern: a heading that echoes the real query\'s own phrasing, ' +
    `followed immediately by a complete, standalone ${MIN_WORDS}-${MAX_WORDS} word paragraph that directly answers it. ` +
    (groundingExcerpt
      ? 'Ground every claim about this business ONLY in the "Real site content" text given below — never invent a ' +
        'fact, statistic, or offering not evidenced in it. '
      : 'Ground every claim ONLY in the real context given below — never invent a fact, statistic, or offering not ' +
        'evidenced in it. ') +
    'If internal-link candidate URLs are given, you may suggest linking to them where topically ' +
    'relevant (choosing ONLY from that list — never invent a URL). Respond with ONLY a JSON object: {"title": "...", ' +
    '"heading": "...", "directAnswer": "...", "supportingSections": [{"heading": "...", "body": "..."}], ' +
    '"suggestedFaqTopics": ["...", "..."], "suggestedInternalLinks": [{"anchorText": "...", "targetUrl": "..."}]}';
  const user = `Query: ${query}${context ? `\nContext: ${context}` : ''}` +
    (groundingExcerpt ? `\n\nReal site content (from ${homepage}):\n${groundingExcerpt}` : '') +
    `\n\nInternal link candidates:\n${candidates.join('\n') || '(none available)'}`;
  let parsed;
  try {
    parsed = await callLLMForJson(system, user, { maxTokens: 900, generatorId: meta.id, siteId });
  } catch {
    throw Object.assign(new Error('Direct-answer generation failed: model did not return valid JSON'), { status: 400 });
  }

  let directAnswer = parsed.directAnswer || '';
  const wc = wordCount(directAnswer);
  if (wc && (wc < MIN_WORDS || wc > MAX_WORDS)) {
    directAnswer = await rewriteToWordCount(directAnswer, query);
  }

  const suggestedInternalLinks = (Array.isArray(parsed.suggestedInternalLinks) ? parsed.suggestedInternalLinks : [])
    .filter((s) => s && typeof s.anchorText === 'string' && candidateSet.has(s.targetUrl));

  const content = {
    query,
    title: parsed.title || '',
    heading: parsed.heading || query,
    directAnswer,
    supportingSections: Array.isArray(parsed.supportingSections) ? parsed.supportingSections : [],
    suggestedFaqTopics: Array.isArray(parsed.suggestedFaqTopics) ? parsed.suggestedFaqTopics : [],
    suggestedInternalLinks,
  };
  return { content, summary: `Direct-answer draft for "${query}" (${wordCount(directAnswer)} words)` };
}

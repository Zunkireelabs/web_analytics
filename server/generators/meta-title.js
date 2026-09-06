import { analyzePageUrl, hasSufficientGroundingContent } from '../agents/lib/page-content.js';
import { callLLM, callLLMForJson } from '../llm.js';

export const meta = {
  id: 'meta-title',
  name: 'Meta Title & Description Generator',
  description: 'Drafts a page title tag and meta description grounded in the real page content and target query.',
  recommendationTags: ['Improve title', 'Improve meta'],
};

const TITLE_MIN = 50;
const TITLE_MAX = 60;
const DESC_MIN = 150;
const DESC_MAX = 160;

// The system prompt already asks for 50-60/150-160 characters, but the
// model doesn't reliably hit it (confirmed: 2 of 3 title candidates landed
// under range on a real run) and nothing checked the count before now —
// so an out-of-range draft shipped every time, silently. One bounded
// retry, never a hard failure — same convention as direct-answer.js's
// rewriteToWordCount: a candidate slightly outside range is still usable,
// this only improves the odds.
async function rewriteToLength(text, label, min, max, query, generatorId, siteId) {
  const system = `Rewrite the given ${label} to be between ${min} and ${max} characters, keeping it a natural, ` +
    `accurate ${label} for the query "${query}" — using ONLY facts already present in the given text, never adding ` +
    'a new claim. Respond with ONLY the rewritten text, no quotes, no markdown.';
  const user = `Current ${label} (${text.length} characters): ${text}`;
  const raw = await callLLM(system, user, { maxTokens: 200, generatorId, siteId }).catch(() => null);
  return raw ? raw.trim() : text;
}

async function enforceLength(text, label, min, max, query, generatorId, siteId) {
  if (!text || (text.length >= min && text.length <= max)) return text;
  const rewritten = await rewriteToLength(text, label, min, max, query, generatorId, siteId);
  return rewritten;
}

// params: { page?: string, query: string }
export async function generate({ siteId, params }) {
  const { page, query } = params;
  if (!query) throw Object.assign(new Error('query is required'), { status: 400 });

  let pageContext = null;
  if (page) {
    const fetched = await analyzePageUrl(page);
    // Same "thin extraction treated as failed fetch" rule as faq.js — falls
    // through to this generator's existing "no page content given" mode
    // rather than grounding the title/description in leftover boilerplate.
    if (fetched.ok && hasSufficientGroundingContent(fetched.analysis)) {
      pageContext = { currentTitle: fetched.analysis.title, bodyExcerpt: fetched.analysis.bodyText.slice(0, 1500) };
    }
  }

  const system = 'You are a technical SEO specialist who treats title tags and meta descriptions as data-driven, ' +
    'not creative-writing, exercises: character-length discipline and query-intent match matter more than clever ' +
    'phrasing. Given a real target search query and (if available) the page\'s current title and real body text, ' +
    'draft 3 candidate <title> tags (50-60 characters, include the query\'s core terms naturally, no clickbait) ' +
    'and one meta description (150-160 characters). Stay tightly scoped to ONLY this query\'s core terms — do ' +
    'not add other head-term keywords the page doesn\'t already rank for, since that risks cannibalizing another ' +
    'page on the same site that owns a different query. If the body text shows real E-E-A-T signals (author ' +
    'expertise, credentials, first-hand experience, cited sources), you may reflect them in the meta description ' +
    '— but ground every claim ONLY in the page content given; never invent a feature, price, credential, or fact ' +
    'not present in the excerpt. If no page content is given, write generically around the query only. Respond ' +
    'with ONLY a JSON object: {"titles": ["...", "...", "..."], "metaDescription": "..."}';
  const user = `Query: ${query}\n${pageContext ? `Current title: ${pageContext.currentTitle}\nPage text: ${pageContext.bodyExcerpt}` : 'No existing page — new content.'}`;
  let parsed;
  try {
    parsed = await callLLMForJson(system, user, { maxTokens: 400, generatorId: meta.id, siteId });
  } catch {
    throw Object.assign(new Error('Meta title generation failed: model did not return valid JSON'), { status: 400 });
  }

  const rawTitles = Array.isArray(parsed.titles) ? parsed.titles.slice(0, 3) : [];
  const titles = await Promise.all(
    rawTitles.map((t) => enforceLength(t, 'title', TITLE_MIN, TITLE_MAX, query, meta.id, siteId)),
  );
  const rawDescription = typeof parsed.metaDescription === 'string' ? parsed.metaDescription : '';
  const metaDescription = await enforceLength(rawDescription, 'meta description', DESC_MIN, DESC_MAX, query, meta.id, siteId);

  const content = { query, page: page || null, titles, metaDescription };
  return { content, summary: `${content.titles.length} title option(s) + meta description for "${query}"` };
}

import { analyzePageUrl, hasSufficientGroundingContent } from '../agents/lib/page-content.js';
import { callLLM, callLLMForJson } from '../llm.js';
import { getSiteById } from '../store/read.js';
import { searchClaimsFor, titleClaimBansFor, findBannedPhrases } from './lib/visible-claim-guard.js';
import { llmFailure } from './lib/llm-error.js';

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
  const raw = await callLLM(system, user, { task: 'content', maxTokens: 200, generatorId, siteId }).catch(() => null);
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

  // A restore (agents/lib/protected-title-trials.js): put back the exact title and description an automatic change
  // replaced. No model call and no length rewriting, because the point is the page's own previous wording, unchanged.
  if (params.restore) {
    const { title, description } = params.restore;
    if (!title) throw Object.assign(new Error('restore needs the previous title'), { status: 400 });
    const content = { query, page: page || null, titles: [title], selectedTitle: title, metaDescription: description || '', restoreOfDraftId: params.restore.ofDraftId ?? null };
    return { content, summary: `Restore the previous title for "${query}"` };
  }

  let pageContext = null;
  let previous = null;
  let isArticlePage = false;
  if (page) {
    const fetched = await analyzePageUrl(page);
    // Same "thin extraction treated as failed fetch" rule as faq.js — falls
    // through to this generator's existing "no page content given" mode
    // rather than grounding the title/description in leftover boilerplate.
    // What the page has now, kept on the draft so an automatic change on a protected page can be put back
    // (protected-title-trials.js). Recorded even when the page is too thin to ground a rewrite.
    isArticlePage = Boolean(fetched.ok && fetched.analysis?.isArticlePage);
    if (fetched.ok) previous = { title: fetched.analysis.title || null, description: fetched.analysis.metaDescription || null };
    if (fetched.ok && hasSufficientGroundingContent(fetched.analysis)) {
      pageContext = { currentTitle: fetched.analysis.title, bodyExcerpt: fetched.analysis.bodyText.slice(0, 1500) };
    }
  }

  // Phrases this business wants to be found for in search. They live ONLY in
  // the title tag and meta description (never on the page body — see
  // visible-claim-guard.js), so the owner's wording is honoured where search
  // engines read it. A site with none configured is unchanged.
  const site = await getSiteById(siteId).catch(() => null);
  const searchClaims = searchClaimsFor(site);
  // Words this site never wants in a title or description (titleClaimBans), on every page except a blog post / article.
  const titleBans = isArticlePage ? [] : titleClaimBansFor(site);
  const titleBanNote = titleBans.length
    ? ` Never use any of these words or phrases anywhere in a title or the meta description: ${titleBans.map((b) => `"${b}"`).join(', ')}. ` +
      'Describe the business in other plain, accurate words instead (for example "partner" or "advisors").'
    : '';
  const searchClaimNote = searchClaims.length
    ? ` This business wants to be found in search for: ${searchClaims.map((c) => `"${c}"`).join(', ')}. ` +
      'When a phrase fits the query and the page topic, use it naturally and verbatim in at least one title candidate ' +
      'and in the meta description; never force it into an unrelated query.'
    : '';
  const system = 'You are a technical SEO specialist who treats title tags and meta descriptions as data-driven, ' +
    'not creative-writing, exercises: character-length discipline and query-intent match matter more than clever ' +
    'phrasing. Given a real target search query and (if available) the page\'s current title and real body text, ' +
    'draft 3 candidate <title> tags (50-60 characters, include the query\'s core terms naturally, no clickbait) ' +
    'and one meta description (150-160 characters). Stay tightly scoped to ONLY this query\'s core terms — do ' +
    'not add other head-term keywords the page doesn\'t already rank for, since that risks cannibalizing another ' +
    'page on the same site that owns a different query. If the body text shows real E-E-A-T signals (author ' +
    'expertise, credentials, first-hand experience, cited sources), you may reflect them in the meta description ' +
    '— but ground every claim ONLY in the page content given; never invent a feature, price, credential, or fact ' +
    'not present in the excerpt.' + searchClaimNote + titleBanNote + ' If no page content is given, write generically around the query only. Respond ' +
    'with ONLY a JSON object: {"titles": ["...", "...", "..."], "metaDescription": "..."}';
  const user = `Query: ${query}\n${pageContext ? `Current title: ${pageContext.currentTitle}\nPage text: ${pageContext.bodyExcerpt}` : 'No existing page — new content.'}`;
  const attempt = async (extraSystem = '') => {
    let parsed;
    try {
      parsed = await callLLMForJson(system + extraSystem, user, { task: 'content', maxTokens: 400, generatorId: meta.id, siteId });
    } catch (err) {
      throw llmFailure(err, 'Meta title generation failed: model did not return valid JSON', { status: 400 });
    }
    const rawTitles = Array.isArray(parsed.titles) ? parsed.titles.slice(0, 3) : [];
    const candidateTitles = await Promise.all(
      rawTitles.map((t) => enforceLength(t, 'title', TITLE_MIN, TITLE_MAX, query, meta.id, siteId)),
    );
    const rawDescription = typeof parsed.metaDescription === 'string' ? parsed.metaDescription : '';
    const description = await enforceLength(rawDescription, 'meta description', DESC_MIN, DESC_MAX, query, meta.id, siteId);
    return { titles: candidateTitles, metaDescription: description };
  };
  const banned = (r) => findBannedPhrases(`${r.titles.join(' ')} ${r.metaDescription}`, titleBans);
  let result = await attempt();
  if (titleBans.length && banned(result).length) {
    // One retry that names the offending words, then drop any title still carrying one. A draft is never refused for a single bad
    // candidate, only when nothing clean is left — and a description that still has the word fails loudly instead of shipping it.
    result = await attempt(` Your previous answer used a word this site does not allow (${banned(result).map((b) => `"${b}"`).join(', ')}). Rewrite without it.`);
    result = { titles: result.titles.filter((t) => !findBannedPhrases(t, titleBans).length), metaDescription: result.metaDescription };
    if (!result.titles.length || findBannedPhrases(result.metaDescription, titleBans).length) {
      throw Object.assign(new Error(`Meta title generation failed: the model kept using a phrase this site does not allow (${titleBans.join(', ')}). Try again or write the title by hand.`), { status: 400 });
    }
  }
  const { titles, metaDescription } = result;

  const content = { query, page: page || null, titles, metaDescription, ...(previous ? { previous } : {}) };
  return { content, summary: `${content.titles.length} title option(s) + meta description for "${query}"` };
}

// ARTICLE-LEVEL VALIDATION for a finished blog draft, in the shape the Quality Gate (generators/lib/quality-gate.js) already uses, so a failure gets
// the existing bounded REGENERATION with a correction (generateDraft feeds `correction` back to blog-outline as designCorrections) and a final failure
// is a refusal of THIS article only: its siblings keep shipping. Covers what the existing guards do not: statistics with no verified source
// (fabrication), a finished title that duplicates something already in the content index, and the SEO / AEO / internal-link basics.
// Placeholders, scaffolding, empty sections, competitor links, design integrity and ungrounded business claims are already enforced by the gate's
// own guards; routes, rendering and layout by pushDraftBranch's gates. This adds, it does not repeat.
//
// BLOG_ARTICLE_GATE: 'off' | 'log' (default: every issue is reported with blocking:false, so nothing is refused) | 'enforce'.
import { checkTopicAgainstIndex } from '../content-index/check.js';
import { blogArticleGateMode } from './ceiling.js';

export const ARTICLE_THRESHOLDS = Object.freeze({ titleMin: 15, titleMax: 75, metaMin: 70, metaMax: 170 });

const sentences = (text) => String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).filter(Boolean);
// A sentence that states a verifiable fact as a number or an appeal to research. Such a sentence needs a real source behind it.
const HARD_CLAIM = [
  /\b\d{1,3}(?:[.,]\d+)?\s?(?:%|per\s?cent|percent)/i,
  /\b\d+\s+(?:out of|in every)\s+\d+\b/i,
  /\b(?:according to|a (?:recent )?(?:study|survey|report) (?:by|from|found|shows?)|studies (?:show|have shown|suggest|found)|research (?:shows?|has shown|indicates|suggests))\b/i,
  /\b(?:average|median)\b[^.]{0,60}(?:£|\$|€|rs\.?\s?|npr\s?|usd\s?)\s?\d/i,
];

export const wordCount = (sections) => (sections || []).reduce((n, s) => n + String(s?.body || '').split(/\s+/).filter(Boolean).length, 0);
const internalLinks = (sections) => (sections || []).reduce((n, s) => n + (String(s?.body || '').match(/\]\((?:\/(?!\/)|https?:\/\/(?:www\.)?[^)\s]*\))/g) || []).length, 0);

/** Pure. @returns {{ issues: Array, stats: object }} issues carry { patternId, detail, correction, blocking }. */
export function validateBlogContent(content, { entries = [], ownDraftId = null, thresholds = ARTICLE_THRESHOLDS } = {}) {
  const issues = [];
  const add = (patternId, detail, correction, blocking, snippet = '') => issues.push({ path: 'content', patternId, snippet: String(snippet).slice(0, 200), detail, correction, blocking });
  const sections = Array.isArray(content?.sections) ? content.sections : [];
  const body = sections.map((s) => `${s?.heading || ''}. ${s?.body || ''}`).join(' ');
  const verified = Array.isArray(content?.sources) && content.sources.length > 0;

  // fabrication: statistics and appeals to research with no verified source behind the post
  const claims = sentences(body).filter((s) => HARD_CLAIM.some((re) => re.test(s)));
  if (claims.length && !verified) {
    const shown = claims.slice(0, 3).map((c) => `"${c.slice(0, 140)}"`).join('; ');
    add('blog-unsupported-statistics', `This post states ${claims.length} statistic(s) or research finding(s) but none of its sources could be verified, so they cannot be trusted: ${shown}`,
      `Remove every statistic, percentage and "studies show"-style claim you cannot support with a real, citable source, and say the same thing in plain words without invented numbers. Affected: ${shown}`, true, claims[0]);
  }

  // The finished article must not duplicate content that is already LIVE (published or merged). Drafts and open PRs are deliberately not compared here:
  // a regenerated draft (a revision, a repair attempt) would match its own earlier version. Something already in flight is caught earlier, when the
  // topic is selected (blog-cycle/select.js) and again by the pre-draft verifier (generators/lib/blog-topic-verifier.js).
  const live = entries.filter((e) => e.state === 'published' || e.state === 'merged');
  for (const [label, text] of [['title', content?.title], ['topic', content?.topic]]) {
    if (!text) continue;
    const r = checkTopicAgainstIndex({ topic: text, entries: live, ignoreDraftIds: ownDraftId != null ? [ownDraftId] : [] });
    if (!r.ok) { add('blog-duplicates-existing-content', r.reason, `This ${label} repeats existing content. Choose a clearly different angle, audience or question for this post, and a title that does not match the existing one.`, true, text); break; }
  }

  // SEO basics (never blocking: a person can retitle in review)
  const t = String(content?.title || '').trim();
  if (!t) add('blog-missing-title', 'The post has no title.', 'Give the post a clear, specific title.', true);
  else if (t.length < thresholds.titleMin || t.length > thresholds.titleMax) add('blog-title-length', `The title is ${t.length} characters (aim for ${thresholds.titleMin}-${thresholds.titleMax}).`, `Rewrite the title to ${thresholds.titleMin}-${thresholds.titleMax} characters.`, false, t);
  const m = String(content?.metaDescription || '').trim();
  if (!m) add('blog-missing-meta-description', 'The post has no meta description.', `Add a meta description of ${thresholds.metaMin}-${thresholds.metaMax} characters.`, false);
  else if (m.length < thresholds.metaMin || m.length > thresholds.metaMax) add('blog-meta-description-length', `The meta description is ${m.length} characters (aim for ${thresholds.metaMin}-${thresholds.metaMax}).`, `Rewrite the meta description to ${thresholds.metaMin}-${thresholds.metaMax} characters.`, false, m);
  const headings = sections.map((s) => String(s?.heading || '').trim().toLowerCase()).filter(Boolean);
  if (new Set(headings).size !== headings.length) add('blog-duplicate-headings', 'Two sections share the same heading.', 'Give every section its own distinct heading.', false);

  // GEO / AEO: a direct answer an AI engine can quote
  if (!content?.quickAnswer && !(Array.isArray(content?.faqItems) && content.faqItems.length)) add('blog-no-direct-answer', 'The post has neither a quick answer nor FAQ items, so an AI engine has no direct answer to quote.', 'Open with a one-to-two sentence direct answer to the main question, grounded in the post.', false);

  // internal linking
  const links = internalLinks(sections);
  if (links === 0) add('blog-no-internal-links', 'The post links to no other page on this site.', 'Link to at least two relevant pages from this site, only using the pages you were given.', false);

  return { issues, stats: { words: wordCount(sections), sections: sections.length, internalLinks: links, hardClaims: claims.length, verifiedSources: verified ? content.sources.length : 0 } };
}

/**
 * The Quality Gate hook (one line in generators/lib/quality-gate.js). Blog posts only. In 'log' mode every issue is non-blocking.
 * Never throws: a failure to read the index only skips the duplicate check.
 */
export async function findBlogCycleIssues(generatorId, content, siteId, { mode = blogArticleGateMode(), getEntries = null } = {}) {
  if (generatorId !== 'blog-outline' || mode === 'off') return [];
  let entries = [];
  try {
    entries = (await (getEntries || (async (id) => (await (await import('../content-index/store.js')).getFreshContentIndex(id)).entries))(siteId)) || [];
  } catch { entries = []; }
  const { issues } = validateBlogContent(content, { entries });
  return mode === 'enforce' ? issues : issues.map((i) => ({ ...i, blocking: false }));
}

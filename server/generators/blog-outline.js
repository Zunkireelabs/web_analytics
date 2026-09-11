import { getSearchPerformanceRange, getSiteById } from '../store/read.js';
import { knownDomain, ownDomains, filterOwnDomainPages } from '../agents/lib/site-domain.js';
import { callLLMForJson } from '../llm.js';
import { analyzePageUrl, hasSufficientGroundingContent } from '../agents/lib/page-content.js';
import { searchImage, buildImageQueries, configured as imagesConfigured } from './lib/pexels-client.js';
import { usedPhotoIds } from './lib/blog-image-usage.js';
import { imageQueryContextFor, IMAGE_CANDIDATE_POOL } from './lib/blog-image-query.js';
import { pageStructureGuidance } from './lib/design-aware-composer.js';
import { getSeoPolicy } from '../store/site-seo-policy.js';
import { getSiteProfile } from '../store/data-analyst.js';
import { tenantIndustries } from '../agents/lib/seo-tenant-context.js';
import { attributionNote, globalGrowthNote } from '../agents/lib/zunkireelabs-growth-policy.js';

// Was an outline-only generator (sections of heading+notes, no real prose) —
// changed 2026-08-07 because that shape was shipping straight into a real PR
// via implementers/frontend.js with no completeness check, i.e. an
// intentionally unfinished draft was reaching production as if it were a
// real blog post. Now produces a complete, publication-ready article
// (sections of heading+body prose) and is no longer exempt from
// lib/content-scaffolding-guard.js. Kept generatorId 'blog-outline' —
// renaming would break existing recommendations/drafts rows, url_file_map
// newContentTargets config, and risk-tiers/execution-jobs lookups keyed on
// it — the id is legacy, the output shape is not.
export const meta = {
  id: 'blog-outline',
  name: 'Blog Post Generator',
  description: 'Drafts a complete, publication-ready blog post covering a topic the site doesn\'t yet serve, with real internal-link suggestions.',
  recommendationTags: [], // sourced from content-gap's aiSuggestions, not a deterministic gap tag
};

const CANDIDATE_LIMIT = 20;
const DEFAULT_WINDOW_DAYS = 90;
// Floor for a real SEO blog post, not a thin/stub page. Below this after one
// bounded expand attempt, generation is rejected outright (see generate()
// below) rather than shipped as a draft — matches this repo's "regenerate
// until complete, never publish a stub" rule for net-new content.
const MIN_TOTAL_WORDS = 800;
// A single expand pass reliably lands close to but still under
// MIN_TOTAL_WORDS on some runs (LLMs undershoot an unstated-feeling target
// even when a hard number is given) — e.g. a real run that landed at 740/800
// and was rejected outright despite being 92% of the way there. Bounded (not
// unbounded) for the same reason callLLMForJson's own JSON retry is bounded:
// each attempt recomputes the real shortfall against the latest sections, so
// a second pass targets "60 more words", not "260 more".
//
// Raised from 2 to 3 (2026-08-31): site 1's real outcomes showed 2 of 4
// recent attempts still rejected outright after 2 attempts, landing at
// 703/800 and 726/800 — 71-97 words short, well within what one more bounded
// pass targeting the exact remaining shortfall should close. That 50%
// rejection rate on a near-miss shortfall was enough on its own to demote
// this generator out of auto-execute (generator-learning.js), burying 66
// unrelated open blog-outline recommendations behind it.
const MAX_EXPAND_ATTEMPTS = 3;
// Trimmed, not the whole page — grounding context for a prompt, same reason
// and size as qa-content.js's/direct-answer.js's own bodyText slice.
const GROUNDING_EXCERPT_CHARS = 3000;

function defaultRange() {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  return { start, end };
}

function wordCount(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

function totalWords(sections) {
  return sections.reduce((sum, s) => sum + wordCount(s?.body), 0);
}

// One bounded expand pass, same "one bounded retry" convention as
// direct-answer.js's rewriteToWordCount/meta-title.js's rewriteToLength —
// asks the model to flesh out thin sections with more real prose using only
// facts already established, never inventing new ones.
async function expandSections(sections, topic) {
  const currentWords = totalWords(sections);
  // A vague "add more detail" instruction reliably lands just under the
  // threshold (LLMs undershoot an unstated target) — state the exact
  // shortfall and total so the model has a concrete number to hit.
  const shortfall = MIN_TOTAL_WORDS - currentWords;
  const system = 'You are expanding a draft blog post that is too short to be a complete, publication-ready article. ' +
    'Rewrite it so every section has substantive, complete prose paragraphs (not notes or bullet fragments) — expand ' +
    'thin sections with more real detail and explanation, using ONLY facts already present in the given draft, never ' +
    `inventing a new fact, statistic, or offering. The current draft is ${currentWords} words and MUST grow to at ` +
    `least ${MIN_TOTAL_WORDS} words total (add at least ${shortfall} more words) — treat this as a hard minimum, not ` +
    'a rough target, and overshoot slightly rather than land short. Respond with ONLY a JSON array matching the ' +
    'input shape: [{"heading": "...", "body": "..."}].';
  const user = `Topic: ${topic}\n\nCurrent draft (${currentWords} words total, needs ${shortfall}+ more words to reach ` +
    `${MIN_TOTAL_WORDS}):\n${JSON.stringify(sections)}`;
  const expanded = await callLLMForJson(system, user, { maxTokens: 2600 }).catch(() => null);
  if (!Array.isArray(expanded) || !expanded.length) return sections;
  return expanded.filter((s) => s && typeof s.heading === 'string' && typeof s.body === 'string');
}

// params: { topic: string, context?: string, start?: string, end?: string }
export async function generate({ siteId, params }) {
  const { topic, context, designCorrections } = params;
  if (!topic) throw Object.assign(new Error('topic is required'), { status: 400 });
  const { start, end } = params.start && params.end ? params : defaultRange();

  const [site, otherPagesRaw, seoPolicy, siteProfile] = await Promise.all([
    getSiteById(siteId),
    getSearchPerformanceRange(siteId, start, end, 'page', CANDIDATE_LIMIT),
    getSeoPolicy(siteId),
    getSiteProfile(siteId),
  ]);
  const domain = knownDomain(site);
  const otherPages = filterOwnDomainPages(otherPagesRaw, ownDomains(site));
  const candidates = otherPages.map((p) => p.dim_value);
  const candidateSet = new Set(candidates);

  // Best-effort, not a hard gate — same reasoning as direct-answer.js: this
  // drafts a net-new page, so a homepage fetch failure must not block a
  // legitimate topic draft. When it succeeds, real fetched text about the
  // business replaces "treat it as a creative draft" as the only thing
  // stopping the model from inventing facts/offerings that don't exist.
  const homepage = domain ? `https://${domain}/` : null;
  const fetched = homepage ? await analyzePageUrl(homepage).catch(() => ({ ok: false })) : { ok: false };
  const grounded = fetched.ok && hasSufficientGroundingContent(fetched.analysis);
  const groundingExcerpt = grounded ? fetched.analysis.bodyText.slice(0, GROUNDING_EXCERPT_CHARS) : null;

  // Every tenant's own real business/industry steers topic focus — an
  // explicit site_seo_policy override when set (e.g. Zunkiree's own
  // multi-industry rule), else the industry already inferred generically
  // for THIS site from its own real GSC queries (site_profiles). Neither
  // source existing means genuinely nothing is known yet — no fallback
  // guess, no industry line at all (2026-09-10 multi-tenant SEO rule).
  const industries = tenantIndustries(seoPolicy, siteProfile);
  const industryFocus = industries?.length
    ? `Write for readers in this business's own industry/industries where the topic allows it — their real ` +
      `problems, services, products, software, automation, website, CRM, booking, or management needs: ` +
      `${industries.join(', ')}. `
    : '';
  // Baseline for every tenant (a policy row can only ever add stricter
  // constraints, per no_invented_data's schema default — never opt back
  // into inventing numbers): no fabricated search-volume/demand figures.
  const noInventedDataNote = seoPolicy?.no_invented_data !== false
    ? 'Do not state or imply specific search-volume, ranking, or demand figures (e.g. "X searches per month") ' +
      'unless such data is explicitly given to you below — write about the topic\'s real substance instead. '
    : '';
  // 2026-09-11 Zunkireelabs growth policy: exactly one of these two notes is
  // ever non-empty for a given site, see zunkireelabs-growth-policy.js.
  const growthNote = attributionNote(site) + globalGrowthNote(site);

  const system = 'You are a content strategist writing a COMPLETE, publication-ready blog post covering the given ' +
    `topic — this is a fresh piece, not based on an existing page. ` + industryFocus + noInventedDataNote + growthNote +
    (groundingExcerpt
      ? 'Any claim about this specific business (its services, offerings, or policies) must be grounded ONLY in the ' +
        '"Real site content" text given below — never invent one. General topic knowledge not specific to this ' +
        'business is fine to write from. '
      : 'Treat it as a creative draft, not a fact-check about this specific business. ') +
    `This must be a finished article a reader could publish as-is: at least ${MIN_TOTAL_WORDS} words total across ` +
    'all sections, each section a real paragraph (or several) of substantive prose — never headings with bullet ' +
    'notes, placeholder text, or "write about X here" instructions in place of the actual writing. If internal-link ' +
    'candidate URLs are given, you may suggest linking to them where topically relevant (choosing ONLY from that ' +
    'list — never invent a URL). Respond with ONLY a JSON object: {"title": "...", "metaDescription": "...", ' +
    '"sections": [{"heading": "...", "body": "..."}], "suggestedFaqTopics": ["...", "..."], ' +
    '"suggestedInternalLinks": [{"anchorText": "...", "targetUrl": "..."}]}';
  // DESIGN CONTEXT REACHES GENERATION HERE, same as landing-page.js — this
  // site's own real, canonical (or live-observed) blog-article structure
  // guides section shape/count for a post about a topic the site has never
  // covered, instead of every generated post reinventing its own shape.
  const structureGuidance = pageStructureGuidance(site, 'blog-article', { fallbackPageTypes: ['blog-listing'] });
  const user = `Topic: ${topic}${context ? `\nContext: ${context}` : ''}` +
    (groundingExcerpt ? `\n\nReal site content (from ${homepage}):\n${groundingExcerpt}` : '') +
    `\n\nInternal link candidates:\n${candidates.join('\n') || '(none available)'}` +
    (structureGuidance ? `\n\n${structureGuidance}` : '')
    // A previous attempt at THIS draft was generated and checked against the
    // site's own design, and something didn't match. Appended last so it is
    // the most recent instruction the model reads — see
    // generators/lib/design-repair-feedback.js and the repair loop in
    // routes/action-center.js's generateDraft.
    + (designCorrections ? `\n\n${designCorrections}` : '');
  let parsed;
  try {
    parsed = await callLLMForJson(system, user, { maxTokens: 2500, generatorId: meta.id, siteId });
  } catch {
    throw Object.assign(new Error('Blog post generation failed: model did not return valid JSON'), { status: 400 });
  }

  const suggestedInternalLinks = (Array.isArray(parsed.suggestedInternalLinks) ? parsed.suggestedInternalLinks : [])
    .filter((s) => s && typeof s.anchorText === 'string' && candidateSet.has(s.targetUrl));

  let sections = (Array.isArray(parsed.sections) ? parsed.sections : [])
    .filter((s) => s && typeof s.heading === 'string' && typeof s.body === 'string');

  // Treat a too-short draft as a generation failure, not a shippable
  // shorter article: up to MAX_EXPAND_ATTEMPTS bounded expand passes, each
  // targeting the real remaining shortfall, then reject outright rather than
  // let a thin/stub page reach a PR — see MIN_TOTAL_WORDS.
  for (let attempt = 0; attempt < MAX_EXPAND_ATTEMPTS && totalWords(sections) < MIN_TOTAL_WORDS; attempt++) {
    sections = await expandSections(sections, topic);
  }
  if (totalWords(sections) < MIN_TOTAL_WORDS) {
    throw Object.assign(
      new Error(`Blog post generation produced only ${totalWords(sections)} words after expansion (need ${MIN_TOTAL_WORDS}+) — try again.`),
      { status: 502, userFacing: true },
    );
  }

  // Best-effort, same reasoning as the homepage-grounding fetch above: a
  // failed/disabled/no-result image search must never block an otherwise
  // complete blog draft — see lib/pexels-client.js's searchImage. Title first
  // (most specific), then this post's own topic, then the TENANT'S industry,
  // tried in order until one clears the relevance bar; excludePhotoIds keeps
  // this post off every photo another post on the site already uses,
  // including photos claimed by other drafts in the same batch.
  //
  // The last-resort query is the site's own industry rather than
  // buildImageQueries' hardcoded 'artificial intelligence technology'
  // default — see lib/blog-image-query.js for why that default silently made
  // every non-AI tenant's weak-title posts converge on AI stock photos.
  const excludePhotoIds = imagesConfigured() ? await usedPhotoIds(site) : undefined;
  const { fallback } = await imageQueryContextFor(site);
  const featuredImage = await searchImage(
    buildImageQueries({ title: parsed.title, topic, fallback }),
    { excludePhotoIds, perPage: IMAGE_CANDIDATE_POOL },
  );

  const content = {
    topic,
    title: parsed.title || '',
    metaDescription: parsed.metaDescription || '',
    sections,
    suggestedFaqTopics: Array.isArray(parsed.suggestedFaqTopics) ? parsed.suggestedFaqTopics : [],
    suggestedInternalLinks,
    ...(featuredImage ? { featuredImage } : {}),
    // The real supporting text this draft was grounded in — same
    // convention as landing-page.js's content.groundingContext, for
    // claim-grounding-guard.js (quality-gate.js) to check business-specific
    // claims (client counts, pricing, "industry-leading"-style authority
    // phrases) against. Deliberately excludes general topic/industry
    // knowledge with no business-specific claim shape — this generator's
    // own prompt explicitly allows writing from that when ungrounded, and
    // the guard only flags claim-SHAPED text (a scale/price/percent/
    // superlative pattern), not prose in general.
    groundingContext: [context, groundingExcerpt].filter(Boolean).join('\n\n'),
  };
  return { content, summary: `Blog post draft for "${topic}" (${totalWords(sections)} words, ${sections.length} section(s))` };
}

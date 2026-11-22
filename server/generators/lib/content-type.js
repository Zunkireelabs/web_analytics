// ONE place that decides what KIND of content a draft is — a blog post, a landing page, a service page, a product page, or something
// else — from the evidence the system already holds, so no generator and no caller has to be told. Restrictions that depend on the kind
// of page (a per-site word ban that blog posts are exempt from, today) read the answer from here.
//
// WHERE IT RUNS: generateDraft() (routes/action-center.js) resolves it ONCE, before generating, and stores the result on the draft
// (`input.pageType` + `input.pageClassification`, with its evidence). The generator, the Quality Gate at generation, the repair loops,
// the approval gate and publishing all read that stored result; none of them re-derives it. A draft made before this existed has no
// stored result, so the gate resolves it on the spot (same function, same answer).
//
// EVIDENCE, strongest first (a source states its own strength; the strongest decides):
//   high    the caller declared it (params.pageType) · the generator itself (blog-outline IS a blog post) · the site's own declaration of
//           where its blog posts live (newContentTargets, a URL under that pattern, or a generator whose destination is that blog
//           directory) · the live page declaring itself an article (og:type, Article schema)
//   medium  the site's stored page metadata (its captured design profile lists this exact page with a type) · the live page loading and
//           NOT declaring itself an article
//   low     the URL's shape (a regex) · the wording of the task (topic / title / label)
//
// A restriction is only relaxed on MEDIUM or better, agreed evidence. Anything weaker, or evidence that disagrees at the top strength,
// resolves to `unknown` / `conflict` — never silently to "landing page" and never silently to "blog". The caller then applies the
// STRICT rules (nothing is weakened) and, where a type-dependent restriction exists, holds the draft for a person.
import { classifyPageType } from '../../design-agent/live-analysis/schema.js';
import { matchesSiteArticleUrl, isDeclaredArticleType, readPageDeclaration } from './article-page.js';

export const PAGE_TYPES = Object.freeze(['blog', 'article', 'blog-post', 'landing-page', 'service-page', 'product-page', 'homepage', 'other']);
export const ARTICLE_TYPES = Object.freeze(['blog', 'article', 'blog-post']);
const TYPE_SET = new Set(PAGE_TYPES);
const ARTICLE_SET = new Set(ARTICLE_TYPES);
const STRENGTH = { high: 3, medium: 2, low: 1 };

export const groupOf = (type) => (ARTICLE_SET.has(type) ? 'article' : 'non-article');

// Generators whose OUTPUT is, by definition, one kind of page.
const GENERATOR_TYPES = Object.freeze({
  'blog-outline': 'blog',
  'landing-page': 'landing-page',
  'cookie-policy': 'other',
  'terms-of-service': 'other',
  'privacy-policy': 'other',
});

// classifyPageType (design-agent/live-analysis/schema.js) keys stored design profiles, so it is mapped here, never changed.
const URL_TYPE_MAP = Object.freeze({
  'blog-article': 'blog-post', 'blog-listing': 'other', homepage: 'homepage', landing: 'landing-page', service: 'service-page',
  location: 'service-page', faq: 'other', legal: 'other', pricing: 'product-page', features: 'product-page', demo: 'product-page',
  'how-it-works': 'product-page', 'case-study': 'other', other: null,
});
const mapUrlType = (t) => (Object.prototype.hasOwnProperty.call(URL_TYPE_MAP, t) ? URL_TYPE_MAP[t] : null);

// The wording of the task. Deliberately weak (low) evidence: a person's phrasing is a hint, never a verdict.
const TEXT_RULES = Object.freeze([
  ['blog', /\bblog( post| article)?s?\b/i], ['article', /\b(news )?articles?\b/i],
  ['landing-page', /\blanding pages?\b/i], ['service-page', /\bservice pages?\b/i], ['product-page', /\bproduct pages?\b/i],
]);

const norm = (v) => String(v ?? '').trim().toLowerCase();
const pageUrlOf = (params) => [params?.page, params?.pageUrl, params?.url, params?.permalink].find((v) => typeof v === 'string' && v) || null;

function blogPrefix(site) {
  const pattern = site?.url_file_map?.newContentTargets?.['blog-outline']?.urlPattern;
  if (typeof pattern !== 'string' || !pattern.includes('{slug}')) return null;
  const prefix = pattern.split('{slug}')[0].replace(/\/+$/, '').toLowerCase();
  return /[a-z0-9]/.test(prefix) ? prefix : null;
}

// A generator whose configured destination is the site's blog area (e.g. direct-answer writing under /blogs/) is making blog content.
function destinationIsBlog(site, generatorId) {
  const prefix = blogPrefix(site);
  const pattern = site?.url_file_map?.newContentTargets?.[generatorId]?.urlPattern;
  if (!prefix || typeof pattern !== 'string' || generatorId === 'blog-outline') return false;
  return pattern.toLowerCase().startsWith(`${prefix}/`);
}

function capturedPageType(site, url) {
  const pages = site?.url_file_map?.siteRoot?.designProfile?.pages;
  if (!url || !Array.isArray(pages)) return null;
  const strip = (u) => String(u).replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  const hit = pages.find((p) => p?.url && p.pageType && strip(p.url) === strip(url));
  return hit ? mapUrlType(hit.pageType) : null;
}

/**
 * Resolve what kind of content a draft is.
 * @returns {{ pageType: string|null, group: 'article'|'non-article'|null, confidence: 'high'|'medium'|'low'|null,
 *             status: 'resolved'|'unknown'|'conflict', evidence: object[], tentativeType: string|null, resolvedAt: string }}
 */
export async function resolveContentType({ site = null, generatorId = null, params = {}, pageAnalysis = null, fetchPage = true, analyze = null, now = new Date() } = {}) {
  const evidence = [];
  const add = (source, pageType, strength, detail) => evidence.push({ source, pageType, group: groupOf(pageType), strength, detail });

  // 1. The caller said so.
  const declared = norm(params?.pageType);
  if (TYPE_SET.has(declared)) add('declared', declared, 'high', 'params.pageType');

  // 2. What this generator makes.
  const byGenerator = GENERATOR_TYPES[generatorId];
  if (byGenerator) add('generator', byGenerator, 'high', generatorId);

  // 3. Where the site says this kind of content goes.
  if (destinationIsBlog(site, generatorId)) add('site-destination', 'blog', 'high', `newContentTargets.${generatorId} is under the blog directory`);

  // 4. The page URL, if there is one.
  const url = pageUrlOf(params);
  if (url) {
    if (matchesSiteArticleUrl(url, site)) add('site-blog-pattern', 'blog-post', 'high', "URL matches the site's own blog pattern");
    const stored = capturedPageType(site, url);
    if (stored) add('stored-page-metadata', stored, 'medium', 'captured design profile lists this exact page');
    let regexType = null;
    try { regexType = mapUrlType(classifyPageType(new URL(url, 'https://placeholder.invalid').href, { propertyType: site?.property_type })); } catch { /* none */ }
    if (regexType) add('url-shape', regexType, 'low', 'URL regex');
  }

  // 5. What the live page says about itself — only fetched when nothing stronger has already settled it.
  const settled = evidence.some((e) => e.strength === 'high');
  if (url && !settled) {
    let decl = null;
    if (pageAnalysis && typeof pageAnalysis === 'object') decl = { ok: true, isArticle: Boolean(pageAnalysis.isArticlePage) };
    else if (fetchPage) decl = await readPageDeclaration(url, { analyze });
    if (decl?.ok && decl.isArticle) add('live-page', 'article', 'high', 'the page declares itself an article (og:type / Article schema)');
    else if (decl?.ok) add('live-page', 'other', 'medium', 'the page loads and does not declare itself an article');
  }

  // 6. The wording of the task. Low strength, always recorded, never decisive on its own.
  const words = [params?.topic, params?.title, params?.headline, params?.label, params?.reason].filter((v) => typeof v === 'string').join(' ');
  for (const [type, re] of TEXT_RULES) { if (words && re.test(words)) { add('task-wording', type, 'low', `matched ${re}`); break; } }

  const resolvedAt = new Date(now).toISOString();
  if (!evidence.length) return { pageType: null, group: null, confidence: null, status: 'unknown', evidence, tentativeType: null, resolvedAt };

  const top = Math.max(...evidence.map((e) => STRENGTH[e.strength]));
  const strongest = evidence.filter((e) => STRENGTH[e.strength] === top);
  const groups = new Set(strongest.map((e) => e.group));
  const confidence = Object.keys(STRENGTH).find((k) => STRENGTH[k] === top);
  const best = strongest[0];

  // Two equally strong sources disagree about article vs not: do not pick one.
  if (groups.size > 1) return { pageType: null, group: null, confidence, status: 'conflict', evidence, tentativeType: null, resolvedAt };
  // Only weak evidence: a guess is recorded, but it is not an answer.
  if (top < STRENGTH.medium) return { pageType: null, group: null, confidence, status: 'unknown', evidence, tentativeType: best.pageType, resolvedAt };
  // Among agreeing sources prefer the most specific type (a named type over the generic 'other').
  const specific = strongest.find((e) => e.pageType !== 'other') || best;
  return { pageType: specific.pageType, group: groupOf(specific.pageType), confidence, status: 'resolved', evidence, tentativeType: null, resolvedAt };
}

const validClassification = (c) => Boolean(c && typeof c === 'object' && ['resolved', 'unknown', 'conflict'].includes(c.status) && Array.isArray(c.evidence));

/** True only for a resolved, confident article-type result — the one case a type-dependent restriction is relaxed. */
export function isArticleClassification(c) {
  return Boolean(validClassification(c) && c.status === 'resolved' && c.group === 'article' && (c.confidence === 'high' || c.confidence === 'medium'));
}

/** Does this site have any restriction whose outcome depends on the kind of page? (Only then does an unclear type matter.) */
export function typeDependentRestrictionsApply(site) {
  const root = site?.url_file_map?.siteRoot || {};
  const has = (k) => Array.isArray(root[k]) && root[k].some((x) => typeof x === 'string' && x.trim());
  return has('visibleClaimBans') || has('titleClaimBans') || has('neverSayPhrases');
}

/** The controlled fallback: type unclear AND the site has a type-dependent restriction → a person should look before it ships. */
export function needsTypeReview(classification, site) {
  if (!typeDependentRestrictionsApply(site)) return false;
  return !validClassification(classification) || classification.status !== 'resolved';
}

/**
 * Reuse a stored classification when the draft already carries one (so no later step re-derives it), otherwise resolve it.
 * Returns { classification, params } where params carries `pageType` (resolved type, or removed when unknown) and `pageClassification`.
 */
export async function ensureClassification({ site, generatorId, params, ...rest }) {
  const stored = params?.pageClassification;
  const classification = validClassification(stored) ? stored : await resolveContentType({ site, generatorId, params, ...rest });
  const next = { ...(params || {}), pageClassification: classification };
  if (classification.status === 'resolved') next.pageType = classification.pageType;
  else delete next.pageType; // an unresolved type must not leave a stale or guessed pageType behind for a later step to trust
  return { classification, params: next };
}

export { isDeclaredArticleType };

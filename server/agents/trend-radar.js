import { getSiteById } from '../store/read.js';
import { getSeoPolicy } from '../store/site-seo-policy.js';
import { getSiteProfile } from '../store/data-analyst.js';
import { listPageInventory } from '../store/page-inventory.js';
import { callLLMForJson } from '../llm.js';
import { getSearchDemandProvider } from '../providers/search-demand/registry.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { INSIGHT_CATEGORY } from '../generators/lib/blog-image-policy.js';
import { effortForGenerator } from './lib/page-content.js';
import { feedsForTenant, fetchAllFeeds, recentItems, FEED_CATALOG_KEYS } from './lib/trend-feeds.js';
import { getProductGrowthConfig } from '../store/product-growth-config.js';
import { tenantContextTextFor } from '../lib/tenant-context.js';
import { isTopicScorerEnabled } from './lib/topic-scorer.js';
import { buildTopicQueue } from './lib/topic-queue.js';

// Trend Radar — finds what is genuinely trending in THIS tenant's industry
// right now, so a later phase can turn a topic into an "insight" blog post.
//
// Each topic becomes a finding whose action drafts a blog post through the
// existing blog-outline generator. The real headlines travel in
// params.context, which blog-outline already puts in the prompt, so the
// article is grounded in them without any generator change. Runs once per
// calendar month (agents/lib/trend-cadence.js, job.js's runTrendRadarIfDue),
// and requiresHumanReview() (risk-tiers.js) keeps every one of these drafts
// behind a person. The blog's "Insights" tag/filter is a later phase.
//
// Multi-tenant by construction: the lens is what THIS site's business does —
// site_profiles.industry plus main_topics. Nothing here knows about any one
// site.
//
// Deliberately NOT tenantIndustries(): that helper prefers
// site_seo_policy.target_industries, which for Zunkiree Labs (site 1) is the
// list of industries it SELLS TO (Education, Healthcare, Real Estate, ...),
// not what it does. Trending on that list alone would give an AI-development
// agency real-estate headlines. The policy list is a fallback for a site with
// no profile industry, and otherwise a SECONDARY lens only (run() below): its
// industries add a couple of feeds each and steer the model toward topics
// where the site's own field meets them.
//
// Never fabricates a trend: the model may only group headlines it was
// given, every topic must cite real item indexes, and topics that cite none
// are dropped. Search demand has no provider yet, so every topic says
// "unverified" instead of implying volume.
export const meta = {
  id: 'trend-radar',
  name: 'Trend Radar Agent',
  description: 'Finds topics trending right now in the site\'s own industry from free news feeds, each backed by real, linked headlines.',
  category: 'content',
  version: 1,
  dataSources: [
    { id: 'industry-news-feeds', status: 'connected', description: 'Free public RSS/Atom feeds chosen by the site\'s industry (agents/lib/trend-feeds.js). Real headlines with dates and links; no search-volume data.' },
    { id: 'search-demand', status: 'not-connected', description: 'External search-volume/trend data (providers/search-demand). Until a provider is configured, topics are reported as demand-unverified.' },
  ],
};

const MAX_TOPICS = 5;
// The editorial target per run: 4-5 posts a fortnight. A floor in the PROMPT,
// not in code — fewer is returned when the headlines genuinely do not hold
// four distinct, relevant topics, because padding to a number would invent
// trends, and this agent never fabricates one.
const TARGET_TOPICS_MIN = 4;
const CONTEXT_SOURCES = 5;
// Blog category insight posts are filed under; the client blog's Insights filter
// keys on this exact label.
export { INSIGHT_CATEGORY };
// Matches the run cadence (agents/lib/trend-cadence.js): a fortnight's runs
// look at a fortnight's headlines, so nothing that happened between two runs
// is ever missed and nothing is seen twice.
const MAX_AGE_DAYS = 14;
const MIN_ITEMS = 5;

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'what', 'why', 'how', 'its', 'are', 'you', 'your', 'that', 'this', 'from', 'about', 'into', 'new', 'blog', 'insights']);

export function tokens(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

export function slugify(s) {
  return tokens(s).slice(0, 6).join('-') || 'topic';
}

// A topic is "already covered" when most of its distinctive words appear in
// a single existing page path (a blog slug is the one reliable topical
// signal page_inventory holds). Conservative on purpose: a false positive
// only skips one proposal this run; a false negative means proposing
// something the site already wrote.
export function alreadyCovered(topic, pagePaths) {
  const t = tokens(topic);
  if (t.length < 2) return false;
  return pagePaths.some((p) => {
    const slugWords = new Set(tokens(p));
    const hit = t.filter((w) => slugWords.has(w)).length;
    // A short slug ("what-is-superintelligence") can only ever share one
    // distinctive word with the topic, so the floor is min(2, slug words).
    return hit >= Math.min(2, slugWords.size) && hit / t.length >= 0.5;
  });
}

// Keeps only topics whose cited item indexes are real; recomputes the strength
// signal from the items themselves rather than trusting any model-reported
// number. Returns topics sorted strongest first (more distinct outlets, then
// the freshest cited item).
export function validateTopics(rawTopics, items) {
  if (!Array.isArray(rawTopics)) return [];
  const out = [];
  const seenSlugs = new Set();
  for (const t of rawTopics) {
    const topic = typeof t?.topic === 'string' ? t.topic.trim() : '';
    if (!topic) continue;
    const idxs = [...new Set((Array.isArray(t.sources) ? t.sources : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < items.length))];
    if (!idxs.length) continue;
    const sources = idxs.map((i) => ({ title: items[i].title, url: items[i].url, source: items[i].source, publishedAt: items[i].publishedAt, summary: items[i].summary || '' }));
    const slug = slugify(topic);
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    out.push({
      topic,
      angle: typeof t.angle === 'string' ? t.angle.trim() : '',
      whyRelevant: typeof t.whyRelevant === 'string' ? t.whyRelevant.trim() : '',
      slug,
      sources,
      distinctSources: new Set(sources.map((s) => s.source)).size,
      latestAt: sources.reduce((m, s) => (s.publishedAt > m ? s.publishedAt : m), ''),
    });
  }
  return out.sort((a, b) => b.distinctSources - a.distinctSources || (a.latestAt < b.latestAt ? 1 : -1));
}

// What blog-outline receives as `context`. Ground rules live here because the
// generator's own prompt knows nothing about trends: current-event claims must
// come from the headlines, which are the only real facts we hold.
export function insightContext(t, siteIndustries) {
  const sources = t.sources.slice(0, CONTEXT_SOURCES)
    .map((s) => `- ${s.title} (${s.source}, ${s.publishedAt.slice(0, 10)}) ${s.url}${s.summary ? `\n  Summary: ${s.summary}` : ''}`).join('\n');
  return `Trending-topic insight article for readers in: ${siteIndustries.join(', ')}. ` +
    (t.angle ? `Angle: ${t.angle} ` : '') +
    'Explain what it is, why it is called that if the name is notable, and why it matters to this audience right now. ' +
    'Any statement about recent events, announcements, numbers or dates must come ONLY from the headlines below — never from memory; ' +
    'general background and definitions are fine. Name the outlets you rely on in the text. Do not invent quotes. ' +
    // SEO / AEO / GEO structure, so the post can be cited by search and answer engines.
    'Structure it for search and AI answer engines: open with a 2-3 sentence direct answer to the topic, written so it makes sense on its own; ' +
    'phrase most section headings as the questions a reader would actually ask; keep paragraphs short and specific; ' +
    'attribute every recent claim to its outlet by name (e.g. "according to TechCrunch"); label vendor claims as claims; ' +
    'and end with a short practical takeaway for the audience.\n' +
    `Real recent coverage:\n${sources}`;
}

const SYSTEM = 'You are an industry news analyst for a business website. You are given a numbered list of real, ' +
  'recent headlines. Group them into the topics that are genuinely trending and relevant to the site\'s industry ' +
  'and audience, and suggest one educational article for each. Respond with ONLY JSON of the shape ' +
  '{"topics":[{"topic":"plain-English article topic, e.g. \\"What is superintelligence and why is it called that\\"",' +
  '"angle":"one sentence: how the article should explain it for THIS site\'s audience",' +
  '"whyRelevant":"one sentence: why this audience cares right now",' +
  '"sources":[indexes of the headlines this topic is based on]}]}. ' +
  `Aim for ${TARGET_TOPICS_MIN} to ${MAX_TOPICS} distinct topics when the headlines genuinely hold that many (return fewer rather than pad — never invent a topic to reach the number), and never more than ${MAX_TOPICS}. Include what is NEW in the field — product launches, releases, major feature announcements and new tools — alongside broader shifts, since launches are exactly what readers search for. Rules: use ONLY the numbered headlines — never add a topic, fact, number ` +
  'or event that is not in them; every topic must list at least one real index (prefer topics several outlets ' +
  'are covering); skip anything unrelated to the site\'s industry; skip pure celebrity, sports, politics, ' +
  'discount/sale promotions and funding-round gossip; if nothing is both trending and relevant return {"topics":[]}.';

function buildUserPrompt({ site, industries, mainTopics, items, tenantContext = '', secondaryIndustries = [] }) {
  const lens = [
    `Site: ${site?.name || site?.domain || 'this site'}`,
    `Industry: ${industries.join(', ')}`,
    mainTopics?.length ? `Main topics the site covers: ${mainTopics.join(', ')}` : null,
    // The industries this business SERVES, as opposed to what it IS. Offered as
    // a lens, not a topic list: the best post for a business that builds AI
    // agents is where its own field meets one of these (voice agents in
    // healthcare, automation for real-estate teams), not generic news from them.
    secondaryIndustries.length ? `Also serves these industries — favour topics where this site's own field meets them: ${secondaryIndustries.join(', ')}` : null,
  ].filter(Boolean).join('\n');
  const list = items.map((it, i) => `[${i}] ${it.title} — ${it.source}, ${it.publishedAt.slice(0, 10)}${it.summary ? `. ${it.summary}` : ''}`).join('\n');
  // Sharpens the lens without widening it. The industry line above comes from
  // trendIndustries(), which deliberately rejects the site_seo_policy list of
  // industries a site SELLS TO — so the caller passes no 'business' section
  // here on purpose, for exactly the reason this file's header documents:
  // trending on an agency's client industries hands it real-estate headlines.
  return `${lens}${tenantContext ? `\n\n${tenantContext}` : ''}\n\nHeadlines from the last ${MAX_AGE_DAYS} days:\n${list}`;
}

function mainTopicNames(profile) {
  const raw = profile?.main_topics;
  const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : []);
  return arr.map((t) => (typeof t === 'string' ? t : t?.topic || t?.name || '')).filter(Boolean).slice(0, 8);
}

// `growthIndustries` is the product-tenant source, added last on purpose:
// it is the ONLY one a product tenant can have, because profile.industry is
// written by the Python keyword-clustering collector from Search Console
// queries a product tenant does not have. Before this, every product tenant
// fell straight through to the "No industry known" refusal and got no
// trending topics at all, permanently. It sits below the policy list
// because, like the policy list, it can be a sell-to list rather than what
// the tenant does — but having it is strictly better than having nothing.
export function trendIndustries(policy, profile, growthIndustries = null) {
  const own = profile?.industry ? String(profile.industry).trim() : '';
  if (own) return [own];
  if (policy?.target_industries?.length) return policy.target_industries;
  return growthIndustries?.length ? growthIndustries : null;
}

function insufficient(message, extra = {}) {
  return { meta, status: 'insufficient-data', facts: null, narrative: null, message, generatedAt: new Date().toISOString(), ...extra };
}

// A tenant with no recorded industry used to dead-end here: trend radar
// refused to run, forever, and nothing ever recorded one. A product tenant can
// never have one inferred (that needs Search Console queries), and a new
// website tenant has none until the Python profiler's first run. So this
// closes the loop instead of reporting it: read the site's own homepage, ask
// for ONE label from the feed catalog's own vocabulary (industry-capture.js —
// never an invented string), use it for this run, and record it with its
// provenance so it is classified once, not every fortnight.
//
// Strictly a fallback: it runs only when no industry exists anywhere (policy,
// profile, growth config), costs one fetch and one small model call, and
// never overwrites anything a human set — saveSiteProfile protects that at the
// SQL level too. Returns null (and run() reports the capability gap exactly as
// before) when the homepage cannot be read or the business is genuinely
// outside the catalog.
export async function inferTrendIndustry(site, profile, deps = {}) {
  try {
    // Same rule as site-domain.js's knownDomain (explicit website_domain only,
    // never guessed), inlined because that module statically imports the
    // search-performance store and this agent's tests mock that store with a
    // partial export list.
    const domain = site?.website_domain ? String(site.website_domain).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '') : null;
    if (!domain) return null;
    const analyze = deps.analyze || (await import('./lib/page-content.js')).analyzePageUrl;
    const grounded = deps.hasGrounding || (await import('./lib/page-content.js')).hasSufficientGroundingContent;
    const fetched = await analyze(`https://${domain}/`).catch(() => ({ ok: false }));
    if (!fetched.ok || !grounded(fetched.analysis)) return null;

    const { classifyIndustryFromText } = await import('../lib/industry-capture.js');
    const industry = await classifyIndustryFromText(fetched.analysis.bodyText.slice(0, 3000), {
      callJson: deps.callJson || ((system, user) => callLLMForJson(system, user, { maxTokens: 200, siteId: site.id })),
    });
    if (!industry) return null;

    // Best effort: a failed save must not lose the industry we just worked out.
    const save = deps.save || (await import('../store/data-analyst.js')).saveSiteProfile;
    await save(site.id, {
      industry, mainTopics: profile?.main_topics ?? [], siteType: profile?.site_type ?? null,
      industrySource: 'llm-classified', industryConfidence: 'low',
    }).catch((err) => console.warn(`[trend-radar] site ${site.id}: inferred industry "${industry}" but could not record it: ${err.message}`));
    return industry;
  } catch (err) {
    console.warn(`[trend-radar] site ${site?.id}: industry inference failed: ${err.message}`);
    return null;
  }
}

export async function run({ siteId, params = {}, deps = {} }) {
  const [site, policy, profile] = await Promise.all([
    getSiteById(siteId),
    getSeoPolicy(siteId),
    getSiteProfile(siteId),
  ]);

  // Product tenants only — getProductGrowthConfig resolves site_id to a
  // product_id and returns null when this site has no products row at all,
  // which is every website tenant.
  const growthConfig = site?.property_type === 'product'
    ? await getProductGrowthConfig(siteId).catch(() => null)
    : null;

  let industries = trendIndustries(policy, profile, growthConfig?.industries);
  let inferredIndustry = null;
  if (!industries && site) {
    inferredIndustry = await inferTrendIndustry(site, profile, deps);
    if (inferredIndustry) industries = [inferredIndustry];
  }
  if (!industries) {
    return insufficient(
      site?.property_type === 'product'
        ? 'No industry recorded for this product tenant, and none could be worked out from its homepage — set it in the product growth config (Clients console) or run the product onboarding script.'
        : 'No industry known for this site yet, and none could be worked out from its homepage — set target industries in the SEO policy or let the site profile run first.',
      { facts: { capabilityGap: 'industry-not-recorded' } },
    );
  }
  const mainTopics = mainTopicNames(profile);
  // The industries the business SERVES, from the owner's SEO policy
  // (site_seo_policy.target_industries). trendIndustries() deliberately never
  // lets this list REPLACE the business's own industry — trending on it alone
  // hands an AI-agent company real-estate headlines — so it is added only as a
  // secondary lens, and only when a primary industry already came from
  // somewhere else. Feeds for it are capped per category (the catalog's own
  // SECONDARY_FEEDS_PER_CATEGORY), so the primary field still leads.
  const secondaryIndustries = (profile?.industry || growthConfig?.industries?.length) && Array.isArray(policy?.target_industries)
    ? policy.target_industries.map((x) => String(x).trim()).filter(Boolean)
    : [];

  const feeds = feedsForTenant({ industries, topics: [...mainTopics, ...secondaryIndustries], override: params.feeds });
  if (!feeds.length) {
    // Distinct from "no industry": the industry IS recorded, it just is not
    // something the feed catalog can serve. Said plainly and with the real
    // list of what it can, because otherwise this reads as "nothing is
    // trending in your industry" — and that is indistinguishable, from the
    // outside, from a tenant that was never classified at all.
    return insufficient(
      `This site's industry (${industries.join(', ')}) is recorded but no news feeds are mapped to it. ` +
      `The feed catalog currently covers: ${FEED_CATALOG_KEYS.join(', ')}. ` +
      'Either record a closer industry, or add a custom feed list for this site.',
      { facts: { capabilityGap: 'industry-unmapped', industries, catalogCovers: [...FEED_CATALOG_KEYS] } },
    );
  }

  const { items: allItems, failed, fetched } = await fetchAllFeeds(feeds);
  const items = recentItems(allItems, { maxAgeDays: MAX_AGE_DAYS });
  if (fetched === 0 || items.length < MIN_ITEMS) {
    return insufficient(
      fetched === 0
        ? 'None of the news feeds could be reached this run.'
        : `Only ${items.length} recent headline(s) found across ${fetched} feed(s) — too few to call anything a trend.`,
      { facts: { feedsTried: feeds.map((f) => f.id), feedsFailed: failed } },
    );
  }

  const tenantContext = await tenantContextTextFor(site, { sections: ['goals', 'product'] });
  const llm = await callLLMForJson(SYSTEM, buildUserPrompt({ site, industries, mainTopics, items, tenantContext, secondaryIndustries }), {
    maxTokens: 1500, siteId,
    validate: (v) => Array.isArray(v?.topics),
  });

  const pages = await listPageInventory(siteId, { limit: 500 }).catch(() => []);
  const pagePaths = pages.map((p) => String(p.page).toLowerCase());

  const validated = validateTopics(llm.topics, items);
  const covered = validated.filter((t) => alreadyCovered(t.topic, pagePaths)).map((t) => t.topic);
  const topics = validated.filter((t) => !alreadyCovered(t.topic, pagePaths)).slice(0, MAX_TOPICS);

  // Demand is asked of the provider layer so a future real provider lights up
  // here with no agent change; today it is the null provider and says so.
  const demandProvider = getSearchDemandProvider();
  const demand = await demandProvider.fetchDemandBulk(topics.map((t) => t.topic));

  const priorities = priorityByRank(topics);
  const findings = topics.map((t, i) => {
    const d = demand.get(t.topic);
    return makeFinding({
      id: `trend-radar:${t.slug}`,
      evidence: {
        topic: t.topic,
        angle: t.angle,
        sources: t.sources,
        distinctSources: t.distinctSources,
        windowDays: MAX_AGE_DAYS,
        demand: d?.available
          ? { available: true, providerId: d.providerId, searchVolume: d.searchVolume, volumeTrend: d.volumeTrend, asOf: d.asOf }
          : { available: false, note: d?.note || 'No search-demand provider configured — trend is from news coverage only.' },
      },
      whyItMatters: `${t.whyRelevant || `Relevant to ${industries.join(', ')}.`} Covered by ${t.distinctSources} outlet${t.distinctSources === 1 ? '' : 's'} in the last ${MAX_AGE_DAYS} days; search demand is ${d?.available ? 'verified' : 'unverified'}.`,
      priority: priorities[i],
      recommendedAction: {
        label: `Insight: ${t.topic}`,
        generatorId: 'blog-outline',
        params: { topic: t.topic, context: insightContext(t, industries), category: INSIGHT_CATEGORY },
        effort: effortForGenerator('blog-outline'),
      },
      expectedImpact: { label: impactFromPriority(priorities[i]), basis: 'estimate' },
    });
  });

  // Feed the same validated topics into the shared scored queue
  // (agents/lib/topic-queue.js), where they meet the keyword pipeline's
  // volume-ranked gaps for the first time. A topic that is BOTH trending
  // here and genuinely searched there is the best topic available, and
  // before this nothing ever saw the two facts together.
  //
  // Additive and flagged: the findings above are produced and returned
  // exactly as before, so this agent's output is unchanged while the queue
  // is being validated. Best-effort — a queue write must never fail a run
  // that already has real findings.
  let queued = null;
  if (isTopicScorerEnabled()) {
    queued = await buildTopicQueue(siteId, topics.map((t) => ({
      topic: t.topic,
      origin: 'trend-radar',
      intent: 'new-blog',
      demand: demand.get(t.topic) ?? null,
      // validateTopics already computed latestAt from the real cited items,
      // so freshness comes from the headlines themselves rather than from a
      // second derivation that could disagree with the ordering above.
      trend: {
        distinctSources: t.distinctSources,
        newestAgeDays: t.latestAt ? Math.max(0, (Date.now() - Date.parse(t.latestAt)) / 86_400_000) : null,
      },
    })), {}).catch((err) => {
      console.warn(`[trend-radar] could not build the topic queue for site ${siteId}: ${err.message}`);
      return null;
    });
  }

  const facts = {
    industries,
    feedsUsed: feeds.map((f) => f.id),
    feedsFailed: failed,
    headlinesConsidered: items.length,
    skippedAlreadyCovered: covered,
    findings,
    ...(queued ? { topicQueue: { queued: queued.queued.length, dropped: queued.dropped.length } } : {}),
    ...(inferredIndustry ? { industryInferred: inferredIndustry } : {}),
    ...(secondaryIndustries.length ? { alsoServes: secondaryIndustries } : {}),
  };
  return { meta, status: 'ok', facts, narrative: null, generatedAt: new Date().toISOString() };
}

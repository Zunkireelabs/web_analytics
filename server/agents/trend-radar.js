import { getSiteById } from '../store/read.js';
import { getSeoPolicy } from '../store/site-seo-policy.js';
import { getSiteProfile } from '../store/data-analyst.js';
import { listPageInventory } from '../store/page-inventory.js';
import { callLLMForJson } from '../llm.js';
import { getSearchDemandProvider } from '../providers/search-demand/registry.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { INSIGHT_CATEGORY } from '../generators/lib/blog-image-policy.js';
import { effortForGenerator } from './lib/page-content.js';
import { feedsForTenant, fetchAllFeeds, recentItems } from './lib/trend-feeds.js';

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
// not what it does. Trending on that list would give an AI-development
// agency real-estate headlines. The policy list is only a fallback here, for a
// site with no profile industry yet.
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
const CONTEXT_SOURCES = 5;
// Blog category insight posts are filed under; the client blog's Insights filter
// keys on this exact label.
export { INSIGHT_CATEGORY };
const MAX_AGE_DAYS = 7;
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
  `Return at most ${MAX_TOPICS} topics. Rules: use ONLY the numbered headlines — never add a topic, fact, number ` +
  'or event that is not in them; every topic must list at least one real index (prefer topics several outlets ' +
  'are covering); skip anything unrelated to the site\'s industry; skip pure celebrity, sports, politics or ' +
  'product-sale news; if nothing is both trending and relevant return {"topics":[]}.';

function buildUserPrompt({ site, industries, mainTopics, items }) {
  const lens = [
    `Site: ${site?.name || site?.domain || 'this site'}`,
    `Industry: ${industries.join(', ')}`,
    mainTopics?.length ? `Main topics the site covers: ${mainTopics.join(', ')}` : null,
  ].filter(Boolean).join('\n');
  const list = items.map((it, i) => `[${i}] ${it.title} — ${it.source}, ${it.publishedAt.slice(0, 10)}${it.summary ? `. ${it.summary}` : ''}`).join('\n');
  return `${lens}\n\nHeadlines from the last ${MAX_AGE_DAYS} days:\n${list}`;
}

function mainTopicNames(profile) {
  const raw = profile?.main_topics;
  const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : []);
  return arr.map((t) => (typeof t === 'string' ? t : t?.topic || t?.name || '')).filter(Boolean).slice(0, 8);
}

export function trendIndustries(policy, profile) {
  const own = profile?.industry ? String(profile.industry).trim() : '';
  if (own) return [own];
  return policy?.target_industries?.length ? policy.target_industries : null;
}

function insufficient(message, extra = {}) {
  return { meta, status: 'insufficient-data', facts: null, narrative: null, message, generatedAt: new Date().toISOString(), ...extra };
}

export async function run({ siteId, params = {} }) {
  const [site, policy, profile] = await Promise.all([
    getSiteById(siteId),
    getSeoPolicy(siteId),
    getSiteProfile(siteId),
  ]);

  const industries = trendIndustries(policy, profile);
  if (!industries) {
    return insufficient('No industry known for this site yet — set target industries in the SEO policy or let the site profile run first.');
  }
  const mainTopics = mainTopicNames(profile);

  const feeds = feedsForTenant({ industries, topics: mainTopics, override: params.feeds });
  if (!feeds.length) {
    return insufficient(`No news feeds are mapped to this site's industry (${industries.join(', ')}) yet.`);
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

  const llm = await callLLMForJson(SYSTEM, buildUserPrompt({ site, industries, mainTopics, items }), {
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

  const facts = {
    industries,
    feedsUsed: feeds.map((f) => f.id),
    feedsFailed: failed,
    headlinesConsidered: items.length,
    skippedAlreadyCovered: covered,
    findings,
  };
  return { meta, status: 'ok', facts, narrative: null, generatedAt: new Date().toISOString() };
}

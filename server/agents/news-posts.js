import { getSiteById } from '../store/read.js';
import { logInternal } from '../lib/errors.js';
import { getNewsConfig } from '../store/site-news-config.js';
import { listPageInventory } from '../store/page-inventory.js';
import { callLLMForJson } from '../llm.js';
import { llmFailure } from '../generators/lib/llm-error.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { effortForGenerator, analyzePageUrl } from './lib/page-content.js';
import { fetchAllFeeds, recentItems } from './lib/trend-feeds.js';
import { INSIGHT_CATEGORY } from '../generators/lib/blog-image-policy.js';
import { slugify, alreadyCovered } from './trend-radar.js';
import { verifyFacts, validateCandidates, newsContext, refreshFacts } from './lib/official-news.js';

// News-based posts. Reads industry news for LEADS, then confirms each one on the client's official sites before anything is
// drafted. A lead that cannot be confirmed is dropped and never reaches a draft. Confirmed changes become a blog draft
// (or a refresh of the page that already covers the topic), always behind a person's approval.
//
// Settings are per project (site_news_config, agents/lib/news-presets.js). A project with no enabled row is skipped.
export const meta = {
  id: 'news-posts',
  name: 'News-based Posts Agent',
  description: 'Finds recent rule changes in the client\'s industry from news, confirms each on the official site, and drafts a post or refreshes an existing one.',
  category: 'content',
  version: 1,
  dataSources: [
    { id: 'industry-news-feeds', status: 'connected', description: 'Per-project news feeds, used for leads only.' },
    { id: 'official-pages', status: 'connected', description: 'The official sites listed for the project (government, regulator). The only place a fact is confirmed.' },
  ],
};

const MAX_AGE_DAYS = 10;
const MIN_ITEMS = 3;
const MAX_CANDIDATES = 6;
const MAX_PAGES_PER_CANDIDATE = 3;
const PAGE_TEXT_FOR_MODEL = 7000;

const CANDIDATE_SYSTEM = 'You read a numbered list of real, recent news headlines for a study-abroad partner whose clients are students from Nepal. ' +
  'Pick headlines that report a CHANGE to a rule, requirement, fee, deadline, cap, policy or scholarship window that affects such students, in one of the listed countries. ' +
  'Respond with ONLY JSON {"candidates":[{"topic":"plain-English article topic including the country and year","country":"one of the listed countries",' +
  '"claim":"one sentence stating the change exactly as the headline reports it","sources":[headline indexes]}]}. ' +
  `Return at most ${MAX_CANDIDATES}; skip opinion, rankings, events and anything that is not a concrete change; if there is none return {"candidates":[]}.`;

const CONFIRM_SYSTEM = 'You are given a claim from a news article and the text of official web pages. Decide whether the OFFICIAL TEXT states the claim. ' +
  'Respond with ONLY JSON {"facts":[{"statement":"one fact the official text states that matches the claim","quote":"an exact copy of the sentence from the official text that states it"}]}. ' +
  'Copy quotes character for character from the page text. If the official text does not state the claim, or only shows an older rule, return {"facts":[]}. Never use outside knowledge.';

function sourcesFor(config, country) {
  return (Array.isArray(config.official_sources) ? config.official_sources : []).find((s) => String(s.country).toLowerCase() === String(country).toLowerCase());
}

async function openPages(urls, fetchPage) {
  return Promise.all(urls.slice(0, MAX_PAGES_PER_CANDIDATE).map(async (url) => {
    try { const r = await fetchPage(url); return { url, ok: !!r.ok, text: r.text || '', error: r.error }; } catch (e) { return { url, ok: false, text: '', error: e.message }; }
  }));
}

export async function confirmCandidate(candidate, config, { callJson, fetchPage }) {
  const src = sourcesFor(config, candidate.country);
  if (!src) return { confirmed: false, reason: 'no official source listed for this country', pages: [] };
  const pages = await openPages(src.pages || [], fetchPage);
  const opened = pages.filter((p) => p.ok && p.text);
  if (!opened.length) return { confirmed: false, reason: 'official page could not be opened', pages };
  const user = `Claim: ${candidate.claim}\n\n` + opened.map((p, i) => `Official page ${i + 1} (${p.url}):\n${p.text.slice(0, PAGE_TEXT_FOR_MODEL)}`).join('\n\n');
  const res = await callJson(CONFIRM_SYSTEM, user, { maxTokens: 700, validate: (v) => Array.isArray(v?.facts) });
  // Verified against the FULL page text, not the slice the model saw, so a real quote is never lost to the cut.
  const facts = verifyFacts(res.facts, opened);
  return facts.length ? { confirmed: true, facts, pages } : { confirmed: false, reason: 'not found on the official page', pages };
}

const pageUrl = (page, domain) => (/^https?:\/\//i.test(page) ? page : `https://${domain}${page.startsWith('/') ? '' : '/'}${page}`);

export async function run({ siteId, deps = {} }) {
  const getConfig = deps.getConfig || getNewsConfig;
  const callJson = deps.callJson || ((system, user, opts) => callLLMForJson(system, user, { ...opts, siteId }));
  const fetchPage = deps.fetchPage || (async (url) => {
    const r = await analyzePageUrl(url);
    return r.ok ? { ok: true, text: r.analysis.bodyText } : { ok: false, error: r.error };
  });
  const getFeeds = deps.fetchFeeds || fetchAllFeeds;
  const now = deps.now || new Date();

  const config = await getConfig(siteId);
  if (!config?.enabled) return { meta, status: 'skipped', facts: null, narrative: null, message: 'News-based posts are not switched on for this project.', generatedAt: now.toISOString() };
  const countries = (config.official_sources || []).map((s) => s.country).filter(Boolean);
  const feeds = (config.lead_feeds || []).filter((f) => f?.url);
  if (!countries.length || !feeds.length) {
    return { meta, status: 'insufficient-data', facts: { capabilityGap: 'news-config-incomplete' }, narrative: null, message: 'News settings need at least one country with official pages and one lead feed.', generatedAt: now.toISOString() };
  }

  const { items: all, failed, fetched } = await getFeeds(feeds);
  const items = recentItems(all, { maxAgeDays: MAX_AGE_DAYS });
  if (!fetched || items.length < MIN_ITEMS) {
    return { meta, status: 'insufficient-data', facts: { feedsFailed: failed }, narrative: null, message: 'Too few recent headlines were readable this run.', generatedAt: now.toISOString() };
  }

  let raw;
  try {
    raw = await callJson(CANDIDATE_SYSTEM,
      `Countries: ${countries.join(', ')}\n\nHeadlines from the last ${MAX_AGE_DAYS} days:\n` +
      items.map((it, i) => `[${i}] ${it.title}, ${it.source}, ${String(it.publishedAt).slice(0, 10)}${it.summary ? `. ${it.summary}` : ''}`).join('\n'),
      { maxTokens: 1200, validate: (v) => Array.isArray(v?.candidates) });
  } catch (err) {
    if (llmFailure(err, 'x').llmProvider) {
      return { meta, status: 'insufficient-data', facts: { capabilityGap: 'llm-provider-unavailable' }, narrative: null, message: 'The AI provider was unavailable this run. It will be tried again next time.', generatedAt: now.toISOString() };
    }
    throw err;
  }
  const candidates = validateCandidates(raw.candidates, items, countries).slice(0, MAX_CANDIDATES);

  const pages = await (deps.listPages || ((id) => listPageInventory(id, { limit: 800 })))(siteId).catch(() => []);
  const site = await (deps.getSite || getSiteById)(siteId);
  const domain = String(site?.website_domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');

  const confirmed = []; const dropped = [];
  for (const c of candidates) {
    let r;
    try { r = await confirmCandidate(c, config, { callJson, fetchPage }); } catch (e) { logInternal('news-posts.confirmCandidate', e); r = { confirmed: false, reason: 'check failed', pages: [] }; }
    if (r.confirmed) confirmed.push({ c, facts: r.facts });
    else dropped.push({ topic: c.topic, country: c.country, reason: r.reason, leads: c.leads });
  }

  const priorities = priorityByRank(confirmed);
  const findings = confirmed.map(({ c, facts }, i) => {
    const existing = pages.map((p) => String(p.page)).find((p) => alreadyCovered(`${c.topic}`, [p.toLowerCase()]));
    const base = { evidence: { topic: c.topic, country: c.country, claim: c.claim, leads: c.leads, officialFacts: facts, checkedIn: now.toISOString().slice(0, 10) }, priority: priorities[i], expectedImpact: { label: impactFromPriority(priorities[i]), basis: 'estimate' } };
    if (existing) {
      return makeFinding({
        ...base, evidence: { ...base.evidence, page: pageUrl(existing, domain) }, id: `news-posts:refresh:${slugify(c.topic)}`,
        whyItMatters: `The official ${c.country} site confirms a change that this page already covers, so it is refreshed instead of writing a duplicate.`,
        recommendedAction: { label: `Update with the official change: ${c.topic}`, generatorId: 'refresh-content', params: { page: pageUrl(existing, domain), query: c.topic, officialFacts: refreshFacts({ candidate: c, facts, now }) }, effort: effortForGenerator('refresh-content') },
      });
    }
    return makeFinding({
      ...base, id: `news-posts:${slugify(c.topic)}`,
      whyItMatters: `A recent ${c.country} change, confirmed on the official site (${facts[0].url}), that students from Nepal are searching for and that no page on this site covers yet.`,
      recommendedAction: { label: `News: ${c.topic}`, generatorId: 'blog-outline', params: { topic: c.topic, context: newsContext({ candidate: c, facts, styleRules: config.style_rules, now }), category: INSIGHT_CATEGORY }, effort: effortForGenerator('blog-outline') },
    });
  });

  return { meta, status: 'ok', facts: { leadsRead: items.length, candidates: candidates.length, confirmed: confirmed.length, dropped, feedsFailed: failed, findings }, narrative: null, generatedAt: now.toISOString() };
}

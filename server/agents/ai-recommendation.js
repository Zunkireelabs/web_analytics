import { getSiteById, getSearchPerformanceRange } from '../store/read.js';
import { analyzePageUrl } from './lib/page-content.js';
import { resolveOwnDomain, knownDomain, filterOwnDomainPages } from './lib/site-domain.js';
import { sortByRotation } from './lib/rotation.js';
import {
  listActivePrompts, upsertTrackedPrompt, getCheckedAtForPrompts,
  saveAiPromptRun, getLatestPromptRuns, getCompetitorMentionCounts,
} from '../store/ai-recommendation.js';
import { configured as openaiConfigured, ask as askOpenAi, extract as extractOpenAi } from './lib/model-providers/openai.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { effortForGenerator } from './lib/page-content.js';
import { callLLM } from '../llm.js';

// Distinct from server/agents/ai-visibility.js — that agent measures
// structural readiness to be cited (schema/FAQ/robots.txt on this site's
// OWN pages). This agent tests the real thing: does an AI assistant
// actually recommend this company when asked a genuine buyer-style
// question. Different id (registry.js throws on duplicate ids), different
// question, no capability overlap.
export const meta = {
  id: 'ai-recommendation',
  name: 'AI Recommendation Agent',
  description: 'Tests whether ChatGPT actually recommends this company for real buyer-style prompts derived from the site\'s own services, landing pages, and top search queries — not SEO ranking, real AI-answer citation.',
  category: 'content',
  version: 1,
  dataSources: [
    { id: 'openai-prompt-probe', status: openaiConfigured() ? 'connected' : 'not-connected', description: 'Real prompts sent to OpenAI exactly as a genuine user would ask them, checked for a real, JS-verified mention of this company — never a fabricated citation. Requires both OPENAI_API_KEY AND AI_RECOMMENDATION_ENABLED=true — the second flag is a deliberate separate opt-in so this agent never silently activates just because OPENAI_API_KEY happens to be set for the unrelated daily-narrative feature (see lib/model-providers/openai.js).' },
  ],
};

const MAX_TRACKED_PROMPTS = 30; // total prompt-universe cap, independent of how many are probed in one run
const BATCH_SIZE = 15; // real OpenAI probes actually made this run — bounded for cost, rotated over time like every other agent's page batch
const HIGH_INTENT_SOURCES = new Set(['service', 'top-query']);

// Generates a bounded set of realistic buyer-style prompts from the site's
// own real data only — never invents a service/offering not present in the
// given context. Uses the shared callLLM (not the OpenAI-only provider
// below) since this step is generation/phrasing, not the actual "does
// OpenAI recommend us" test — that distinction matters: only the real
// probe below is locked to OpenAI per the agent's design.
async function generatePromptCandidates({ companyName, homepageTitle, homepageDescription, topPages, topQueries }) {
  const system = 'You write realistic buyer-style questions a real prospective customer might ask an AI ' +
    'assistant, based ONLY on the real company context given below — never invent a service, industry, or fact ' +
    'not evidenced in the context. For each of: (1) the company\'s real services/offerings as described on its ' +
    'own homepage, (2) its real top landing pages, (3) its real top search queries — write 1-3 natural questions ' +
    'a buyer might genuinely ask (e.g. "what\'s the best tool for X", "who should I use for Y"), phrased the way ' +
    'a real person would type it, never mentioning the company by name (the test is whether it comes up ' +
    'unprompted). Respond with ONLY a JSON array, each item {"promptText": "...", "source": "service"|"landing-page"|"top-query"}, ' +
    `capped at ${MAX_TRACKED_PROMPTS} items total.`;
  const user = `Company: ${companyName}\nHomepage title: ${homepageTitle || 'unknown'}\n` +
    `Homepage description: ${homepageDescription || 'unknown'}\n` +
    `Top pages: ${topPages.join(', ') || 'none'}\nTop queries: ${topQueries.join(', ') || 'none'}`;
  const raw = await callLLM(system, user, { maxTokens: 900 }).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p) => p && typeof p.promptText === 'string' && ['service', 'landing-page', 'top-query'].includes(p.source))
      .slice(0, MAX_TRACKED_PROMPTS);
  } catch {
    return [];
  }
}

// Deterministic ground truth for "was this company mentioned" — a real
// case-insensitive match of the company's real name or real domain against
// the actual raw response text. Never trusted from the extraction LLM
// call's own self-report of a checkable fact.
function detectMention(rawResponse, companyName, domain) {
  const text = rawResponse.toLowerCase();
  if (companyName && text.includes(companyName.toLowerCase())) return true;
  if (domain && text.includes(domain.toLowerCase())) return true;
  return false;
}

export async function run({ siteId, start, end }) {
  if (!openaiConfigured()) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      requiredDataSources: meta.dataSources,
      message: 'OPENAI_API_KEY and/or AI_RECOMMENDATION_ENABLED=true are not both set — this agent has no real data source to probe with.',
      generatedAt: new Date().toISOString(),
    };
  }

  const site = await getSiteById(siteId);
  const domain = await resolveOwnDomain(site, siteId, start, end);
  const [topPagesRaw, topQueries] = await Promise.all([
    getSearchPerformanceRange(siteId, start, end, 'page', 8),
    getSearchPerformanceRange(siteId, start, end, 'query', 15),
  ]);
  const topPageUrls = filterOwnDomainPages(topPagesRaw, knownDomain(site)).map((p) => p.dim_value);
  const topQueryTexts = topQueries.map((q) => q.dim_value);

  // Refresh the prompt universe from real current data — idempotent
  // (upsertTrackedPrompt), so re-running doesn't duplicate prompts already
  // tracked; only genuinely new ones (site content/queries changed) get added.
  const homepage = topPageUrls[0] ? await analyzePageUrl(topPageUrls[0]).catch(() => ({ ok: false })) : { ok: false };
  const candidates = await generatePromptCandidates({
    companyName: site.name,
    homepageTitle: homepage.ok ? homepage.analysis.title : null,
    homepageDescription: homepage.ok ? homepage.analysis.metaDescription : null,
    topPages: topPageUrls, topQueries: topQueryTexts,
  });
  await Promise.all(candidates.map((c) => upsertTrackedPrompt(siteId, c.promptText, c.source)
    .catch((err) => console.error('[agents] ai-recommendation: failed to upsert prompt:', err.message))));

  const active = await listActivePrompts(siteId);
  if (!active.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      requiredDataSources: meta.dataSources,
      message: 'No real prompt candidates could be derived yet — needs at least one real page/query for this site.',
      generatedAt: new Date().toISOString(),
    };
  }

  const checkedAt = await getCheckedAtForPrompts(siteId, active.map((p) => p.id));
  const rotatedIds = sortByRotation(active.map((p) => p.id), checkedAt);
  const byId = new Map(active.map((p) => [p.id, p]));
  const batch = rotatedIds.slice(0, BATCH_SIZE).map((id) => byId.get(id));

  const runDate = new Date().toISOString().slice(0, 10);
  const results = await Promise.all(batch.map(async (prompt) => {
    try {
      const probe = await askOpenAi(prompt.prompt_text);
      const mentioned = detectMention(probe.raw, site.name, domain);
      const extracted = await extractOpenAi(probe.raw, { companyName: site.name, domain }).catch(() => null);
      const saved = await saveAiPromptRun(siteId, {
        promptId: prompt.id, model: probe.model, runDate, rawResponse: probe.raw, mentioned,
        approximatePosition: mentioned ? (extracted?.approximatePosition ?? null) : null,
        competitorsMentioned: extracted?.competitorsMentioned ?? [],
        sentiment: extracted?.sentiment ?? null,
        recommendationStrength: mentioned ? (extracted?.recommendationStrength ?? null) : 'none',
      });
      return { ...saved, prompt_text: prompt.prompt_text, source: prompt.source };
    } catch (err) {
      console.warn(`[agents] ai-recommendation: probe failed for prompt ${prompt.id}:`, err.message);
      return null;
    }
  }));
  const checked = results.filter(Boolean);

  if (!checked.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      requiredDataSources: meta.dataSources,
      message: 'Every real OpenAI probe failed this run — could not check any prompt.',
      generatedAt: new Date().toISOString(),
    };
  }

  // Real historical comparison for "competitor now appears more often" —
  // this run's window vs. the prior real 30-day window, both drawn from
  // actually-persisted runs, never a single-run snapshot dressed up as a trend.
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const priorSince = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const [currentCounts, priorCounts] = await Promise.all([
    getCompetitorMentionCounts(siteId, since, runDate),
    getCompetitorMentionCounts(siteId, priorSince, since),
  ]);

  const mentionedCount = checked.filter((r) => r.mentioned).length;
  const aiVisibilityPct = Math.round((mentionedCount / checked.length) * 100);
  const missedHighIntent = checked.filter((r) => !r.mentioned && HIGH_INTENT_SOURCES.has(r.source));

  const missedCandidates = [...missedHighIntent].sort((a, b) => (a.source === 'top-query' ? -1 : 1) - (b.source === 'top-query' ? -1 : 1));
  const missedPriorities = priorityByRank(missedCandidates);
  const missedFindings = missedCandidates.map((r, i) => makeFinding({
    id: `ai-recommendation:missed:${r.id}`,
    evidence: { promptText: r.prompt_text, source: r.source, competitorsMentioned: r.competitors_mentioned },
    whyItMatters: `A real buyer-style prompt ("${r.prompt_text}") got no mention of this company in ChatGPT's answer.`,
    priority: missedPriorities[i],
    recommendedAction: { label: 'Cover this topic', generatorId: 'blog-outline', params: { topic: r.prompt_text, context: `Derived from a real, unmentioned AI-recommendation prompt (source: ${r.source}).` }, effort: effortForGenerator('blog-outline') },
    expectedImpact: { label: impactFromPriority(missedPriorities[i]), basis: 'estimate', value: null },
  }));

  const risingCompetitors = [...currentCounts.entries()]
    .map(([name, count]) => ({ name, current: count, prior: priorCounts.get(name) || 0 }))
    .filter((c) => c.current > c.prior && priorCounts.size > 0)
    .sort((a, b) => (b.current - b.prior) - (a.current - a.prior));
  const risingPriorities = priorityByRank(risingCompetitors);
  const risingFindings = risingCompetitors.slice(0, 3).map((c, i) => makeFinding({
    id: `ai-recommendation:rising-competitor:${c.name}`,
    evidence: { competitor: c.name, currentMentions: c.current, priorMentions: c.prior },
    whyItMatters: `"${c.name}" now appears in ${c.current} tracked AI answers this period, up from ${c.prior} previously.`,
    priority: risingPriorities[i],
    recommendedAction: null,
    expectedImpact: { label: impactFromPriority(risingPriorities[i]), basis: 'computed', value: c.current - c.prior },
  }));

  const findings = [...missedFindings, ...risingFindings];

  const facts = {
    rangeStart: start, rangeEnd: end, domain,
    promptsChecked: checked.length, mentionedCount, aiVisibilityPct,
    topPrompts: checked.filter((r) => r.mentioned).map((r) => ({ promptText: r.prompt_text, position: r.approximate_position })),
    missedPrompts: checked.filter((r) => !r.mentioned).map((r) => ({ promptText: r.prompt_text, competitorsMentioned: r.competitors_mentioned })),
    competitorsAppearingInstead: [...currentCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    findings,
    note: 'aiVisibilityPct and mentioned/missed prompts are computed from a real, deterministic JS string/domain ' +
      'match against each raw OpenAI response — never trusted from the model\'s own self-report. ' +
      'approximatePosition/competitorsMentioned/sentiment/recommendationStrength are a separate LLM extraction ' +
      'pass over the already-real response text, confidence-unlabeled qualitative parsing, not independently verified facts.',
  };

  const system = 'You are a growth strategist writing for a non-technical site owner about their real AI ' +
    'Visibility — whether ChatGPT actually recommends their company for real buyer questions (not SEO ranking). ' +
    'Given a real AI Visibility percentage (mentioned/total prompts checked, JS-verified), real missed prompts, ' +
    'and any real rising competitor mention counts, write 2-4 sentences: state the percentage, name the most ' +
    'notable missed high-intent prompt if any, and name a rising competitor if the data shows one. Use ONLY the ' +
    'numbers/names given, never invent a competitor or percentage not present in the facts. Plain text, no ' +
    'markdown, no bullets.';
  const narrative = await callLLM(system, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 350 })
    .catch((err) => { console.warn('[agents] ai-recommendation narrative failed:', err.message); return null; });

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}

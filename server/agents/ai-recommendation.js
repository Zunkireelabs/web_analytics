import { getSiteById, getSearchPerformanceRange } from '../store/read.js';
import { analyzePageUrl } from './lib/page-content.js';
import { resolveOwnDomain, knownDomain, filterOwnDomainPages } from './lib/site-domain.js';
import { sortByRotation } from './lib/rotation.js';
import {
  listActivePrompts, upsertTrackedPrompt, getCheckedAtForPrompts,
  saveAiPromptRun, getLatestPromptRuns, getCompetitorMentionCounts,
} from '../store/ai-recommendation.js';
import { PROVIDERS, getConfiguredProviders } from './lib/model-providers/index.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { effortForGenerator } from './lib/page-content.js';
import { callLLM } from '../llm.js';

// Distinct from server/agents/ai-visibility.js — that agent measures
// structural readiness to be cited (schema/FAQ/robots.txt on this site's
// OWN pages). This agent tests the real thing: does an AI assistant
// actually recommend this company when asked a genuine buyer-style
// question. Different id (registry.js throws on duplicate ids), different
// question, no capability overlap.
//
// meta.dataSources is built from lib/model-providers' own PROVIDERS list
// rather than hand-listing each one here — a new provider file
// automatically gets its own honest connected/not-connected row with zero
// changes needed in this agent, same "one file, no registry edits" spirit
// as the top-level agents/generators registries.
export const meta = {
  id: 'ai-recommendation',
  name: 'AI Recommendation Agent',
  description: 'Tests whether real AI assistants (ChatGPT, and any other configured provider) actually recommend this company for real buyer-style prompts derived from the site\'s own services, landing pages, and top search queries — not SEO ranking, real AI-answer citation.',
  category: 'content',
  version: 2, // bumped: facts.aiVisibilityPct is now a per-provider blended mean
              // (see run() below), not a single-provider pooled ratio — a
              // pre-v2 agent_runs row's aiVisibilityPct is computed the old
              // way and shouldn't be compared directly against a v2 row's.
  dataSources: PROVIDERS.map((p) => ({
    id: `${p.id}-prompt-probe`,
    status: p.configured() ? 'connected' : 'not-connected',
    description: p.id === 'openai'
      ? 'Real prompts sent to OpenAI exactly as a genuine user would ask them, checked for a real, JS-verified mention of this company — never a fabricated citation. Requires both OPENAI_API_KEY AND AI_RECOMMENDATION_ENABLED=true — the second flag is a deliberate separate opt-in so this agent never silently activates just because OPENAI_API_KEY happens to be set for the unrelated daily-narrative feature (see lib/model-providers/openai.js).'
      : `Real prompts sent to ${p.id} exactly as a genuine user would ask them, checked for a real, JS-verified mention of this company — never a fabricated citation. Requires AI_RECOMMENDATION_ENABLED=true, a real API key, AND this provider's own dedicated enable flag (see lib/model-providers/${p.id}.js) — never silently activated by a key alone.`,
  })),
};

const MAX_TRACKED_PROMPTS = 30; // total prompt-universe cap, independent of how many are probed in one run
// Real probes actually made per configured provider, per run — bounded for
// cost, rotated over time like every other agent's page batch. Total probe
// volume this run is BATCH_SIZE × configured-provider-count × 2 calls
// (ask+extract), so enabling more providers is an explicit lever an
// operator can dial this back for, not a silent cost multiplier.
const BATCH_SIZE = Number(process.env.AI_RECOMMENDATION_BATCH_SIZE) || 15;
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

// Plain .includes() false-positives on a short/generic name or domain (e.g.
// company "Go" inside "Google", or domain "ai.com" inside "trainai.com").
// Requires a non-alphanumeric character (or the string's own start/end) on
// both sides of the match — true for a real word boundary (space, start/end
// of text) AND for punctuation a domain/multi-word name legitimately sits
// next to in real prose (a period, slash, comma, parenthesis), so this
// doesn't just harden the short-name case, it stays correct for the normal
// case too.
function includesWholeMatch(text, needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(text);
}

// Deterministic ground truth for "was this company mentioned" — a real
// case-insensitive match of the company's real name or real domain against
// the actual raw response text. Never trusted from the extraction LLM
// call's own self-report of a checkable fact.
function detectMention(rawResponse, companyName, domain) {
  const text = rawResponse.toLowerCase();
  if (companyName && includesWholeMatch(text, companyName.toLowerCase())) return true;
  if (domain && includesWholeMatch(text, domain.toLowerCase())) return true;
  return false;
}

// Pure, DB/API-free aggregation helpers — exported so the multi-provider
// blending/percentage math has real unit test coverage (server/agents/
// ai-recommendation.test.js) without needing a live DB or real provider
// calls; run() below is the only caller in production.

// Every entry in `perProviderResults` is `{ providerId, checked }`, one per
// PROVIDER THAT WAS ACTUALLY CONFIGURED this run (see getConfiguredProviders())
// — including one whose every probe failed (`checked: []`), which becomes
// `aiVisibilityPct: null` here, never a fabricated 0%. Never includes a
// not-configured provider at all (no zero row for something never attempted).
export function computeProviderFacts(perProviderResults) {
  return perProviderResults.map((p) => {
    const providerMentioned = p.checked.filter((r) => r.mentioned).length;
    return {
      id: p.providerId,
      model: p.checked[0]?.model ?? null,
      promptsChecked: p.checked.length,
      mentionedCount: providerMentioned,
      aiVisibilityPct: p.checked.length ? Math.round((providerMentioned / p.checked.length) * 100) : null,
    };
  });
}

// The headline percentage is the UNWEIGHTED MEAN of each configured
// provider's own rate, not a pooled mention/checked ratio — so whichever
// provider happens to have a larger checked-count this run can't silently
// dominate the blended number. With exactly one configured provider (this
// agent's original, still-default behavior) this is identical to the old
// pooled ratio. Providers with promptsChecked === 0 (aiVisibilityPct: null)
// are excluded from the mean — a fully-failed provider shouldn't drag the
// average toward 0. Returns 0 only when there are literally no rates to
// average (should be unreachable in practice — run() already returns
// insufficient-data before this point when every provider's checked
// array is empty).
export function computeBlendedVisibilityPct(providerFacts) {
  const rates = providerFacts.filter((p) => p.aiVisibilityPct != null).map((p) => p.aiVisibilityPct);
  if (!rates.length) return 0;
  return Math.round(rates.reduce((sum, pct) => sum + pct, 0) / rates.length);
}

// "Share of AI Voice" (this company's real mentions as a fraction of every
// real mention — us plus every named competitor — in the window) and
// "Competitor Citation Gap" (the real leading competitor's window rate
// minus this company's own window rate: positive means a competitor
// leads, negative means this company leads) — both purely arithmetic over
// already-persisted counts (server/store/ai-recommendation.js's
// getCompetitorMentionCounts), never estimated or LLM-generated. Returns
// null fields (never NaN or a fabricated 0) when there's no real window
// data yet (totalProbes === 0) or no competitor was ever mentioned.
export function computeVoiceAndGap({ ourMentions, totalProbes, competitorCounts }) {
  const totalCompetitorMentions = [...competitorCounts.values()].reduce((sum, c) => sum + c, 0);
  const voiceDenominator = ourMentions + totalCompetitorMentions;
  const shareOfAiVoicePct = voiceDenominator > 0 ? Math.round((ourMentions / voiceDenominator) * 100) : null;

  const ourWindowPct = totalProbes > 0 ? (ourMentions / totalProbes) * 100 : null;
  let topCompetitorName = null;
  let topCompetitorCount = 0;
  for (const [name, count] of competitorCounts) {
    if (count > topCompetitorCount) { topCompetitorName = name; topCompetitorCount = count; }
  }
  const topCompetitorWindowPct = totalProbes > 0 ? (topCompetitorCount / totalProbes) * 100 : null;
  const competitorCitationGapPct = (ourWindowPct != null && topCompetitorWindowPct != null)
    ? Math.round(topCompetitorWindowPct - ourWindowPct)
    : null;

  return { shareOfAiVoicePct, competitorCitationGapPct, topCompetitorName, ourWindowPct, topCompetitorWindowPct };
}

export async function run({ siteId, start, end }) {
  const providers = getConfiguredProviders();
  if (!providers.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      requiredDataSources: meta.dataSources,
      message: 'No AI provider is configured to probe with — set OPENAI_API_KEY + AI_RECOMMENDATION_ENABLED=true (or another provider\'s own key + dedicated enable flag; see lib/model-providers/).',
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
  // Every configured provider probes the same rotated batch independently —
  // a provider's own failure (transient API error, etc.) never blocks
  // another provider's results; each is caught per-(prompt, provider) pair,
  // same discipline as the original single-provider loop.
  const perProviderResults = await Promise.all(providers.map(async (provider) => {
    const results = await Promise.all(batch.map(async (prompt) => {
      try {
        const probe = await provider.ask(prompt.prompt_text);
        const mentioned = detectMention(probe.raw, site.name, domain);
        const extracted = await provider.extract(probe.raw, { companyName: site.name, domain }).catch(() => null);
        const saved = await saveAiPromptRun(siteId, {
          promptId: prompt.id, provider: provider.id, model: probe.model, runDate, rawResponse: probe.raw, mentioned,
          approximatePosition: mentioned ? (extracted?.approximatePosition ?? null) : null,
          competitorsMentioned: extracted?.competitorsMentioned ?? [],
          sentiment: extracted?.sentiment ?? null,
          recommendationStrength: mentioned ? (extracted?.recommendationStrength ?? null) : 'none',
        });
        return { ...saved, prompt_text: prompt.prompt_text, source: prompt.source };
      } catch (err) {
        console.warn(`[agents] ai-recommendation: ${provider.id} probe failed for prompt ${prompt.id}:`, err.message);
        return null;
      }
    }));
    return { providerId: provider.id, checked: results.filter(Boolean) };
  }));

  // Pooled across every configured provider — for exactly one configured
  // provider (today's default/only-OpenAI-configured deployment) this is
  // identical in content to the original single-provider `checked` array.
  const checked = perProviderResults.flatMap((p) => p.checked);

  if (!checked.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      requiredDataSources: meta.dataSources,
      message: 'Every real AI probe failed this run (across every configured provider) — could not check any prompt.',
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
  const providerFacts = computeProviderFacts(perProviderResults);
  const aiVisibilityPct = computeBlendedVisibilityPct(providerFacts);

  const missedHighIntent = checked.filter((r) => !r.mentioned && HIGH_INTENT_SOURCES.has(r.source));

  const missedCandidates = [...missedHighIntent].sort((a, b) => (a.source === 'top-query' ? -1 : 1) - (b.source === 'top-query' ? -1 : 1));
  const missedPriorities = priorityByRank(missedCandidates);
  const missedFindings = missedCandidates.map((r, i) => makeFinding({
    id: `ai-recommendation:missed:${r.id}`,
    evidence: { promptText: r.prompt_text, source: r.source, provider: r.provider, competitorsMentioned: r.competitors_mentioned },
    whyItMatters: `A real buyer-style prompt ("${r.prompt_text}") got no mention of this company in ${r.provider}'s answer.`,
    priority: missedPriorities[i],
    recommendedAction: { label: 'Cover this topic', generatorId: 'blog-outline', params: { topic: r.prompt_text, context: `Derived from a real, unmentioned AI-recommendation prompt (source: ${r.source}).` }, effort: effortForGenerator('blog-outline') },
    expectedImpact: { label: impactFromPriority(missedPriorities[i]), basis: 'estimate', value: null },
  }));

  const risingCompetitors = [...currentCounts.competitorCounts.entries()]
    .map(([name, count]) => ({ name, current: count, prior: priorCounts.competitorCounts.get(name) || 0 }))
    .filter((c) => c.current > c.prior && priorCounts.competitorCounts.size > 0)
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

  // "Share of AI Voice" / "Competitor Citation Gap" — both computed purely
  // from the real, already-fetched current-window counts (no new query, no
  // LLM involved in either number); see computeVoiceAndGap above for the
  // null-safe arithmetic itself.
  const { shareOfAiVoicePct, competitorCitationGapPct, topCompetitorName, ourWindowPct, topCompetitorWindowPct } = computeVoiceAndGap({
    ourMentions: currentCounts.ourMentions, totalProbes: currentCounts.totalProbes, competitorCounts: currentCounts.competitorCounts,
  });

  // Only surfaced as a finding when a real competitor genuinely leads this
  // window (gap > 0) — no finding when this company is ahead or tied, same
  // "real signal only" discipline as risingFindings' current > prior filter.
  const citationGapFindings = (competitorCitationGapPct > 0 && topCompetitorName) ? [makeFinding({
    id: `ai-recommendation:citation-gap:${topCompetitorName}`,
    evidence: { competitor: topCompetitorName, ourPct: Math.round(ourWindowPct), competitorPct: Math.round(topCompetitorWindowPct), gapPct: competitorCitationGapPct },
    whyItMatters: `"${topCompetitorName}" is cited ${competitorCitationGapPct} percentage point${competitorCitationGapPct === 1 ? '' : 's'} more often than this company across tracked AI-answer prompts this period.`,
    priority: competitorCitationGapPct >= 20 ? 'high' : competitorCitationGapPct >= 10 ? 'medium' : 'low',
    recommendedAction: null,
    expectedImpact: { label: impactFromPriority(competitorCitationGapPct >= 20 ? 'high' : competitorCitationGapPct >= 10 ? 'medium' : 'low'), basis: 'computed', value: competitorCitationGapPct },
  })] : [];

  const findings = [...missedFindings, ...risingFindings, ...citationGapFindings];

  const facts = {
    rangeStart: start, rangeEnd: end, domain,
    promptsChecked: checked.length, mentionedCount, aiVisibilityPct,
    providers: providerFacts, providerCount: providerFacts.length,
    shareOfAiVoicePct, competitorCitationGapPct,
    topPrompts: checked.filter((r) => r.mentioned).map((r) => ({ promptText: r.prompt_text, position: r.approximate_position, provider: r.provider })),
    missedPrompts: checked.filter((r) => !r.mentioned).map((r) => ({ promptText: r.prompt_text, competitorsMentioned: r.competitors_mentioned, provider: r.provider })),
    competitorsAppearingInstead: [...currentCounts.competitorCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    findings,
    note: 'aiVisibilityPct and mentioned/missed prompts are computed from a real, deterministic JS string/domain ' +
      'match against each raw AI response — never trusted from the model\'s own self-report. ' +
      'approximatePosition/competitorsMentioned/sentiment/recommendationStrength are a separate LLM extraction ' +
      'pass over the already-real response text, confidence-unlabeled qualitative parsing, not independently verified facts. ' +
      'When more than one AI model is configured, the top-level aiVisibilityPct is the average of each model\'s own ' +
      'rate, not a pooled mention/checked count — see facts.providers for the real per-model breakdown. ' +
      'shareOfAiVoicePct and competitorCitationGapPct are both computed purely from real, already-persisted ' +
      'mention counts over the current 30-day window — never estimated or generated by the model.',
  };

  const system = 'You are a growth strategist writing for a non-technical site owner about their real AI ' +
    'Visibility — whether real AI assistants actually recommend their company for real buyer questions (not SEO ranking). ' +
    'Given a real AI Visibility percentage (mentioned/total prompts checked, JS-verified), real missed prompts, ' +
    'and any real rising competitor mention counts, write 2-4 sentences: state the percentage, name the most ' +
    'notable missed high-intent prompt if any, and name a rising competitor if the data shows one. Use ONLY the ' +
    'numbers/names given, never invent a competitor or percentage not present in the facts. Plain text, no ' +
    'markdown, no bullets.';
  const narrative = await callLLM(system, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 350 })
    .catch((err) => { console.warn('[agents] ai-recommendation narrative failed:', err.message); return null; });

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}

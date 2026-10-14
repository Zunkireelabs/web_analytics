import { getSiteById } from '../store/read.js';
import { getLatestAuthoritySnapshot, saveAuthoritySnapshot } from '../store/authority.js';
import { configured as dataForSeoBacklinksConfigured, fetchBacklinkSummary, fetchBacklinkChanges, fetchAnchorDistribution, fetchTopLinkedPages } from '../ingest/dataforseo-backlinks.js';
import { fetchDomainSummary as fetchCommonCrawlSummary } from '../providers/backlinks/commoncrawl.js';
import { computeAuthorityScore, diffBreakdowns, SCORING_VERSION } from './lib/authority-score.js';
import { resolveOwnDomain } from './lib/site-domain.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'authority',
  name: 'Authority Agent',
  description: 'Computes a proprietary, transparent 0-100 Authority Score from real DataForSEO backlink data — referring domains, link diversity, follow ratio, growth trend, and anchor-text diversity. Falls back to a coarser, referring-domain-only estimate from free Common Crawl data when DataForSEO isn\'t configured.',
  category: 'seo',
  version: 1,
  dataSources: [
    { id: 'dataforseo-backlinks', status: dataForSeoBacklinksConfigured() ? 'connected' : 'not-connected', description: 'Real backlink profile (referring domains/IPs/subnets, follow/nofollow split, new/lost backlinks, anchor-text distribution) via DataForSEO\'s Backlinks API — the full 5-signal score. Without this configured, falls back to the coarser Common Crawl estimate below.' },
    { id: 'commoncrawl-backlinks', status: 'connected', description: 'Free referring-domain count + graph rank from Common Crawl\'s public web graph (server/providers/backlinks/commoncrawl.js), used only as a fallback when DataForSEO isn\'t configured. Supplies just 1 of the 5 real score components (referring domains) — no follow/nofollow, anchor-text, or IP/subnet data exists in this source, so the resulting score is a coarser, single-signal estimate, always labeled as such.' },
  ],
};

const LOST_BACKLINKS_SPIKE_RATIO = 0.05; // lost >= 5% of total referring domains this run is a real, worth-flagging spike

export async function run({ siteId, start, end }) {
  const site = await getSiteById(siteId);
  const domain = await resolveOwnDomain(site, siteId, start, end);
  if (!domain) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      requiredDataSources: meta.dataSources,
      message: 'Could not resolve this site\'s own domain yet — no real page data to derive it from.',
      generatedAt: new Date().toISOString(),
    };
  }

  return dataForSeoBacklinksConfigured()
    ? runWithDataForSeo({ siteId, domain, start, end })
    : runWithCommonCrawlFallback({ siteId, domain, start, end });
}

async function runWithDataForSeo({ siteId, domain, start, end }) {
  const since30d = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [summary, changes, anchors, topLinkedPages, prior] = await Promise.all([
    fetchBacklinkSummary(domain).catch((err) => { console.warn('[agents] authority: backlink summary failed:', err.message); return null; }),
    fetchBacklinkChanges(domain, since30d).catch((err) => { console.warn('[agents] authority: backlink changes failed:', err.message); return null; }),
    fetchAnchorDistribution(domain).catch((err) => { console.warn('[agents] authority: anchor distribution failed:', err.message); return null; }),
    fetchTopLinkedPages(domain).catch((err) => { console.warn('[agents] authority: top linked pages failed:', err.message); return []; }),
    getLatestAuthoritySnapshot(siteId),
  ]);

  if (!summary) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      requiredDataSources: meta.dataSources,
      message: `DataForSEO returned no backlink summary for ${domain} this run.`,
      generatedAt: new Date().toISOString(),
    };
  }

  const computed = computeAuthorityScore({ summary, changes: changes || {}, anchors: anchors || [] });
  if (!computed) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      requiredDataSources: meta.dataSources,
      message: `DataForSEO returned no usable backlink metrics for ${domain} this run.`,
      generatedAt: new Date().toISOString(),
    };
  }

  const snapshotDate = new Date().toISOString().slice(0, 10);
  const saved = await saveAuthoritySnapshot(siteId, snapshotDate, {
    scoringVersion: SCORING_VERSION, dataSource: 'dataforseo',
    referringDomains: summary.referringDomains, referringMainDomains: summary.referringMainDomains,
    totalBacklinks: summary.totalBacklinks, followBacklinks: summary.followBacklinks, nofollowBacklinks: summary.nofollowBacklinks,
    referringIps: summary.referringIps, referringSubnets: summary.referringSubnets,
    newBacklinks30d: changes?.newBacklinks ?? null, lostBacklinks30d: changes?.lostBacklinks ?? null,
    anchorDiversityScore: computed.breakdown.find((c) => c.key === 'anchorDiversity')?.score ?? null,
    authorityScore: computed.score, scoreBreakdown: computed.breakdown, topLinkedPages, rawSummary: summary,
  }).catch((err) => { console.error('[agents] authority: failed to persist snapshot:', err.message); return null; });

  // Only compare against a prior snapshot from the SAME data source —
  // otherwise a source switch (e.g. DataForSEO just got configured after
  // running on the Common Crawl fallback) would misread as a real swing.
  const priorComparable = prior && prior.scoring_version === SCORING_VERSION && prior.data_source === 'dataforseo' ? prior : null;
  const priorScore = priorComparable?.authority_score ?? null;
  const scoreDelta = priorScore != null ? computed.score - priorScore : null;
  const reasons = priorComparable ? diffBreakdowns(computed.breakdown, priorComparable.score_breakdown) : [];

  const findings = [];
  if (scoreDelta != null && scoreDelta !== 0) {
    findings.push(makeFinding({
      id: `authority:score-change:${snapshotDate}`,
      evidence: { domain, score: computed.score, priorScore, delta: scoreDelta, reasons },
      whyItMatters: `Authority Score ${scoreDelta > 0 ? 'rose' : 'fell'} from ${priorScore} to ${computed.score}${reasons.length ? ` — ${reasons.join(', ')}.` : '.'}`,
      priority: scoreDelta < 0 ? 'medium' : 'low',
      recommendedAction: null,
      expectedImpact: { label: impactFromPriority(scoreDelta < 0 ? 'medium' : 'low'), basis: 'computed', value: Math.abs(scoreDelta) },
    }));
  }

  const lostRatio = summary.referringDomains > 0 ? (changes?.lostBacklinks ?? 0) / summary.referringDomains : 0;
  if (lostRatio >= LOST_BACKLINKS_SPIKE_RATIO) {
    findings.push(makeFinding({
      id: `authority:lost-backlinks-spike:${snapshotDate}`,
      evidence: { domain, lostBacklinks: changes.lostBacklinks, referringDomains: summary.referringDomains, lostRatio },
      whyItMatters: `${changes.lostBacklinks} backlinks were lost in the last 30 days — a real, notable share of this site's ${summary.referringDomains} referring domains.`,
      priority: 'high',
      recommendedAction: null,
      // A backlink lives on someone else's website, so nothing in this
      // repository can restore one — but a spike this size is a confirmed
      // problem, not a number, and it needs a person to look at who stopped
      // linking and why. Surfaced read-only rather than dropped.
      reportOnly: {
        kind: 'authority-backlinks-lost',
        label: `${changes.lostBacklinks} backlinks lost in 30 days`,
        page: '',
        whyBlocked: 'These links are on other people\'s websites, so there is no change to this site that can restore them. Someone needs to look at which sites stopped linking here and whether it is worth re-establishing those relationships.',
      },
      expectedImpact: { label: 'High', basis: 'computed', value: changes.lostBacklinks },
    }));
  }

  const facts = {
    rangeStart: start, rangeEnd: end, domain, dataSource: 'dataforseo',
    authorityScore: computed.score, priorScore, scoreDelta, scoringVersion: SCORING_VERSION,
    scoreBreakdown: computed.breakdown,
    referringDomains: summary.referringDomains, totalBacklinks: summary.totalBacklinks,
    followBacklinks: summary.followBacklinks, nofollowBacklinks: summary.nofollowBacklinks,
    referringIps: summary.referringIps, referringSubnets: summary.referringSubnets,
    newBacklinks30d: changes?.newBacklinks ?? null, lostBacklinks30d: changes?.lostBacklinks ?? null,
    topLinkedPages,
    findings,
    note: 'authorityScore and every component in scoreBreakdown are computed by a documented, versioned formula ' +
      '(server/agents/lib/authority-score.js) over real DataForSEO backlink data — never a random or estimated ' +
      'value. A component is included only when its underlying real data was returned this run; missing ' +
      'components are omitted and the remaining weights renormalize, never fabricated as zero.',
  };

  const system = 'You are an SEO strategist writing for a non-technical site owner about their site\'s Authority ' +
    'Score (a proprietary 0-100 backlink-based score, NOT Ahrefs DR or Moz DA). Given the real current score, the ' +
    'prior score if available, and the real reasons for any change (from a documented, versioned scoring formula ' +
    'over real backlink data), write 2-4 sentences explaining the score and, if it changed, why — cite the real ' +
    'reasons given. If backlinks were lost this period, mention it plainly. Use ONLY the numbers/reasons given, ' +
    'never invent a cause not present in the facts. Plain text, no markdown, no bullets.';
  const narrative = await callLLM(system, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 350 })
    .catch((err) => { console.warn('[agents] authority narrative failed:', err.message); return null; });

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString(), _snapshotId: saved?.id };
}

// Free fallback when DataForSEO isn't configured — Common Crawl's public web
// graph only ever supplies a referring-domain count and a graph rank, never
// per-link detail (see providers/backlinks/commoncrawl.js's own contract
// comment). computeAuthorityScore already renormalizes around whichever
// components have real data, so this reuses that exact formula with only
// `referringDomains` populated — a real, single-signal score, honestly
// labeled as coarser than the full DataForSEO-based one, never dressed up
// as equivalent.
async function runWithCommonCrawlFallback({ siteId, domain, start, end }) {
  const [ccSummary, prior] = await Promise.all([
    fetchCommonCrawlSummary(domain).catch((err) => { console.warn('[agents] authority: common crawl summary failed:', err.message); return null; }),
    getLatestAuthoritySnapshot(siteId),
  ]);

  if (!ccSummary) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      requiredDataSources: meta.dataSources,
      message: `DataForSEO isn't configured, and Common Crawl has no imported data for ${domain} yet (run npm run refresh-commoncrawl-graph, then wait for the next real crawl release to include this domain).`,
      generatedAt: new Date().toISOString(),
    };
  }

  const computed = computeAuthorityScore({ summary: { referringDomains: ccSummary.referringDomains }, changes: {}, anchors: [] });
  if (!computed) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      requiredDataSources: meta.dataSources,
      message: `Common Crawl returned no usable referring-domain count for ${domain} this run.`,
      generatedAt: new Date().toISOString(),
    };
  }

  const snapshotDate = new Date().toISOString().slice(0, 10);
  const saved = await saveAuthoritySnapshot(siteId, snapshotDate, {
    scoringVersion: SCORING_VERSION, dataSource: 'commoncrawl',
    referringDomains: ccSummary.referringDomains,
    authorityScore: computed.score, scoreBreakdown: computed.breakdown,
    rawSummary: ccSummary,
  }).catch((err) => { console.error('[agents] authority: failed to persist snapshot:', err.message); return null; });

  // Only compare against a prior snapshot from the SAME data source — a
  // switch between DataForSEO and this fallback must never read as a real
  // authority swing.
  const priorComparable = prior && prior.scoring_version === SCORING_VERSION && prior.data_source === 'commoncrawl' ? prior : null;
  const priorScore = priorComparable?.authority_score ?? null;
  const scoreDelta = priorScore != null ? computed.score - priorScore : null;

  const facts = {
    rangeStart: start, rangeEnd: end, domain, dataSource: 'commoncrawl',
    authorityScore: computed.score, priorScore, scoreDelta, scoringVersion: SCORING_VERSION,
    scoreBreakdown: computed.breakdown,
    referringDomains: ccSummary.referringDomains, graphRank: ccSummary.graphRank, graphRelease: ccSummary.graphRelease,
    findings: [],
    note: 'DataForSEO backlink credentials are not configured, so this score is a coarser estimate from free ' +
      'Common Crawl data — referring-domain count only, re-weighted to 100% of the score since the other 4 real ' +
      'signals (IP/subnet diversity, follow-link ratio, 30-day growth, anchor-text diversity) have no equivalent ' +
      'in this data source. Not equivalent to the full DataForSEO-based Authority Score — never presented as one.',
  };

  const system = 'You are an SEO strategist writing for a non-technical site owner about their site\'s Authority ' +
    'Score. IMPORTANT: this run is a coarser estimate from free Common Crawl data (referring-domain count only) ' +
    'because DataForSEO isn\'t configured — you MUST say plainly that this is a partial estimate based only on ' +
    'referring-domain count, not the full backlink-profile score, in your first sentence. Then, in 1-3 more ' +
    'sentences, explain the real number and any real change from the prior estimate. Use ONLY the numbers given, ' +
    'never invent a cause not present in the facts. Plain text, no markdown, no bullets.';
  const narrative = await callLLM(system, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 300 })
    .catch((err) => { console.warn('[agents] authority narrative failed:', err.message); return null; });

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString(), _snapshotId: saved?.id };
}

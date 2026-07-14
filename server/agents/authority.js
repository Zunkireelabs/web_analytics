import { getSiteById } from '../store/read.js';
import { getLatestAuthoritySnapshot, saveAuthoritySnapshot } from '../store/authority.js';
import { configured as dataForSeoBacklinksConfigured, fetchBacklinkSummary, fetchBacklinkChanges, fetchAnchorDistribution, fetchTopLinkedPages } from '../ingest/dataforseo-backlinks.js';
import { computeAuthorityScore, diffBreakdowns, SCORING_VERSION } from './lib/authority-score.js';
import { resolveOwnDomain } from './lib/site-domain.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'authority',
  name: 'Authority Agent',
  description: 'Computes a proprietary, transparent 0-100 Authority Score from real DataForSEO backlink data — referring domains, link diversity, follow ratio, growth trend, and anchor-text diversity.',
  category: 'seo',
  version: 1,
  dataSources: [
    { id: 'dataforseo-backlinks', status: dataForSeoBacklinksConfigured() ? 'connected' : 'not-connected', description: 'Real backlink profile (referring domains/IPs/subnets, follow/nofollow split, new/lost backlinks, anchor-text distribution) via DataForSEO\'s Backlinks API. Without this configured, the Authority Score cannot be computed — reported as insufficient-data, never estimated or guessed.' },
  ],
};

const LOST_BACKLINKS_SPIKE_RATIO = 0.05; // lost >= 5% of total referring domains this run is a real, worth-flagging spike

export async function run({ siteId, start, end }) {
  if (!dataForSeoBacklinksConfigured()) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      requiredDataSources: meta.dataSources,
      message: 'DataForSEO backlink credentials are not configured — the Authority Score has no real data source to compute from.',
      generatedAt: new Date().toISOString(),
    };
  }

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
    scoringVersion: SCORING_VERSION,
    referringDomains: summary.referringDomains, referringMainDomains: summary.referringMainDomains,
    totalBacklinks: summary.totalBacklinks, followBacklinks: summary.followBacklinks, nofollowBacklinks: summary.nofollowBacklinks,
    referringIps: summary.referringIps, referringSubnets: summary.referringSubnets,
    newBacklinks30d: changes?.newBacklinks ?? null, lostBacklinks30d: changes?.lostBacklinks ?? null,
    anchorDiversityScore: computed.breakdown.find((c) => c.key === 'anchorDiversity')?.score ?? null,
    authorityScore: computed.score, scoreBreakdown: computed.breakdown, topLinkedPages, rawSummary: summary,
  }).catch((err) => { console.error('[agents] authority: failed to persist snapshot:', err.message); return null; });

  const priorScore = prior && prior.scoring_version === SCORING_VERSION ? prior.authority_score : null;
  const scoreDelta = priorScore != null ? computed.score - priorScore : null;
  const reasons = prior && prior.scoring_version === SCORING_VERSION ? diffBreakdowns(computed.breakdown, prior.score_breakdown) : [];

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
      expectedImpact: { label: 'High', basis: 'computed', value: changes.lostBacklinks },
    }));
  }

  const facts = {
    rangeStart: start, rangeEnd: end, domain,
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

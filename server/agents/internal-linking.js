import { getSearchPerformanceForPages } from '../store/read.js';
import { flagBelowAverage } from './lib/ctr-anomaly.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { analyzePageUrl } from './lib/page-content.js';
import { selectCandidatePages, markPagesChecked } from './lib/candidate-pages.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'internal-linking',
  name: 'Internal Linking Agent',
  description: 'Analyzes the site\'s own internal link structure — pages with unusually few outbound internal links relative to this site\'s own average, real internal-link dead ends.',
  category: 'seo',
  version: 1,
  // Orphaned-page detection (pages no internal link reaches at all) already
  // exists on technical-seo.js via the weekly site-wide crawl comparison —
  // deliberately not duplicated here. This agent measures a different real
  // signal: pages that ARE reachable but themselves link out to very little
  // of the rest of the site, which starves whatever they DO link to of
  // internal link equity.
};

const MAX_PAGES = 20;
// Below this real sample size, "this site's own average" isn't a
// trustworthy baseline yet — same reasoning content-gap.js's
// MIN_TRACKED_COMPETITORS ratio-gating uses, applied to sample size instead
// of competitor count.
const MIN_PAGES_FOR_AVERAGE = 5;

export async function run({ siteId, start, end, pageCache, params }) {
  const { batch, impressionsByPage } = params?.pages?.length
    ? await getSearchPerformanceForPages(siteId, start, end, params.pages).then((rows) => ({
      batch: params.pages,
      impressionsByPage: new Map(rows.map((r) => [r.dim_value, Number(r.impressions)])),
    }))
    : await selectCandidatePages(siteId, 'internal-linking', { start, end, batchSize: MAX_PAGES });

  if (!batch.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No page performance data yet to select pages from.',
      generatedAt: new Date().toISOString(),
    };
  }

  const fetchPage = pageCache || analyzePageUrl;
  const fetched = await Promise.all(batch.map(async (page) => ({ page, result: await fetchPage(page) })));
  if (!params?.pages?.length) await markPagesChecked(siteId, 'internal-linking', batch);

  const reachable = fetched
    .filter((r) => r.result.ok)
    .map((r) => ({ page: r.page, internalLinkCount: r.result.analysis.internalLinkCount, impressions: impressionsByPage.get(r.page) || 0 }));

  if (reachable.length < MIN_PAGES_FOR_AVERAGE) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: `Only ${reachable.length} page(s) reachable this run — need at least ${MIN_PAGES_FOR_AVERAGE} for this site's own average internal-link count to be a trustworthy baseline.`,
      generatedAt: new Date().toISOString(),
    };
  }

  // Same "relative to this site's own average, never an external benchmark"
  // philosophy already used for CTR (ctr-anomaly.js) — a small marketing
  // site with naturally fewer internal links per page than a large content
  // hub shouldn't be judged against a generic industry number.
  const deadEnds = flagBelowAverage(reachable, 'internalLinkCount', { thresholdPct: 50 });
  // priorityByRank needs its input pre-sorted worst-first; rank by real
  // traffic impact (impressions) rather than by how far below average the
  // link count is, so priority reflects business impact, not just deviation size.
  const rankedByImpressions = [...deadEnds].sort((a, b) => b.impressions - a.impressions);
  const priorities = priorityByRank(rankedByImpressions);
  const findings = rankedByImpressions.map((r, i) => makeFinding({
    id: `internal-linking:dead-end:${r.page}`,
    evidence: { page: r.page, internalLinkCount: r.internalLinkCount, deviationPct: r.internalLinkCountDeviationPct, impressions: r.impressions },
    whyItMatters: `This page links to only ${r.internalLinkCount} other page(s) on the site — ${Math.abs(r.internalLinkCountDeviationPct)}% below this site's own average this run (${r.impressions} impressions). Pages it doesn't link to get less internal link equity from it.`,
    priority: priorities[i],
    recommendedAction: null, // adding internal links is a real edit, not draftable content today
    expectedImpact: { label: impactFromPriority(priorities[i]), basis: 'computed', value: r.impressions },
  }));

  const facts = {
    rangeStart: start, rangeEnd: end,
    batchSize: batch.length,
    pagesChecked: reachable.length,
    avgInternalLinkCount: Math.round((reachable.reduce((s, r) => s + r.internalLinkCount, 0) / reachable.length) * 10) / 10,
    findings,
  };

  const system = 'You are a technical SEO specialist writing for a non-technical site owner. Given real internal ' +
    'link counts across this site\'s own pages (compared only against this site\'s own average, never an external ' +
    'benchmark), write 2-3 sentences naming the highest-traffic page with unusually few outbound internal links and ' +
    'one concrete next step (adding links from it to other real, relevant pages). Use ONLY the data given, never ' +
    'invent a page or number not present in the facts. Plain text, no markdown, no bullets.';
  const narrative = findings.length
    ? await callLLM(system, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 250 })
      .catch((err) => { console.warn('[agents] internal-linking narrative failed:', err.message); return null; })
    : null;

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}

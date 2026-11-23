import { getSiteById, getQueryPageMetrics } from '../store/read.js';
import { fetchSerps, serpConfigured } from '../lib/serp.js';
import { getOrClassifyPageContentType } from './lib/page-content-classifier.js';
import { makeFinding, impactFromPriority } from './lib/findings.js';
import { findStrikingPairs, serpConsensus, ourPageKind, judgeMismatch } from './lib/sxo.js';

export const meta = {
  id: 'seo-sxo',
  name: 'Search Experience Check',
  description: 'For pages stuck at the edge of page one, checks whether the page is the right KIND of page for what Google rewards on that search (an article where Google shows product pages, a sales page where it shows guides).',
  category: 'seo',
  requiresCapabilities: ['gsc', 'public-web'],
  version: 1,
};

// Method after claude-seo's seo-sxo skill (MIT, (c) 2026 agricidaniel; skill by Florian Schmitz); see agents/lib/sxo.js for the rules and
// for what is simplified. Weekly (job.js WEEKLY_ONLY_AGENT_IDS): each page needs one SERP lookup (cached for two weeks, budgeted, and
// capped here), and a page's type does not change day to day.
export const MAX_PAGES = 5;
const WINDOW_DAYS = 28;
const TYPE_LABEL = { tool: 'tools and calculators', comparison: 'comparison pages', product: 'product and shop pages', service: 'service pages', article: 'articles and guides' };
const OURS_LABEL = { article: 'an article', service: 'a service or sales page', product: 'a product page' };
const pathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
const shift = (ymd, days) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

export async function run({ siteId, start, end, params, deps = {} }) {
  const d = { getSiteById, getQueryPageMetrics, fetchSerps, serpConfigured, classify: getOrClassifyPageContentType, ...deps };
  if (!d.serpConfigured()) {
    return { meta, status: 'insufficient-data', facts: null, narrative: null, message: 'Needs a search-results data source (DataForSEO or SerpApi) to see what Google shows for each search.', generatedAt: new Date().toISOString() };
  }
  const site = await d.getSiteById(siteId);
  const from = shift(end, -(WINDOW_DAYS - 1));
  let rows = await d.getQueryPageMetrics(siteId, from, end, { minImpressions: 50 });
  if (params?.pages?.length) { const want = new Set(params.pages); rows = rows.filter((r) => want.has(r.page)); }
  const pairs = findStrikingPairs(rows, { max: MAX_PAGES });
  if (!pairs.length) {
    return { meta, status: 'insufficient-data', facts: null, narrative: null, message: 'No page ranks between positions 8 and 20 for a search with enough impressions yet.', generatedAt: new Date().toISOString() };
  }

  const { byKeyword, stoppedEarly } = await d.fetchSerps(siteId, pairs.map((p) => p.query), { site, job: 'seo-sxo' });
  const findings = []; const checkedPages = []; const skipped = [];
  for (const p of pairs) {
    const serp = byKeyword.get(p.query);
    if (!serp?.ok) { skipped.push({ page: p.page, reason: serp?.reason || 'no_serp' }); continue; }
    const cls = await d.classify(siteId, p.page);
    const ours = ourPageKind(cls?.contentType);
    if (!ours) { skipped.push({ page: p.page, reason: 'page_type_unknown' }); continue; }
    checkedPages.push(p.page);
    const consensus = serpConsensus(serp.results);
    const verdict = judgeMismatch(ours, consensus);
    if (!verdict) continue;

    const n = consensus.counts[consensus.dominant];
    findings.push(makeFinding({
      id: `seo-sxo:page:${p.page}`,
      evidence: {
        page: p.page, query: p.query, position: Math.round(p.avgPosition * 10) / 10, impressions: p.impressions,
        serpDominant: consensus.dominant, serpShare: consensus.share, ourType: ours, ourContentType: cls.contentType, topResults: consensus.examples,
      },
      whyItMatters: `"${p.query}" brings ${p.impressions} impressions to ${pathOf(p.page)} at position ${p.avgPosition.toFixed(1)}, but Google mostly shows ${TYPE_LABEL[consensus.dominant]} for that search (${n} of ${consensus.typedCount} results), and this page is ${OURS_LABEL[ours]}. ${verdict.advice}`,
      priority: verdict.severity,
      recommendedAction: null,
      reportOnly: {
        kind: 'sxo-mismatch',
        label: 'Page type does not match the search',
        page: p.page,
        whyBlocked: 'Changing what kind of page this is is an editorial decision, not an automatic fix. The kinds of result are read from the results page\'s titles and addresses, so treat this as a strong hint and look at the results page yourself before changing the page.',
      },
      expectedImpact: { label: impactFromPriority(verdict.severity), basis: 'computed', value: p.impressions },
    }));
  }

  return {
    meta, status: 'ok',
    facts: { rangeStart: from, rangeEnd: end, pagesConsidered: pairs.length, pagesChecked: checkedPages.length, skipped, stoppedEarly, checkedPages, findings },
    narrative: findings.length ? `${findings.length} page${findings.length === 1 ? ' is' : 's are'} stuck near page one partly because the kind of page does not match what Google shows for the search.` : null,
    generatedAt: new Date().toISOString(),
  };
}

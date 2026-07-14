import { getSiteById } from '../store/read.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { effortForGenerator, inferSchemaType } from './lib/page-content.js';
import { runPageChecks, detectDuplicateTitles, crawlInternalLinks } from './lib/technical-seo-analysis.js';
import { upsertTechnicalSeoCheck, getCheckedAtForPages as getTechnicalSeoCheckedAt } from '../store/technical-seo-checks.js';
import { selectCandidatePages } from './lib/candidate-pages.js';
import { listOrphanedPages } from '../store/page-inventory.js';
import { recordIntegrationCheck } from '../store/upsert.js';
import { listSitemaps } from '../ingest/gsc-technical.js';
import { configured as pagespeedConfigured } from '../ingest/pagespeed.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'technical-seo',
  name: 'Technical SEO Agent',
  description: 'Checks real Google index status, Core Web Vitals, technical page health, and broken links/redirects — whether Google can actually see and serve your pages well.',
  category: 'seo',
  version: 1,
  dataSources: [
    { id: 'gsc-url-inspection', status: 'connected', description: 'Real per-page index status and sitemap health via Google Search Console\'s URL Inspection + Sitemaps APIs — already covered by the existing Search Console connection.' },
    { id: 'pagespeed-insights', status: pagespeedConfigured() ? 'connected' : 'not-connected', description: 'Real Core Web Vitals (LCP/INP/CLS) via Google PageSpeed Insights. Without this configured, every other check below still runs — Core Web Vitals findings just don\'t appear.' },
  ],
};

const BATCH_SIZE = 20; // pages actually checked this run — drawn from a much larger merged GSC + site-wide-inventory pool, see candidate-pages.js

function sumImpressions(pages) {
  return pages.reduce((s, p) => s + (p.impressions || 0), 0);
}

export async function run({ siteId, start, end, pageCache }) {
  const site = await getSiteById(siteId);
  // Merges real GSC top pages with the site-wide page inventory (sitemap +
  // crawl) — a page with zero search traffic (often exactly the pages worth
  // checking: is it deindexed, slow, broken?) now gets rotated in too, not
  // just whatever already has GSC traffic. Rotation source stays
  // technical_seo_checks (migration 026, this agent's own table) via the
  // injected adapter below — one rotation ledger per agent, not a second
  // competing one in agent_page_rotation.
  const { batch, impressionsByPage } = await selectCandidatePages(siteId, 'technical-seo', {
    start, end, batchSize: BATCH_SIZE,
    getCheckedAtForPages: (sId, _agentId, pages) => getTechnicalSeoCheckedAt(sId, pages),
  });

  if (!batch.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      requiredDataSources: meta.dataSources,
      message: 'No page performance data yet to select pages from.',
      generatedAt: new Date().toISOString(),
    };
  }

  const checked = await runPageChecks(site, batch, pageCache);
  const pageResults = checked.map((r) => ({ ...r, impressions: impressionsByPage.get(r.page) || 0 }));

  // Persist each checked page's snapshot — drives next run's rotation
  // (checked_at) and (for duplicate-title detection) accumulates real
  // titles site-wide over time, not just this run's batch.
  await Promise.all(pageResults.map((r) => upsertTechnicalSeoCheck(siteId, r.page, {
    indexStatus: r.indexStatus, coreWebVitals: r.coreWebVitals, technicalAudit: r.technicalAudit,
    brokenLinks: null, // filled in below once the crawl results are known
    lastImpressions: r.impressions,
  }).catch((err) => console.error(`[agents] technical-seo: failed to persist check for ${r.page}:`, err.message))));

  const crawl = await crawlInternalLinks(pageResults);
  // Re-upsert with the per-page broken-link slice now that the crawl is done.
  await Promise.all(pageResults.map((r) => {
    const broken = crawl.broken.filter((b) => b.sourcePages.includes(r.page));
    const redirectChains = crawl.redirectChains.filter((c) => c.sourcePages.includes(r.page));
    if (!broken.length && !redirectChains.length) return null;
    return upsertTechnicalSeoCheck(siteId, r.page, {
      indexStatus: r.indexStatus, coreWebVitals: r.coreWebVitals, technicalAudit: r.technicalAudit,
      brokenLinks: { ok: true, broken, redirectChains }, lastImpressions: r.impressions,
    }).catch((err) => console.error(`[agents] technical-seo: failed to persist link results for ${r.page}:`, err.message));
  }));

  const duplicateGroups = await detectDuplicateTitles(siteId, pageResults.map((r) => ({ page: r.page, technicalAudit: r.technicalAudit, impressions: r.impressions })));

  // GSC quota visibility — a rotating-quota problem should be visible on
  // Integration Health, not silently degrade every page's indexStatus to an
  // error nobody notices. Recorded shared (site_id: null), same convention
  // every other integration in this codebase uses — routes/integrations.js's
  // on-demand "Test connection" route always records with site_id: null
  // regardless of which site's admin triggered it, so a per-site row here
  // would silently split into two never-reconciled states depending on
  // which path last wrote to it.
  const quotaExceeded = pageResults.some((r) => r.indexStatus.quotaExceeded);
  await recordIntegrationCheck('gsc-url-inspection', null, {
    ok: !quotaExceeded,
    authStatus: quotaExceeded ? 'quota_exceeded' : 'ok',
    errorMessage: quotaExceeded ? 'GSC URL Inspection quota exceeded this run — some pages were not checked.' : null,
    recoveryAction: quotaExceeded ? 'Reduce rotation batch size or wait for the shared quota to reset, then re-run.' : null,
  }).catch(() => {});

  const sitemapResult = await listSitemaps(site);

  // --- Findings ---

  const deindexedCandidates = pageResults
    .filter((r) => r.indexStatus.ok && (r.indexStatus.verdict === 'FAIL' || r.indexStatus.verdict === 'PARTIAL'))
    .sort((a, b) => b.impressions - a.impressions);
  const deindexedPriorities = priorityByRank(deindexedCandidates);
  const deindexedFindings = deindexedCandidates.map((r, i) => makeFinding({
    id: `technical-seo:index:${r.page}`,
    evidence: { page: r.page, verdict: r.indexStatus.verdict, coverageState: r.indexStatus.coverageState, indexingState: r.indexStatus.indexingState, impressions: r.impressions },
    whyItMatters: `Google's own index inspection reports "${r.indexStatus.coverageState}" for this page (verdict: ${r.indexStatus.verdict}, ${r.impressions} impressions).`,
    priority: deindexedPriorities[i],
    recommendedAction: null,
    expectedImpact: { label: impactFromPriority(deindexedPriorities[i]), basis: 'computed', value: r.impressions },
  }));

  // Compound sort: CWV tier first (a failing high-traffic page must always
  // outrank a passing one), impressions second — never a naive
  // impressions-only rank, which would let a POOR low-traffic page beat a
  // NEEDS_IMPROVEMENT high-traffic one inconsistently with "worse is worse."
  const cwvCandidates = pageResults
    .filter((r) => r.coreWebVitals.ok && (r.coreWebVitals.category === 'POOR' || r.coreWebVitals.category === 'NEEDS_IMPROVEMENT'))
    .sort((a, b) => {
      const tier = (r) => (r.coreWebVitals.category === 'POOR' ? 1 : 0);
      return tier(b) - tier(a) || b.impressions - a.impressions;
    });
  const cwvPriorities = priorityByRank(cwvCandidates);
  const cwvFindings = cwvCandidates.map((r, i) => makeFinding({
    id: `technical-seo:cwv:${r.page}`,
    evidence: { page: r.page, lcp: r.coreWebVitals.lcp, inp: r.coreWebVitals.inp, cls: r.coreWebVitals.cls, category: r.coreWebVitals.category, dataSource: r.coreWebVitals.dataSource, impressions: r.impressions },
    whyItMatters: `Core Web Vitals are ${r.coreWebVitals.category} for this page (${r.coreWebVitals.dataSource} data, ${r.impressions} impressions).`,
    priority: cwvPriorities[i],
    recommendedAction: null,
    expectedImpact: { label: impactFromPriority(cwvPriorities[i]), basis: 'computed', value: r.impressions },
  }));

  const rankedDupes = [...duplicateGroups].sort((a, b) => sumImpressions(b.pages) - sumImpressions(a.pages));
  const dupePriorities = priorityByRank(rankedDupes);
  const duplicateFindings = rankedDupes.map((g, i) => {
    const target = [...g.pages].sort((a, b) => a.impressions - b.impressions)[0];
    return makeFinding({
      id: `technical-seo:duplicate-title:${target.page}`,
      evidence: { title: g.title, pages: g.pages.map((p) => p.page) },
      whyItMatters: `"${g.title}" is used as the title on ${g.pages.length} different pages — search engines can't tell them apart.`,
      priority: dupePriorities[i],
      recommendedAction: { label: 'Improve title', generatorId: 'meta-title', params: { page: target.page }, effort: effortForGenerator('meta-title') },
      expectedImpact: { label: impactFromPriority(dupePriorities[i]), basis: 'computed', value: sumImpressions(g.pages) },
    });
  });

  const canonicalCandidates = pageResults
    .filter((r) => r.technicalAudit.ok && (
      !r.technicalAudit.hasCanonical
      || (r.indexStatus.ok && r.indexStatus.googleCanonical && r.indexStatus.userCanonical && r.indexStatus.googleCanonical !== r.indexStatus.userCanonical)
    ))
    .sort((a, b) => b.impressions - a.impressions);
  const canonicalPriorities = priorityByRank(canonicalCandidates);
  const canonicalFindings = canonicalCandidates.map((r, i) => makeFinding({
    id: `technical-seo:canonical:${r.page}`,
    evidence: { page: r.page, hasCanonical: r.technicalAudit.hasCanonical, googleCanonical: r.indexStatus.googleCanonical ?? null, userCanonical: r.indexStatus.userCanonical ?? null, impressions: r.impressions },
    whyItMatters: r.technicalAudit.hasCanonical
      ? `Google's chosen canonical ("${r.indexStatus.googleCanonical}") disagrees with this page's own declared canonical ("${r.indexStatus.userCanonical}").`
      : 'No canonical tag found on this page.',
    priority: canonicalPriorities[i],
    recommendedAction: null,
    expectedImpact: { label: impactFromPriority(canonicalPriorities[i]), basis: 'computed', value: r.impressions },
  }));

  const schemaCandidates = pageResults.filter((r) => r.technicalAudit.ok && !r.technicalAudit.hasSchema).sort((a, b) => b.impressions - a.impressions);
  const schemaPriorities = priorityByRank(schemaCandidates);
  const schemaFindings = schemaCandidates.map((r, i) => makeFinding({
    id: `technical-seo:schema:${r.page}`,
    evidence: { page: r.page, impressions: r.impressions },
    whyItMatters: `No structured data (JSON-LD) found on this page (${r.impressions} impressions).`,
    priority: schemaPriorities[i],
    recommendedAction: { label: 'Add schema', generatorId: 'schema', params: { page: r.page, schemaType: inferSchemaType(r.page, []) }, effort: effortForGenerator('schema') },
    expectedImpact: { label: impactFromPriority(schemaPriorities[i]), basis: 'computed', value: r.impressions },
  }));

  const sourceImpressions = (sourcePages) => Math.max(0, ...sourcePages.map((p) => impressionsByPage.get(p) || 0));

  const brokenCandidates = [...crawl.broken].sort((a, b) => sourceImpressions(b.sourcePages) - sourceImpressions(a.sourcePages));
  const brokenPriorities = priorityByRank(brokenCandidates);
  const brokenFindings = brokenCandidates.map((c, i) => makeFinding({
    id: `technical-seo:broken-link:${c.sourcePages[0]}:${c.href}`,
    evidence: { sourcePages: c.sourcePages, href: c.href, status: c.finalStatus, error: c.error },
    whyItMatters: c.error
      ? `A link to ${c.href} (found on ${c.sourcePages.length} page(s)) failed: ${c.error}.`
      : `A link to ${c.href} (found on ${c.sourcePages.length} page(s)) returns HTTP ${c.finalStatus}.`,
    priority: brokenPriorities[i],
    recommendedAction: null,
    expectedImpact: { label: impactFromPriority(brokenPriorities[i]), basis: 'computed', value: sourceImpressions(c.sourcePages) },
  }));

  const chainCandidates = [...crawl.redirectChains].sort((a, b) => sourceImpressions(b.sourcePages) - sourceImpressions(a.sourcePages) || b.hops - a.hops);
  const chainPriorities = priorityByRank(chainCandidates);
  const chainFindings = chainCandidates.map((c, i) => makeFinding({
    id: `technical-seo:redirect-chain:${c.sourcePages[0]}:${c.href}`,
    evidence: { sourcePages: c.sourcePages, href: c.href, hops: c.hops, finalStatus: c.finalStatus },
    whyItMatters: `A link to ${c.href} redirects ${c.hops} times before reaching ${c.finalStatus ?? 'an unknown status'} — wastes crawl budget and load time.`,
    priority: chainPriorities[i],
    recommendedAction: null,
    expectedImpact: { label: impactFromPriority(chainPriorities[i]), basis: 'computed', value: sourceImpressions(c.sourcePages) },
  }));

  // Site-wide, not limited to this run's rotation batch — real orphaned
  // pages (in the sitemap but never reached by the real homepage-outward
  // crawl) are recomputed weekly in job.js's runSiteDiscoveryIfDue from that
  // run's own two real fetched lists, so this is a pure read, no new fetch.
  const orphanedPages = await listOrphanedPages(siteId);
  const orphanedPriorities = priorityByRank(orphanedPages);
  const orphanedFindings = orphanedPages.map((p, i) => makeFinding({
    id: `technical-seo:orphaned:${p.page}`,
    evidence: { page: p.page, knownSince: p.first_seen_at },
    whyItMatters: `${p.page} is listed in the sitemap but no internal link on the site actually points to it — search engines and users can only reach it directly.`,
    priority: orphanedPriorities[i],
    recommendedAction: null,
    expectedImpact: { label: impactFromPriority(orphanedPriorities[i]), basis: 'estimate', value: null },
  }));

  const sitemapErrorCandidates = (sitemapResult.ok ? sitemapResult.sitemaps : []).filter((s) => s.errors > 0).sort((a, b) => b.errors - a.errors);
  const sitemapPriorities = priorityByRank(sitemapErrorCandidates);
  const sitemapFindings = sitemapErrorCandidates.map((s, i) => makeFinding({
    id: `technical-seo:sitemap:${s.path}`,
    evidence: { sitemapPath: s.path, errors: s.errors, warnings: s.warnings, lastSubmitted: s.lastSubmitted },
    whyItMatters: `Sitemap "${s.path}" has ${s.errors} error(s) reported by Google.`,
    priority: sitemapPriorities[i],
    recommendedAction: null,
    expectedImpact: { label: impactFromPriority(sitemapPriorities[i]), basis: 'computed', value: s.errors },
  }));

  const findings = [
    ...deindexedFindings, ...cwvFindings, ...duplicateFindings, ...canonicalFindings,
    ...schemaFindings, ...brokenFindings, ...chainFindings, ...sitemapFindings, ...orphanedFindings,
  ];

  const facts = {
    rangeStart: start, rangeEnd: end,
    batchSize: batch.length,
    pagesChecked: pageResults.map((r) => ({
      page: r.page, impressions: r.impressions,
      verdict: r.indexStatus.ok ? r.indexStatus.verdict : null,
      cwvCategory: r.coreWebVitals.ok ? r.coreWebVitals.category : null,
    })),
    sitemaps: sitemapResult.ok ? sitemapResult.sitemaps : [],
    sitemapsError: sitemapResult.ok ? null : sitemapResult.error,
    linkCrawl: { checked: crawl.checked, brokenCount: crawl.broken.length, redirectChainCount: crawl.redirectChains.length },
    orphanedPageCount: orphanedPages.length,
    findings,
  };

  const system = 'You are a technical SEO specialist writing for a non-technical site owner. Given real Google ' +
    'index-inspection results, Core Web Vitals (when available), a technical page audit, broken links, and ' +
    'sitemap health, write 3-4 sentences naming the single most damaging real issue this run and one concrete next ' +
    'step. Use ONLY the data given, never invent a number or page not present in the facts. Plain text, no ' +
    'markdown, no bullets.';
  const narrative = await callLLM(system, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 350 })
    .catch((err) => { console.warn('[agents] technical-seo narrative failed:', err.message); return null; });

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}

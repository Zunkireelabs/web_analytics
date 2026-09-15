import { getSiteById, getSearchPerformanceForPages, getQueriesForPage } from '../store/read.js';
import { priorityByRank, impactFromPriority, makeFinding, aggregateSystemicFinding } from './lib/findings.js';
import { effortForGenerator, inferSchemaType, fetchTextIfExists, checkHttpsStatus, MAX_INLINE_STYLE_COUNT, MAX_HTML_SIZE_BYTES } from './lib/page-content.js';
import { runPageChecks, detectDuplicateTitles, crawlInternalLinks, crawlExternalCitations } from './lib/technical-seo-analysis.js';
import { upsertTechnicalSeoCheck, getCheckedAtForPages as getTechnicalSeoCheckedAt } from '../store/technical-seo-checks.js';
import { selectCandidatePages } from './lib/candidate-pages.js';
import { listOrphanedPages } from '../store/page-inventory.js';
import { decideDeadLinkAction } from './lib/dead-link-intent.js';
import { recordIntegrationCheck } from '../store/upsert.js';
import { listSitemaps } from '../ingest/gsc-technical.js';
import { discoverFromSitemaps, parseRobotsDisallowRules, originForSite } from './lib/site-discovery.js';
import { hostnameOf } from './lib/site-domain.js';
import { configured as pagespeedConfigured } from '../ingest/pagespeed.js';
import { callLLM } from '../llm.js';
import { getGscBreakdownRange } from '../store/read.js';
import { detectSpamUrlPatterns, detectForeignScriptQueries } from './lib/index-bloat.js';

export const meta = {
  id: 'technical-seo',
  name: 'Technical SEO Agent',
  description: 'Checks real Google index status, Core Web Vitals, technical page health, and broken links/redirects — whether Google can actually see and serve your pages well.',
  category: 'seo',
  version: 6,
  // v6 adds two real, previously-uncovered checks: a missing robots.txt
  // (now draftable via the new robots-bootstrap generator, unlike
  // robots-fix.js which needs an existing file to splice into) and legacy
  // index spam — real GSC pages/queries pattern-matched against a set of
  // off-platform signatures (foreign-platform file extensions, spam-farm
  // numeric query params, a query script inconsistent with the site's own
  // declared language) that almost certainly belong to a prior owner of the
  // domain, not this site. Found by hand on chayceproperties.com (1.5M+
  // indexed URLs from a legacy ASP.NET storefront this Eleventy site never
  // had) — see server/agents/lib/index-bloat.js.
  // v5 adds two more page-weight checks off the same per-page fetch already
  // done for the technical audit: excessive inline style="" attributes and
  // raw HTML document size over 100KB. Both informational — same reasoning
  // as v4's compression/HTTPS checks, fixing either is a CSS/template/CMS
  // change, not draftable content.
  // v4 adds two real, previously-uncovered checks confirmed via a
  // cross-check against the sibling audit tool: per-page response
  // compression (Content-Encoding: gzip/br/deflate) and site-level
  // HTTPS/SSL enablement (does the host serve HTTPS at all, and does a
  // plain http:// request actually redirect there). Both informational —
  // recommendedAction stays null, since fixing either is a server/CDN/DNS
  // infra change (enabling gzip, issuing a cert, adding a redirect rule)
  // this tool has no safe way to draft as a PR.
  // v3 splits layout shift (CLS) out of the generic Core Web Vitals buckets
  // into its own `technical-seo:site:layout-shift` finding — a pre-v3 row's
  // findings won't have it.
  // v2 adds two real, previously-uncovered checks: sitemap URLs resolving to
  // a different domain than the site itself (a common sitemap-generation
  // bug GSC's own per-sitemap error/warning counts don't catch), and real
  // GSC top-traffic pages that robots.txt actually disallows — both reuse
  // site-discovery.js's existing sitemap-fetch/robots-parse primitives
  // rather than a second implementation of either.
  dataSources: [
    { id: 'gsc-url-inspection', status: 'connected', description: 'Real per-page index status and sitemap health via Google Search Console\'s URL Inspection + Sitemaps APIs — already covered by the existing Search Console connection.' },
    { id: 'pagespeed-insights', status: pagespeedConfigured() ? 'connected' : 'not-connected', description: 'Real Core Web Vitals (LCP/INP/CLS) via Google PageSpeed Insights. Without this configured, every other check below still runs — Core Web Vitals findings just don\'t appear.' },
  ],
};

const BATCH_SIZE = 20; // pages actually checked this run — drawn from a much larger merged GSC + site-wide-inventory pool, see candidate-pages.js

function sumImpressions(pages) {
  return pages.reduce((s, p) => s + (p.impressions || 0), 0);
}

// Near-always a shared page-template gap (the template never emits JSON-LD at
// all) — one "N of M checked pages" finding, not one card per affected page.
// One affected page carries the single draftable action a sitewide finding
// can still offer.
//
// Exported (rather than inlined in run()) so the abstention below is
// regression-testable without a live site or a DB.
//
// The @type is derived from each candidate's OWN fetched page — its og:type,
// its URL — never guessed. This used to call `inferSchemaType(rep.page, [])`
// against a version of inferSchemaType that ended in `return 'Article'`, so
// any page whose path didn't match one of five hardcoded ENGLISH words (a
// /pricing, /services or /booking page — or on a non-English site, every
// single page) got an "Add schema" action asking for schema.org/Article
// markup. The `schema` generator is SAFE-tier (agents/lib/risk-tiers.js) and
// generators/schema.js only validates field VALUES, never the @type, so that
// wrong type could be drafted, approved and merged into a tenant's live site
// with no human ever reading it.
export function missingSchemaFinding(pageResults) {
  const schemaTypeFor = (r) => inferSchemaType(r.page, r.analysis?.schemaTypes || [], r.analysis);
  return aggregateSystemicFinding({
    id: 'technical-seo:site:missing-schema',
    affected: pageResults.filter((r) => r.technicalAudit?.ok && !r.technicalAudit.hasSchema),
    checkedCount: pageResults.filter((r) => r.technicalAudit?.ok).length,
    getPage: (r) => r.page,
    getImpressions: (r) => r.impressions,
    whyItMatters: (n, c) => `${n} of ${c} checked pages have no structured data (JSON-LD).`,
    // A systemic finding only ever carries ONE draftable example, so pick the
    // highest-impression page whose type is actually derivable rather than
    // letting the default (highest-impression page overall) drop the action
    // for every affected page just because that one page happens to be
    // untypeable.
    pickRepresentative: (affected) => [...affected]
      .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))
      .find((r) => schemaTypeFor(r)) || null,
    // Null means "no page in this batch gave us honest evidence of its type"
    // — the finding still reports the real, verified missing-schema gap, it
    // just offers no action, exactly like the canonical-mismatch finding.
    recommendedAction: (rep) => {
      const schemaType = schemaTypeFor(rep);
      if (!schemaType) return null;
      return { label: 'Add schema', generatorId: 'schema', params: { page: rep.page, schemaType }, effort: effortForGenerator('schema') };
    },
  });
}

export async function run({ siteId, start, end, pageCache, params }) {
  const site = await getSiteById(siteId);
  // params.pages (from the bulk full-site-audit engine, agents/lib/bulk-audit.js)
  // bypasses the normal rotation entirely and checks exactly the given pages
  // — a full audit wants exhaustive coverage of a caller-chosen set, not this
  // agent's own ~20-page rotation pick. Real impressions still come from GSC
  // for the given pages, not guessed. Same params-bypass pattern as
  // content-gap.js's params.page pilot, just pluralized for the bulk case.
  const { batch, impressionsByPage } = params?.pages?.length
    ? await getSearchPerformanceForPages(siteId, start, end, params.pages).then((rows) => ({
      batch: params.pages,
      impressionsByPage: new Map(rows.map((r) => [r.dim_value, Number(r.impressions)])),
    }))
    // Merges real GSC top pages with the site-wide page inventory (sitemap +
    // crawl) — a page with zero search traffic (often exactly the pages worth
    // checking: is it deindexed, slow, broken?) now gets rotated in too, not
    // just whatever already has GSC traffic. Rotation source stays
    // technical_seo_checks (migration 026, this agent's own table) via the
    // injected adapter below — one rotation ledger per agent, not a second
    // competing one in agent_page_rotation.
    : await selectCandidatePages(siteId, 'technical-seo', {
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
    wordCount: r.analysis?.wordCount ?? null,
    metaDescription: r.analysis?.metaDescription || null,
    internalLinkCount: r.analysis?.internalLinks?.length ?? null,
  }).catch((err) => console.error(`[agents] technical-seo: failed to persist check for ${r.page}:`, err.message))));

  const crawl = await crawlInternalLinks(pageResults);
  const citationCrawl = await crawlExternalCitations(pageResults);
  // Re-upsert with the per-page broken-link slice now that the crawl is done.
  await Promise.all(pageResults.map((r) => {
    const broken = crawl.broken.filter((b) => b.sourcePages.includes(r.page));
    const redirectChains = crawl.redirectChains.filter((c) => c.sourcePages.includes(r.page));
    if (!broken.length && !redirectChains.length) return null;
    return upsertTechnicalSeoCheck(siteId, r.page, {
      indexStatus: r.indexStatus, coreWebVitals: r.coreWebVitals, technicalAudit: r.technicalAudit,
      brokenLinks: { ok: true, broken, redirectChains }, lastImpressions: r.impressions,
      wordCount: r.analysis?.wordCount ?? null,
      metaDescription: r.analysis?.metaDescription || null,
      internalLinkCount: r.analysis?.internalLinks?.length ?? null,
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
  // Real sitemap URL content (not just GSC's error/warning counts, already
  // captured above) and real robots.txt rules — both reuse site-discovery.js's
  // existing crawl-politeness primitives rather than a second sitemap/robots
  // fetcher, just applied here as validation checks instead of crawl input.
  const origin = originForSite(site);
  const siteHostname = origin ? new URL(origin).hostname : null;
  const [sitemapUrls, robotsFetch, httpsStatus] = await Promise.all([
    discoverFromSitemaps(site).catch((err) => { console.error('[agents] technical-seo: sitemap fetch failed:', err.message); return []; }),
    origin ? fetchTextIfExists(`${origin}/robots.txt`) : Promise.resolve({ ok: false }),
    checkHttpsStatus(siteHostname).catch((err) => { console.error('[agents] technical-seo: https check failed:', err.message); return { httpsEnabled: null, httpRedirectsToHttps: null }; }),
  ]);
  const robots = parseRobotsDisallowRules(robotsFetch.ok ? robotsFetch.text : '');

  // --- Findings ---

  // A Google-reported coverage problem is usually a real, page-specific
  // fact (each page has its own index history) — but it can also cluster
  // sitewide (a bad redirect rule, a rogue noindex applied by the CMS
  // template), so this is reported as one "N of M checked pages" aggregate
  // rather than one card per affected page.
  const indexCheckedCount = pageResults.filter((r) => r.indexStatus.ok).length;
  const deindexedCandidates = pageResults
    .filter((r) => r.indexStatus.ok && (r.indexStatus.verdict === 'FAIL' || r.indexStatus.verdict === 'PARTIAL'));
  const deindexedFinding = aggregateSystemicFinding({
    id: 'technical-seo:site:deindexed',
    affected: deindexedCandidates,
    checkedCount: indexCheckedCount,
    getPage: (r) => r.page,
    getImpressions: (r) => r.impressions,
    extraEvidence: (affected) => ({ verdicts: affected.map((r) => ({ page: r.page, verdict: r.indexStatus.verdict, coverageState: r.indexStatus.coverageState })) }),
    whyItMatters: (n, c) => `Google's own index inspection reports a coverage problem (FAIL or PARTIAL) for ${n} of ${c} checked pages.`,
    recommendedAction: null,
  });
  const deindexedFindings = deindexedFinding ? [deindexedFinding] : [];

  // POOR and NEEDS_IMPROVEMENT are materially different severities, kept as
  // two separate aggregates rather than merged into one bucket — CWV is
  // often driven by one shared render-blocking asset/script, so each tier
  // is one "N of M checked pages" finding, not one card per affected page.
  const cwvCheckedCount = pageResults.filter((r) => r.coreWebVitals.ok).length;
  const cwvPoorCandidates = pageResults.filter((r) => r.coreWebVitals.ok && r.coreWebVitals.category === 'POOR');
  const cwvNeedsImprovementCandidates = pageResults.filter((r) => r.coreWebVitals.ok && r.coreWebVitals.category === 'NEEDS_IMPROVEMENT');
  const cwvFindings = [
    aggregateSystemicFinding({
      id: 'technical-seo:site:cwv-poor',
      affected: cwvPoorCandidates,
      checkedCount: cwvCheckedCount,
      getPage: (r) => r.page,
      getImpressions: (r) => r.impressions,
      whyItMatters: (n, c) => `Core Web Vitals are POOR on ${n} of ${c} checked pages.`,
      recommendedAction: null,
    }),
    aggregateSystemicFinding({
      id: 'technical-seo:site:cwv-needs-improvement',
      affected: cwvNeedsImprovementCandidates,
      checkedCount: cwvCheckedCount,
      getPage: (r) => r.page,
      getImpressions: (r) => r.impressions,
      whyItMatters: (n, c) => `Core Web Vitals need improvement on ${n} of ${c} checked pages.`,
      recommendedAction: null,
    }),
  ].filter(Boolean);

  // Layout shift specifically, surfaced as its own finding rather than left
  // folded into the generic CWV buckets above — the real CLS number is
  // already fetched (server/ingest/pagespeed.js), this just gives it its own
  // voice. 0.1 matches Google's own "NEEDS_IMPROVEMENT" CLS threshold (see
  // pagespeed.js's categoryFor), same line the audit tool's own layout-
  // stability check uses. Matters for more than human UX: a shifting layout
  // can cause an AI browsing agent to click the wrong element mid-interaction,
  // the same way it disrupts a human.
  const layoutShiftCandidates = pageResults.filter((r) => r.coreWebVitals.ok && r.coreWebVitals.cls != null && r.coreWebVitals.cls > 0.1);
  const layoutShiftFinding = aggregateSystemicFinding({
    id: 'technical-seo:site:layout-shift',
    affected: layoutShiftCandidates,
    checkedCount: cwvCheckedCount,
    getPage: (r) => r.page,
    getImpressions: (r) => r.impressions,
    extraEvidence: (affected) => ({ clsValues: affected.map((r) => ({ page: r.page, cls: r.coreWebVitals.cls })) }),
    whyItMatters: (n, c) => `${n} of ${c} checked pages have unstable layout (Cumulative Layout Shift above 0.1) — this can cause a human, or an AI browsing agent, to interact with the wrong element as content shifts underneath them.`,
    recommendedAction: null,
  });
  if (layoutShiftFinding) cwvFindings.push(layoutShiftFinding);

  // Response compression (Content-Encoding: gzip/br/deflate) — a real,
  // previously-uncovered check confirmed via a cross-check against the
  // sibling audit tool. Uncompressed responses are usually one shared
  // server/CDN config gap, not a per-page authoring choice, so this is one
  // "N of M checked pages" finding like the CWV/canonical/schema checks
  // above, not a card per page.
  const compressionCheckedCount = pageResults.filter((r) => r.compression.ok).length;
  const uncompressedCandidates = pageResults.filter((r) => r.compression.ok && !r.compression.compressed);
  const compressionFinding = aggregateSystemicFinding({
    id: 'technical-seo:site:uncompressed',
    affected: uncompressedCandidates,
    checkedCount: compressionCheckedCount,
    getPage: (r) => r.page,
    getImpressions: (r) => r.impressions,
    whyItMatters: (n, c) => `${n} of ${c} checked pages are served without gzip/Brotli compression — enabling it reduces transfer size and improves load time at no content cost.`,
    recommendedAction: null, // a server/CDN config change, not draftable content — same reasoning as security-headers.js's per-header findings
  });
  const compressionFindings = compressionFinding ? [compressionFinding] : [];

  // Inline style="" bloat and raw HTML document size — both real page-weight
  // signals off the same fetch already done for the technical audit above
  // (analyzePage, see page-content.js), never a second fetch. Same
  // "systemic, not per-page-authoring-choice" framing and null
  // recommendedAction as compression above: fixing either means touching the
  // site's own CSS/template/CMS, not something a content generator can
  // honestly draft.
  const analyzedCheckedCount = pageResults.filter((r) => r.analysis).length;
  const inlineStyleCandidates = pageResults.filter((r) => r.analysis && r.analysis.inlineStyleCount > MAX_INLINE_STYLE_COUNT);
  const inlineStylesFinding = aggregateSystemicFinding({
    id: 'technical-seo:site:inline-styles',
    affected: inlineStyleCandidates,
    checkedCount: analyzedCheckedCount,
    getPage: (r) => r.page,
    getImpressions: (r) => r.impressions,
    extraEvidence: (affected) => ({ inlineStyleCounts: affected.map((r) => ({ page: r.page, count: r.analysis.inlineStyleCount })) }),
    whyItMatters: (n, c) => `${n} of ${c} checked pages have over ${MAX_INLINE_STYLE_COUNT} inline style="" attributes — this bloats the HTML and blocks reusing shared CSS, making the page slower to parse and harder to maintain.`,
    recommendedAction: null,
  });
  const inlineStylesFindings = inlineStylesFinding ? [inlineStylesFinding] : [];

  const largeHtmlCandidates = pageResults.filter((r) => r.analysis && r.analysis.htmlByteSize > MAX_HTML_SIZE_BYTES);
  const largeHtmlFinding = aggregateSystemicFinding({
    id: 'technical-seo:site:large-html',
    affected: largeHtmlCandidates,
    checkedCount: analyzedCheckedCount,
    getPage: (r) => r.page,
    getImpressions: (r) => r.impressions,
    extraEvidence: (affected) => ({ htmlSizesKb: affected.map((r) => ({ page: r.page, sizeKb: Math.round(r.analysis.htmlByteSize / 1024) })) }),
    whyItMatters: (n, c) => `${n} of ${c} checked pages serve an HTML document over ${Math.round(MAX_HTML_SIZE_BYTES / 1024)}KB — heavier documents take longer to download and parse before anything on the page can render.`,
    recommendedAction: null,
  });
  const largeHtmlFindings = largeHtmlFinding ? [largeHtmlFinding] : [];

  // Site-level SSL/HTTPS enablement — checked once per run against the
  // site's own hostname, not per-page (a certificate/redirect rule is a
  // host-level fact, not something that varies page to page).
  const httpsFindings = [];
  if (httpsStatus.httpsEnabled === false) {
    httpsFindings.push(makeFinding({
      id: 'technical-seo:site:no-https',
      evidence: { hostname: siteHostname },
      whyItMatters: `${siteHostname} does not serve content over HTTPS — this is both a real ranking factor and a browser-level trust warning shown to every visitor.`,
      priority: 'high',
      recommendedAction: null, // issuing/renewing a TLS certificate is an infra change this tool can't safely automate
      expectedImpact: { label: 'High', basis: 'estimate', value: null },
    }));
  } else if (httpsStatus.httpsEnabled === true && httpsStatus.httpRedirectsToHttps === false) {
    httpsFindings.push(makeFinding({
      id: 'technical-seo:site:http-not-redirecting',
      evidence: { hostname: siteHostname },
      whyItMatters: `${siteHostname} serves HTTPS, but a plain http:// request does not redirect there — visitors and links using the http:// version never reach the secure site.`,
      priority: 'medium',
      recommendedAction: null, // a server-level redirect rule, not draftable content
      expectedImpact: { label: 'Medium', basis: 'estimate', value: null },
    }));
  }

  const rankedDupes = [...duplicateGroups].sort((a, b) => sumImpressions(b.pages) - sumImpressions(a.pages));
  const dupePriorities = priorityByRank(rankedDupes);
  const dupeTargets = rankedDupes.map((g) => [...g.pages].sort((a, b) => a.impressions - b.impressions)[0]);
  // Real per-page top query, same primitive content-gap.js/opportunity.js
  // already ground their own meta-title findings with — without this, the
  // meta-title generator's own required `query` param was left entirely to
  // recommendations.js's downstream fallback lookup, which silently drops
  // the finding if that lookup also comes up empty (more likely here since
  // `target` is deliberately the lowest-impression page in the group).
  const dupeQueryRows = await Promise.all(dupeTargets.map((t) => getQueriesForPage(siteId, start, end, t.page, 1)));
  const dupeQueryByPage = new Map(dupeTargets.map((t, i) => [t.page, dupeQueryRows[i][0]?.query || '']));
  const duplicateFindings = rankedDupes.map((g, i) => {
    const target = dupeTargets[i];
    return makeFinding({
      id: `technical-seo:duplicate-title:${target.page}`,
      evidence: { title: g.title, pages: g.pages.map((p) => p.page) },
      whyItMatters: `"${g.title}" is used as the title on ${g.pages.length} different pages — search engines can't tell them apart.`,
      priority: dupePriorities[i],
      recommendedAction: { label: 'Improve title', generatorId: 'meta-title', params: { page: target.page, query: dupeQueryByPage.get(target.page) || '' }, effort: effortForGenerator('meta-title') },
      expectedImpact: { label: impactFromPriority(dupePriorities[i]), basis: 'computed', value: sumImpressions(g.pages) },
    });
  });

  // The "no canonical tag" branch needs our own page fetch to have succeeded
  // (it reads technicalAudit.hasCanonical); the "Google-detected mismatch"
  // branch needs only GSC's indexStatus, which is independent of our fetch —
  // gating both behind technicalAudit.ok dropped a real, Google-confirmed
  // mismatch whenever our own fetch failed (bot-blocked, timeout) even though
  // GSC's data alone was enough to report it. Kept as two separate
  // aggregates (not merged into one candidate list) since they're distinct
  // failure modes with different real causes — a missing tag is usually a
  // shared template gap, a mismatch is usually a specific redirect/param
  // issue — each reported as its own "N of M checked pages" finding.
  const missingCanonicalCandidates = pageResults.filter((r) => r.technicalAudit.ok && !r.technicalAudit.hasCanonical);
  const canonicalMismatchCandidates = pageResults.filter((r) =>
    r.indexStatus.ok && r.indexStatus.googleCanonical && r.indexStatus.userCanonical && r.indexStatus.googleCanonical !== r.indexStatus.userCanonical);
  const canonicalFindings = [
    aggregateSystemicFinding({
      id: 'technical-seo:site:missing-canonical',
      affected: missingCanonicalCandidates,
      checkedCount: pageResults.filter((r) => r.technicalAudit.ok).length,
      getPage: (r) => r.page,
      getImpressions: (r) => r.impressions,
      whyItMatters: (n, c) => `${n} of ${c} checked pages have no canonical tag.`,
      recommendedAction: (rep) => ({ label: 'Add canonical', generatorId: 'canonical', params: { page: rep.page }, effort: effortForGenerator('canonical') }),
    }),
    aggregateSystemicFinding({
      id: 'technical-seo:site:canonical-mismatch',
      affected: canonicalMismatchCandidates,
      checkedCount: pageResults.filter((r) => r.indexStatus.ok).length,
      getPage: (r) => r.page,
      getImpressions: (r) => r.impressions,
      extraEvidence: (affected) => ({ samples: affected.slice(0, 5).map((r) => ({ page: r.page, googleCanonical: r.indexStatus.googleCanonical, userCanonical: r.indexStatus.userCanonical })) }),
      whyItMatters: (n, c) => `Google's chosen canonical disagrees with the page's own declared canonical on ${n} of ${c} checked pages.`,
      recommendedAction: null,
    }),
  ].filter(Boolean);

  const schemaFinding = missingSchemaFinding(pageResults);
  const schemaFindings = schemaFinding ? [schemaFinding] : [];

  const sourceImpressions = (sourcePages) => Math.max(0, ...sourcePages.map((p) => impressionsByPage.get(p) || 0));

  const brokenCandidates = [...crawl.broken].sort((a, b) => sourceImpressions(b.sourcePages) - sourceImpressions(a.sourcePages));
  const brokenPriorities = priorityByRank(brokenCandidates);
  // A dead link has two honest fixes, and which one applies is a property of
  // the site, not of the link: if the section it points into already has real
  // sibling pages, the page can be written in their shape and the link kept;
  // with nothing to model on, the only safe fix is still to strip the link.
  // dead-link-intent.js makes that call per link — see it for why sibling
  // structure is the sole signal and not a value/relevance score.
  const brokenIntents = await Promise.all(
    brokenCandidates.map((c) => decideDeadLinkAction(siteId, { href: c.href, anchorTexts: c.anchorTexts || [] })),
  );
  const brokenFindings = brokenCandidates.map((c, i) => {
    const intent = brokenIntents[i];
    const create = intent.action === 'create';
    return makeFinding({
      id: `technical-seo:broken-link:${c.sourcePages[0]}:${c.href}`,
      evidence: {
        sourcePages: c.sourcePages,
        href: c.href,
        status: c.finalStatus,
        error: c.error,
        softNotFound: c.softNotFound || false,
        resolution: intent.action,
        resolutionReason: intent.reason,
        ...(create ? { siblingPages: intent.siblings } : {}),
      },
      whyItMatters: (c.error
        ? `A link to ${c.href} (found on ${c.sourcePages.length} page(s)) failed: ${c.error}.`
        : c.softNotFound
          ? `A link to ${c.href} (found on ${c.sourcePages.length} page(s)) returns HTTP ${c.finalStatus} but serves the same fallback content as a nonexistent page on this site — likely a dead/broken link.`
          : `A link to ${c.href} (found on ${c.sourcePages.length} page(s)) returns HTTP ${c.finalStatus}.`)
        + (create
          ? ` The site already has ${intent.siblings.length} live pages in this section, so the missing page can be written to match them rather than the link removed.`
          : ` ${intent.reason} — removing the link is the safe fix.`),
      priority: brokenPriorities[i],
      recommendedAction: create
        ? {
          label: 'Create missing page',
          generatorId: 'missing-page-create',
          params: { page: c.sourcePages[0], href: c.href, title: intent.title, siblings: intent.siblings, sourcePages: c.sourcePages },
          effort: effortForGenerator('missing-page-create'),
        }
        // Strips the dead link rather than guessing a replacement target —
        // always safe (never worse than the current broken state), no
        // fabricated URL.
        : { label: 'Remove broken link', generatorId: 'broken-link-fix', params: { page: c.sourcePages[0], href: c.href, sourcePages: c.sourcePages }, effort: effortForGenerator('broken-link-fix') },
      expectedImpact: { label: impactFromPriority(brokenPriorities[i]), basis: 'computed', value: sourceImpressions(c.sourcePages) },
    });
  });

  // Same fix as any other dead link (strip it, keep the real visible text —
  // broken-link-fix.js doesn't care WHY a link died, only that it's dead),
  // just a distinguishable finding label/id so a citation going stale reads
  // differently in the Action Center than a random dead nav/body link.
  const citationCandidates = [...citationCrawl.broken].sort((a, b) => sourceImpressions(b.sourcePages) - sourceImpressions(a.sourcePages));
  const citationPriorities = priorityByRank(citationCandidates);
  const citationFindings = citationCandidates.map((c, i) => makeFinding({
    id: `technical-seo:invalid-citation:${c.sourcePages[0]}:${c.href}`,
    evidence: { sourcePages: c.sourcePages, href: c.href, status: c.finalStatus, error: c.error },
    whyItMatters: c.error
      ? `A cited external source (${c.href}, on ${c.sourcePages.length} page(s)) is no longer reachable: ${c.error}.`
      : `A cited external source (${c.href}, on ${c.sourcePages.length} page(s)) now returns HTTP ${c.finalStatus} — the citation is dead.`,
    priority: citationPriorities[i],
    recommendedAction: { label: 'Remove invalid citation', generatorId: 'broken-link-fix', params: { page: c.sourcePages[0], href: c.href, sourcePages: c.sourcePages }, effort: effortForGenerator('broken-link-fix') },
    expectedImpact: { label: impactFromPriority(citationPriorities[i]), basis: 'computed', value: sourceImpressions(c.sourcePages) },
  }));

  const chainCandidates = [...crawl.redirectChains].sort((a, b) => sourceImpressions(b.sourcePages) - sourceImpressions(a.sourcePages) || b.hops - a.hops);
  const chainPriorities = priorityByRank(chainCandidates);
  const chainFindings = chainCandidates.map((c, i) => {
    const finalUrl = c.chain?.[c.chain.length - 1]?.url ?? null;
    return makeFinding({
      id: `technical-seo:redirect-chain:${c.sourcePages[0]}:${c.href}`,
      evidence: { sourcePages: c.sourcePages, href: c.href, hops: c.hops, finalStatus: c.finalStatus, finalUrl },
      whyItMatters: `A link to ${c.href} redirects ${c.hops} times before reaching ${c.finalStatus ?? 'an unknown status'} — wastes crawl budget and load time.`,
      priority: chainPriorities[i],
      // Only ever a real, observed final URL — never fabricated when the
      // chain data doesn't actually resolve one.
      recommendedAction: finalUrl
        ? { label: 'Update redirect link', generatorId: 'redirect-fix', params: { page: c.sourcePages[0], oldHref: c.href, newHref: finalUrl }, effort: effortForGenerator('redirect-fix') }
        : null,
      expectedImpact: { label: impactFromPriority(chainPriorities[i]), basis: 'computed', value: sourceImpressions(c.sourcePages) },
    });
  });

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

  // Real sitemap URLs on a different domain than the site itself — a common,
  // genuinely serious sitemap-generation bug (leftover staging domain, a
  // migration that never updated the generator) that GSC's own per-sitemap
  // error/warning counts above don't necessarily catch (a malformed-but-
  // wrong-domain URL can still be individually well-formed).
  // hostnameOf() strips a leading "www." on both sides before comparing —
  // without it, a URL-prefix GSC property registered as (or a sitemap
  // consistently using) the other www/non-www variant of the SAME real
  // domain false-flags every single sitemap URL as "cross-domain". This
  // deliberately does NOT extend to other subdomains (e.g. blog.site.com)
  // beyond www — site-domain.js's own doc comment explains why: a
  // sc-domain: GSC property can legitimately span an entirely different
  // product living on another subdomain, so treating subdomains as
  // automatically "same site" would defeat that real leak-detection case.
  const normalizedSiteHostname = siteHostname ? hostnameOf(`https://${siteHostname}`) : null;
  const crossDomainUrls = normalizedSiteHostname
    ? sitemapUrls.filter((u) => { const h = hostnameOf(u); return h != null && h !== normalizedSiteHostname; })
    : [];
  const crossDomainSitemapFindings = crossDomainUrls.length ? [makeFinding({
    id: 'technical-seo:sitemap-cross-domain',
    evidence: { count: crossDomainUrls.length, sample: crossDomainUrls.slice(0, 5) },
    whyItMatters: `${crossDomainUrls.length} URL(s) in the sitemap point to a different domain than ${siteHostname} — likely a sitemap-generation mistake (a leftover staging domain, or a migration the generator was never updated for).`,
    priority: 'high',
    recommendedAction: null,
    expectedImpact: { label: 'High', basis: 'estimate', value: crossDomainUrls.length },
  })] : [];

  // Real GSC top-traffic pages that robots.txt actually disallows — a
  // genuinely serious, common misconfiguration (an overly broad Disallow
  // rule accidentally catching pages meant to rank) that's cheap to check
  // since pageResults already has real impressions for this run's batch.
  // Usually one shared rule catching a whole path prefix, so this is one
  // "N of M checked pages" finding, not one card per blocked page.
  const robotsBlockedCandidates = pageResults
    .filter((r) => { try { return !robots.isAllowed(new URL(r.page).pathname); } catch { return false; } });
  const robotsBlockedFinding = aggregateSystemicFinding({
    id: 'technical-seo:site:robots-blocked',
    affected: robotsBlockedCandidates,
    checkedCount: pageResults.length,
    getPage: (r) => r.page,
    getImpressions: (r) => r.impressions,
    whyItMatters: (n, c) => `robots.txt disallows ${n} of ${c} checked pages — if that's not intentional, it can stop Google from crawling pages it should be indexing.`,
    extraEvidence: (affected) => ({ blockedRules: affected.slice(0, 5).map((r) => ({ page: r.page, pattern: robots.matchingDisallow(new URL(r.page).pathname) })) }),
    recommendedAction: (rep) => ({
      label: 'Un-block in robots.txt',
      generatorId: 'robots-fix',
      params: { pagePath: new URL(rep.page).pathname, blockedPattern: robots.matchingDisallow(new URL(rep.page).pathname) },
      effort: effortForGenerator('robots-fix'),
    }),
  });
  const robotsBlockedFindings = robotsBlockedFinding ? [robotsBlockedFinding] : [];

  // Real GSC pages/queries that almost certainly belong to a PRIOR owner of
  // this domain, not this site — see index-bloat.js's header comment for the
  // chayceproperties.com case this was built from (1.5M+ indexed URLs from a
  // legacy ASP.NET storefront + an unrelated Arabic top query, on a site
  // that has never been anything but an English Eleventy site). Pulls the
  // site's own top pages/queries directly (not limited to this run's ~20-page
  // rotation batch, which is chosen for content-quality checks and would
  // rarely include zero-real-content spam URLs), so this needs no extra
  // fetch beyond two already-ingested Search Analytics reads.
  const [spamPageRows, queryRows] = await Promise.all([
    getGscBreakdownRange(siteId, start, end, 'page', 200),
    getGscBreakdownRange(siteId, start, end, 'query', 100),
  ]);
  const spamPatterns = detectSpamUrlPatterns(spamPageRows);
  const foreignQueries = detectForeignScriptQueries(queryRows, site.language_code);
  const disallowPatterns = spamPatterns.map((p) => p.pattern);

  // No robots.txt at all — previously just recorded in facts.robotsTxtFound
  // and never turned into an actionable finding. robots-bootstrap.js (unlike
  // robots-fix.js, which needs an existing file to splice into) drafts a
  // brand-new baseline file, folding in any real spam patterns found above
  // so this is one draft, not two competing full-file-overwrite drafts.
  const robotsMissingFindings = (!robotsFetch.ok) ? [makeFinding({
    id: 'technical-seo:site:robots-txt-missing',
    evidence: { hostname: siteHostname, disallowPatterns },
    whyItMatters: `${siteHostname || 'This site'} has no robots.txt — search engines default to crawling everything, with no way to steer them away from paths that shouldn't be indexed.`,
    priority: 'medium',
    recommendedAction: { label: 'Create robots.txt', generatorId: 'robots-bootstrap', params: { disallowPatterns }, effort: effortForGenerator('robots-bootstrap') },
    expectedImpact: { label: 'Medium', basis: 'estimate', value: null },
  })] : [];

  // Reported even when robots.txt already exists (still real, still worth a
  // human's attention) — but no recommendedAction in that case: safely
  // ADDING Disallow rules to an arbitrary existing robots.txt (rather than
  // writing a brand-new one, robots-bootstrap.js's only job) has no safe
  // automated path yet, same "real fact, no safe auto-fix" discipline as
  // compression/CWV/HTTPS above. When robots.txt is missing, this finding
  // still reports the fact but leaves the actual draft to the
  // robots-txt-missing finding above rather than emitting a second,
  // competing robots-bootstrap draft for the same file.
  const legacySpamFindings = (spamPatterns.length || foreignQueries.length) ? [makeFinding({
    id: 'technical-seo:site:legacy-index-spam',
    evidence: { spamPatterns, foreignQueries: foreignQueries.slice(0, 5) },
    whyItMatters: spamPatterns.length
      ? `Google is indexing ${spamPatterns.length} URL pattern(s) on this domain (e.g. ${spamPatterns[0].samplePages[0]}) that don't match anything this site actually serves — almost always crawl history left over from a prior owner of this domain, wasting crawl budget and inflating the "not indexed" count in Search Console.`
      : `A top real query for this site (in a script unrelated to its actual content) suggests this domain carries indexed content from a prior owner, unrelated to what this site serves now.`,
    priority: 'high',
    // Never a robots-bootstrap action here even when robots.txt is missing —
    // the robots-txt-missing finding above already carries that exact draft
    // (with these same disallowPatterns folded in) so the two findings never
    // race to draft two competing full-file writes to the same path.
    recommendedAction: null,
    expectedImpact: { label: 'High', basis: 'estimate', value: spamPatterns.reduce((s, p) => s + p.impressions, 0) || null },
  })] : [];

  const findings = [
    ...deindexedFindings, ...cwvFindings, ...duplicateFindings, ...canonicalFindings,
    ...schemaFindings, ...brokenFindings, ...citationFindings, ...chainFindings, ...sitemapFindings, ...orphanedFindings,
    ...crossDomainSitemapFindings, ...robotsBlockedFindings, ...compressionFindings, ...httpsFindings,
    ...inlineStylesFindings, ...largeHtmlFindings, ...robotsMissingFindings, ...legacySpamFindings,
  ];

  const facts = {
    rangeStart: start, rangeEnd: end,
    batchSize: batch.length,
    checkedPages: pageResults.map((r) => r.page), // this run's rotation batch — see security-headers.js facts for why
    pagesChecked: pageResults.map((r) => ({
      page: r.page, impressions: r.impressions,
      verdict: r.indexStatus.ok ? r.indexStatus.verdict : null,
      cwvCategory: r.coreWebVitals.ok ? r.coreWebVitals.category : null,
      compressed: r.compression.ok ? r.compression.compressed : null,
      inlineStyleCount: r.analysis ? r.analysis.inlineStyleCount : null,
      htmlByteSize: r.analysis ? r.analysis.htmlByteSize : null,
    })),
    sitemaps: sitemapResult.ok ? sitemapResult.sitemaps : [],
    sitemapsError: sitemapResult.ok ? null : sitemapResult.error,
    linkCrawl: { checked: crawl.checked, brokenCount: crawl.broken.length, redirectChainCount: crawl.redirectChains.length, checkedPages: crawl.checkedPages },
    citationCrawl: { checked: citationCrawl.checked, brokenCount: citationCrawl.broken.length, checkedPages: citationCrawl.checkedPages },
    orphanedPageCount: orphanedPages.length,
    sitemapUrlCount: sitemapUrls.length,
    crossDomainSitemapUrlCount: crossDomainUrls.length,
    robotsTxtFound: robotsFetch.ok,
    robotsBlockedTopPageCount: robotsBlockedCandidates.length,
    legacyIndexSpamPatternCount: spamPatterns.length,
    foreignScriptQueryCount: foreignQueries.length,
    httpsEnabled: httpsStatus.httpsEnabled,
    httpRedirectsToHttps: httpsStatus.httpRedirectsToHttps,
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

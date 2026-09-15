import { getSiteById, getSearchPerformanceForPages } from '../store/read.js';
import { selectCandidatePages, markPagesChecked } from './lib/candidate-pages.js';
import { followRedirectsWithRetry } from './lib/technical-seo-analysis.js';
import { makeFinding, impactFromPriority, effortFromDifficulty } from './lib/findings.js';

export const meta = {
  id: 'redirect-chain',
  name: 'Redirect Chain Detector',
  description: 'Checks whether a site\'s own known pages redirect through more than one hop before reaching their final destination — distinct from technical-seo.js\'s existing redirect-chain check, which only catches a chain when some OTHER page links to it; this catches the page\'s own URL being multi-hop even with no stale internal link pointing at it (an old URL scheme, a migrated path, a sitemap/GSC-remembered address). Auto-fixable when the site tracks an nginx config (url_file_map.siteRoot.nginxConfig — the same file soft-404.js already patches): the fix reuses implementers/lib/redirect-chain-nginx-inject.js\'s exact-match-or-refuse rewrite, which only ever proceeds when the intermediate hop is found as exactly one recognized nginx redirect rule whose live target still matches what this agent actually observed.',
  category: 'technical',
  version: 1,
};

const MAX_PAGES = 20;
// A single 301/302 straight to the final destination is normal and not
// flagged — this only fires once a page's own address requires TWO OR MORE
// hops, which is always redundant: whatever created each intermediate hop
// could point directly at the final URL instead.
const MIN_HOPS_TO_FLAG = 2;

export async function run({ siteId, start, end, params }) {
  const site = await getSiteById(siteId);
  const nginxConfigPath = site?.url_file_map?.siteRoot?.nginxConfig || null;

  const { batch, impressionsByPage } = params?.pages?.length
    ? await getSearchPerformanceForPages(siteId, start, end, params.pages).then((rows) => ({
      batch: params.pages,
      impressionsByPage: new Map(rows.map((r) => [r.dim_value, Number(r.impressions)])),
    }))
    : await selectCandidatePages(siteId, 'redirect-chain', { start, end, batchSize: MAX_PAGES });

  if (!batch.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No page performance data yet to select pages from.',
      generatedAt: new Date().toISOString(),
    };
  }

  const results = await Promise.all(batch.map(async (page) => ({ page, result: await followRedirectsWithRetry(page) })));
  if (!params?.pages?.length) await markPagesChecked(siteId, 'redirect-chain', batch);

  const chained = results.filter((r) => !r.result.error && r.result.hops >= MIN_HOPS_TO_FLAG);

  const findings = chained.map((r) => {
    const chain = r.result.chain;
    const immediateNextHop = chain[1]?.url || null;
    const finalHop = chain[chain.length - 1];
    const priority = r.result.hops >= 3 ? 'high' : 'medium';

    // Which system owns each intermediate hop (an old redirect rule, a
    // stale CMS/CDN entry, DNS-level forwarding, a third-party ad/affiliate
    // link) isn't knowable in general — but when this SITE tracks its own
    // nginx config, "is the FIRST hop defined there, as exactly one
    // recognized rule, still pointing at what we just observed" is a real,
    // checkable question, not a guess. The implementer asks that question
    // and refuses (never force-applies) the moment the answer isn't a
    // clean yes — same discipline as soft-404-nginx.
    const canAttemptAutoFix = Boolean(nginxConfigPath && immediateNextHop && finalHop?.url);

    return makeFinding({
      id: `redirect-chain:page:${r.page}`,
      evidence: {
        page: r.page, hops: r.result.hops, finalStatus: r.result.finalStatus,
        chain: chain.map((c) => ({ url: c.url, status: c.status })),
      },
      whyItMatters: `${r.page} itself redirects through ${r.result.hops} hop(s) before reaching its final destination${finalHop ? ` (${finalHop.url})` : ''} — every hop wastes crawl budget and dilutes link equity that a single direct redirect would preserve.${canAttemptAutoFix ? ' This site tracks its own nginx config, so the platform will attempt to collapse it directly — it only actually ships if the intermediate hop is found as one exact, unambiguous, still-current rule there.' : ''}`,
      priority,
      recommendedAction: canAttemptAutoFix ? {
        label: `Collapse redirect chain → ${finalHop.url}`,
        generatorId: 'redirect-chain-nginx',
        params: { page: r.page, currentHopTarget: immediateNextHop, finalTarget: finalHop.url },
        effort: effortFromDifficulty(1),
      } : null,
      reportOnly: canAttemptAutoFix ? null : {
        kind: 'redirect-chain',
        label: `${r.result.hops}-hop redirect chain`,
        page: r.page,
        whyBlocked: 'Collapsing this to one direct redirect means editing whatever created each intermediate hop — this site has no tracked nginx config to check against, so the owning system isn\'t identifiable from here.',
      },
      expectedImpact: { label: impactFromPriority(priority), basis: 'computed', value: impressionsByPage.get(r.page) || 0 },
    });
  });

  const facts = {
    rangeStart: start, rangeEnd: end, batchSize: batch.length,
    checkedPages: batch,
    pagesChecked: results.map((r) => ({ page: r.page, hops: r.result.hops, ok: !r.result.error, error: r.result.error })),
    autoFixAttempted: findings.filter((f) => f.recommendedAction).length,
    findings,
  };

  return {
    meta, status: 'ok', facts,
    narrative: findings.length ? `${findings.length} page(s) redirect through more than one hop before reaching their real destination.` : null,
    generatedAt: new Date().toISOString(),
  };
}

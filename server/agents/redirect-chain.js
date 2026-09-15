import { getSearchPerformanceForPages } from '../store/read.js';
import { selectCandidatePages, markPagesChecked } from './lib/candidate-pages.js';
import { followRedirectsWithRetry } from './lib/technical-seo-analysis.js';
import { makeFinding, impactFromPriority } from './lib/findings.js';

export const meta = {
  id: 'redirect-chain',
  name: 'Redirect Chain Detector',
  description: 'Checks whether a site\'s own known pages redirect through more than one hop before reaching their final destination — distinct from technical-seo.js\'s existing redirect-chain check, which only catches a chain when some OTHER page links to it; this catches the page\'s own URL being multi-hop even with no stale internal link pointing at it (an old URL scheme, a migrated path, a sitemap/GSC-remembered address).',
  category: 'technical',
  version: 1,
};

// Deliberately stays reportOnly regardless of hop count/traffic — unlike
// the URL/query-param duplicate detectors, evidence here (however
// confident) can't be turned into a safe autonomous fix: collapsing a
// chain means editing whatever created EACH intermediate hop, and that
// owner (an old redirect rule in a file this platform doesn't know about, a
// CDN/DNS-level forward, a third-party ad/affiliate link) isn't derivable
// from the chain response itself. There is no "rewrite hop 2 of 3" fix
// primitive to gate on confidence — the fix target is unknown, not just
// the confidence level.
const MAX_PAGES = 20;
// A single 301/302 straight to the final destination is normal and not
// flagged — this only fires once a page's own address requires TWO OR MORE
// hops, which is always redundant: whatever created each intermediate hop
// could point directly at the final URL instead.
const MIN_HOPS_TO_FLAG = 2;

export async function run({ siteId, start, end, params }) {
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
    const lastHop = r.result.chain[r.result.chain.length - 1];
    const priority = r.result.hops >= 3 ? 'high' : 'medium';
    return makeFinding({
      id: `redirect-chain:page:${r.page}`,
      evidence: {
        page: r.page, hops: r.result.hops, finalStatus: r.result.finalStatus,
        chain: r.result.chain.map((c) => ({ url: c.url, status: c.status })),
      },
      whyItMatters: `${r.page} itself redirects through ${r.result.hops} hop(s) before reaching its final destination${lastHop ? ` (${lastHop.url})` : ''} — every hop wastes crawl budget and dilutes link equity that a single direct redirect would preserve.`,
      priority,
      // Which system owns each intermediate hop (an old redirect rule, a
      // stale CMS/CDN entry, DNS-level forwarding) isn't derivable from the
      // chain alone — same reportOnly stance as duplicate-content.js's
      // byte-identical groups.
      recommendedAction: null,
      reportOnly: {
        kind: 'redirect-chain',
        label: `${r.result.hops}-hop redirect chain`,
        page: r.page,
        whyBlocked: 'Collapsing this to one direct redirect means editing whatever created each intermediate hop — the right fix depends on which system owns each hop, not guessable from the chain alone.',
      },
      expectedImpact: { label: impactFromPriority(priority), basis: 'computed', value: impressionsByPage.get(r.page) || 0 },
    });
  });

  const facts = {
    rangeStart: start, rangeEnd: end, batchSize: batch.length,
    checkedPages: batch,
    pagesChecked: results.map((r) => ({ page: r.page, hops: r.result.hops, ok: !r.result.error, error: r.result.error })),
    findings,
  };

  return {
    meta, status: 'ok', facts,
    narrative: findings.length ? `${findings.length} page(s) redirect through more than one hop before reaching their real destination.` : null,
    generatedAt: new Date().toISOString(),
  };
}

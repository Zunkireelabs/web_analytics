import { getSiteById } from '../store/read.js';
import { listPageInventory } from '../store/page-inventory.js';
import { makeFinding, impactFromPriority, effortFromDifficulty } from './lib/findings.js';
import { evidenceWindow, fetchTraffic, decideWinner, EVIDENCE_LOOKBACK_DAYS } from './lib/duplicate-evidence.js';

export const meta = {
  id: 'url-variant-duplicates',
  name: 'URL Variant Duplicate Detector',
  description: 'Groups a site\'s own already-known real URLs (crawl/sitemap/GSC) by a normalized key — trailing slash, case, and percent-encoding stripped — and flags when two structurally different URLs both resolve to the same page. Confidence-gated (lib/duplicate-evidence.js): 90 days of real GSC clicks/impressions decide a clean winner outright, or — when 2+ variants each earn real traffic — a second check for substantial query-set overlap across every pair can still confirm they compete for the same search intent before auto-consolidating.',
  category: 'technical',
  version: 1,
};

// No LLM, no live fetch — purely a normalize-and-group pass over data this
// platform already collected for other reasons (page_inventory), so this
// check keeps working even during an LLM outage and costs nothing extra to
// run daily.
function normalizeKey(pageUrl) {
  try {
    const u = new URL(pageUrl);
    let path = decodeURIComponent(u.pathname).toLowerCase();
    if (path.length > 1) path = path.replace(/\/+$/, '');
    return `${u.hostname.toLowerCase()}${path}`;
  } catch {
    return String(pageUrl).toLowerCase();
  }
}

export async function run({ siteId }) {
  const site = await getSiteById(siteId);
  if (!site) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'Site not found.', generatedAt: new Date().toISOString(),
    };
  }

  const inventory = await listPageInventory(siteId, { limit: 2000 });
  const live = inventory.filter((r) => !r.orphaned);
  if (!live.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No page inventory recorded yet for this site.', generatedAt: new Date().toISOString(),
    };
  }

  const groups = new Map(); // normalizedKey -> Set<rawPage>
  for (const row of live) {
    const key = normalizeKey(row.page);
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(row.page);
  }

  const dupGroups = [...groups.entries()].filter(([, pages]) => pages.size > 1);
  if (!dupGroups.length) {
    return {
      meta, status: 'ok',
      facts: { checkedCount: live.length, groupsWithDuplicates: 0, findings: [] },
      narrative: null, generatedAt: new Date().toISOString(),
    };
  }

  // One real evidence pull covering every variant across every group —
  // getSearchPerformanceForPages only returns rows with impressions > 0
  // (server/store/read.js), so a variant absent from this result had
  // exactly zero real impressions (and therefore zero clicks) across the
  // whole 90-day window — that absence IS the evidence, not a null.
  const allVariants = dupGroups.flatMap(([, pagesSet]) => [...pagesSet]);
  const { start: evidenceStart, end: evidenceEnd } = evidenceWindow(site);
  const trafficByPage = new Map(
    (await fetchTraffic(siteId, allVariants, evidenceStart, evidenceEnd)).map((t) => [t.page, t])
  );

  const findings = [];
  for (const [key, pagesSet] of [...dupGroups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const pages = [...pagesSet].sort();
    const traffic = pages.map((p) => trafficByPage.get(p) || { page: p, clicks: 0, impressions: 0 });
    const decision = await decideWinner(traffic, { siteId, start: evidenceStart, end: evidenceEnd });

    if (decision.winner) {
      const losers = pages.filter((p) => p !== decision.winner.page);
      findings.push(makeFinding({
        id: `url-variant-duplicates:key:${key}`,
        evidence: { normalizedKey: key, variants: pages, traffic, winner: decision.winner.page, confidence: 'high', queryOverlap: decision.queryOverlap },
        whyItMatters: decision.queryOverlap?.overlapping
          ? `${pages.length} URL variants of the same page — ${decision.winner.page} earns more real clicks (${decision.winner.clicks}) than every other variant, and their real search queries overlap substantially, confirming they compete for the same search intent. Confident enough to consolidate automatically.`
          : `${pages.length} URL variants of the same page — ${decision.winner.page} has all ${decision.winner.clicks} real click(s)/${decision.winner.impressions} impression(s) across the last ${EVIDENCE_LOOKBACK_DAYS} days, and the other ${losers.length} variant(s) have none. This is confident enough to consolidate automatically: the losing variant(s) will get a canonical tag pointing at the real one.`,
        priority: 'medium',
        // Auto-drafted through the SAME safe canonical generator every
        // self-referential canonical already uses — one loser per
        // recommendation, since each is its own separate page/file/PR
        // target; the generator re-verifies the target is still live and
        // refuses (stale) rather than guess if anything's changed since
        // this evidence was gathered. Still ends at a human-reviewed PR,
        // same as every other safe-tier fix on this platform — autonomy
        // here means zero manual investigation to REACH that PR, not a
        // bypass of the merge step itself.
        //
        // ALWAYS 'canonical', NEVER a redirect or path-rewrite generator —
        // this detector groups by hostname+path shape, which can legitimately
        // include a functional path variant (a query-string-driven wizard
        // step, a package-selection landing URL) that this platform has no
        // way to distinguish from a pure duplicate by URL shape alone. A
        // canonical tag only changes what search engines index as
        // authoritative; it never touches real navigation, so it stays safe
        // even when the "loser" URL is functionally different for a real
        // visitor. Do not route a HIGH-confidence winner here to a redirect.
        recommendedAction: {
          label: `Canonicalize duplicate variant → ${decision.winner.page}`,
          generatorId: 'canonical',
          params: { page: losers[0], canonicalTarget: decision.winner.page },
          effort: effortFromDifficulty(1),
        },
        expectedImpact: { label: impactFromPriority('medium'), basis: 'computed', value: decision.winner.clicks },
      }));
      continue;
    }

    // MEDIUM/LOW confidence: either no real traffic evidence at all for
    // any variant, or more than one variant shows real traffic with no
    // confirmed query overlap (a genuine split, or simply competing signal
    // this check can't adjudicate) — stays a human decision, same as
    // before this evidence layer existed, now enriched with the query-
    // overlap evidence either way.
    const withTraffic = decision.withTraffic;
    findings.push(makeFinding({
      id: `url-variant-duplicates:key:${key}`,
      evidence: { normalizedKey: key, variants: pages, traffic, confidence: decision.confidence, queryOverlap: decision.queryOverlap },
      whyItMatters: `${pages.length} different URLs (${pages.join(', ')}) all resolve to the same page once trailing slash, case, and encoding are normalized — Google can index these as separate, competing URLs instead of recognizing them as one.${withTraffic.length > 1 ? ` Real traffic evidence is split across ${withTraffic.length} of the variants${decision.queryOverlap && !decision.queryOverlap.overlapping ? ', and their real search queries don\'t overlap substantially, so they may genuinely be serving different intents' : ' with no confirmed shared search intent'}, so which one should win isn't unambiguous.` : ' No real click/impression evidence across the last 90 days points to a clear winner.'}`,
      priority: 'medium',
      recommendedAction: null,
      reportOnly: {
        kind: 'url-variant-duplicate',
        label: `${pages.length} URL variants of the same page`,
        page: pages[0],
        whyBlocked: withTraffic.length > 1
          ? 'More than one variant has real search traffic and their query overlap doesn\'t confirm they compete for the same intent — picking a winner here would risk redirecting a URL that\'s still earning its own real clicks, so it needs a person to confirm which one is intended.'
          : 'No real traffic signal exists for any variant yet, so there\'s no evidence to pick a winner from — needs a person to confirm which one is intended.',
      },
      expectedImpact: { label: impactFromPriority('medium'), basis: 'computed', value: 0 },
    }));
  }

  const facts = {
    checkedCount: live.length, groupsWithDuplicates: dupGroups.length,
    autoConsolidated: findings.filter((f) => f.recommendedAction).length,
    findings,
  };
  return {
    meta, status: 'ok', facts,
    narrative: findings.length ? `${findings.length} group(s) of URL variants (trailing slash/case/encoding) found for the same underlying page.` : null,
    generatedAt: new Date().toISOString(),
  };
}

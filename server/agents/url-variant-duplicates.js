import { getSiteById, getSearchPerformanceForPages } from '../store/read.js';
import { listPageInventory } from '../store/page-inventory.js';
import { makeFinding, impactFromPriority, effortFromDifficulty } from './lib/findings.js';
import { daysAgoInTz } from '../util/dates.js';

export const meta = {
  id: 'url-variant-duplicates',
  name: 'URL Variant Duplicate Detector',
  description: 'Groups a site\'s own already-known real URLs (crawl/sitemap/GSC) by a normalized key — trailing slash, case, and percent-encoding stripped — and flags when two structurally different URLs both resolve to the same page. Confidence-gated: when 90 days of real GSC clicks/impressions show ALL real traffic on exactly one variant and ZERO on every other, that winner is evidenced, not guessed, and the losers are auto-drafted a canonical pointing at it; any less clear-cut split stays a human decision.',
  category: 'technical',
  version: 1,
};

// A trailing window independent of whatever start/end this run was called
// with — job.js's daily agent battery uses a 7-day window, far too short
// and noisy to safely decide "this variant gets zero real traffic" (a
// slow week is not the same fact as a dead URL). 90 days is long enough
// that a variant with genuinely zero clicks/impressions across the whole
// window is real evidence, not sampling noise.
const EVIDENCE_LOOKBACK_DAYS = 90;

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
  const evidenceEnd = daysAgoInTz(site.timezone || 'UTC', 0);
  const evidenceStart = daysAgoInTz(site.timezone || 'UTC', EVIDENCE_LOOKBACK_DAYS);
  const perfRows = await getSearchPerformanceForPages(siteId, evidenceStart, evidenceEnd, allVariants);
  const perfByPage = new Map(perfRows.map((r) => [r.dim_value, { clicks: Number(r.clicks) || 0, impressions: Number(r.impressions) || 0 }]));

  const findings = dupGroups
    .sort((a, b) => a[0].localeCompare(b[0])) // stable run-to-run order
    .map(([key, pagesSet]) => {
      const pages = [...pagesSet].sort();
      const traffic = pages.map((p) => ({ page: p, ...(perfByPage.get(p) || { clicks: 0, impressions: 0 }) }));
      const withTraffic = traffic.filter((t) => t.clicks > 0 || t.impressions > 0);

      // HIGH confidence, matching the one unambiguous shape: exactly one
      // variant has ANY real traffic across 90 days and every other variant
      // has NONE — never a share/threshold comparison (a 60/40 split, or
      // even 95/5, is still two real signals disagreeing, not evidence one
      // side is dead) — only an absolute, undisputed zero on every loser
      // counts as confident enough to act without a human.
      const winner = withTraffic.length === 1 ? withTraffic[0] : null;

      if (winner) {
        const losers = pages.filter((p) => p !== winner.page);
        return makeFinding({
          id: `url-variant-duplicates:key:${key}`,
          evidence: { normalizedKey: key, variants: pages, traffic, winner: winner.page, confidence: 'high' },
          whyItMatters: `${pages.length} URL variants of the same page — ${winner.page} has all ${winner.clicks} real click(s)/${winner.impressions} impression(s) across the last ${EVIDENCE_LOOKBACK_DAYS} days, and the other ${losers.length} variant(s) have none. This is confident enough to consolidate automatically: the losing variant(s) will get a canonical tag pointing at the real one.`,
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
          recommendedAction: {
            label: `Canonicalize duplicate variant → ${winner.page}`,
            generatorId: 'canonical',
            params: { page: losers[0], canonicalTarget: winner.page },
            effort: effortFromDifficulty(1),
          },
          expectedImpact: { label: impactFromPriority('medium'), basis: 'computed', value: winner.clicks },
        });
      }

      // MEDIUM/LOW confidence: either no real traffic evidence at all for
      // any variant, or more than one variant shows real traffic (a genuine
      // split, or simply competing signal this check can't adjudicate) —
      // stays a human decision, same as before this evidence layer existed.
      return makeFinding({
        id: `url-variant-duplicates:key:${key}`,
        evidence: { normalizedKey: key, variants: pages, traffic, confidence: withTraffic.length > 1 ? 'medium' : 'low' },
        whyItMatters: `${pages.length} different URLs (${pages.join(', ')}) all resolve to the same page once trailing slash, case, and encoding are normalized — Google can index these as separate, competing URLs instead of recognizing them as one.${withTraffic.length > 1 ? ` Real traffic evidence is split across ${withTraffic.length} of the variants, so which one should win isn't unambiguous.` : ' No real click/impression evidence across the last 90 days points to a clear winner.'}`,
        priority: 'medium',
        recommendedAction: null,
        reportOnly: {
          kind: 'url-variant-duplicate',
          label: `${pages.length} URL variants of the same page`,
          page: pages[0],
          whyBlocked: withTraffic.length > 1
            ? 'More than one variant has real search traffic — picking a winner here would risk redirecting a URL that\'s still earning real clicks, so it needs a person to confirm which one is intended.'
            : 'No real traffic signal exists for any variant yet, so there\'s no evidence to pick a winner from — needs a person to confirm which one is intended.',
        },
        expectedImpact: { label: impactFromPriority('medium'), basis: 'computed', value: 0 },
      });
    });

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

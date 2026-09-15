import { getSiteById, getSearchPerformanceForPages } from '../store/read.js';
import { listPageInventory } from '../store/page-inventory.js';
import { makeFinding, impactFromPriority, effortFromDifficulty } from './lib/findings.js';
import { daysAgoInTz } from '../util/dates.js';

export const meta = {
  id: 'query-param-duplicates',
  name: 'Query-Param Faceted URL Duplicate Detector',
  description: 'Groups a site\'s own already-known real URLs by their base path (query string stripped) and flags when two or more DIFFERENT query-string variants of the same page are all separately known/crawlable. Confidence-gated exactly like url-variant-duplicates.js: 90 days of real GSC clicks/impressions decide whether one URL in the group has ALL the real traffic (auto-consolidate) or the evidence is mixed/absent (human decision).',
  category: 'technical',
  version: 1,
};

// No LLM, no live fetch for detection — a normalize-and-group pass over
// page_inventory, same shape and cost profile as url-variant-duplicates.js.
function baseKey(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
    return `${u.hostname.toLowerCase()}${path}`;
  } catch {
    return String(pageUrl).split('?')[0];
  }
}

function hasQuery(pageUrl) {
  try { return new URL(pageUrl).search.length > 0; } catch { return pageUrl.includes('?'); }
}

// A single query-string variant alongside its base page is normal
// (a legitimate filter/sort link) — this only fires once at least two
// DIFFERENT query-string combinations of the same page are both known,
// which is the actual duplication risk (multiple separately-indexable
// facet combinations, not just one optional parameter existing).
const MIN_QUERY_VARIANTS = 2;

// Same rationale as url-variant-duplicates.js: 7-day daily-battery windows
// are too short/noisy to safely call a variant "dead" — 90 days is long
// enough that a genuine zero is real evidence, not a quiet week.
const EVIDENCE_LOOKBACK_DAYS = 90;

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

  const groups = new Map(); // baseKey -> Set<rawPage>
  for (const row of live) {
    const key = baseKey(row.page);
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(row.page);
  }

  const candidateGroups = [...groups.entries()].filter(([, pagesSet]) => [...pagesSet].filter(hasQuery).length >= MIN_QUERY_VARIANTS);
  if (!candidateGroups.length) {
    return {
      meta, status: 'ok',
      facts: { checkedCount: live.length, groupsWithQueryVariants: 0, findings: [] },
      narrative: null, generatedAt: new Date().toISOString(),
    };
  }

  const allVariants = candidateGroups.flatMap(([, pagesSet]) => [...pagesSet]);
  const evidenceEnd = daysAgoInTz(site.timezone || 'UTC', 0);
  const evidenceStart = daysAgoInTz(site.timezone || 'UTC', EVIDENCE_LOOKBACK_DAYS);
  const perfRows = await getSearchPerformanceForPages(siteId, evidenceStart, evidenceEnd, allVariants);
  const perfByPage = new Map(perfRows.map((r) => [r.dim_value, { clicks: Number(r.clicks) || 0, impressions: Number(r.impressions) || 0 }]));

  const findings = candidateGroups
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, pagesSet]) => {
      const pages = [...pagesSet].sort();
      const queryVariants = pages.filter(hasQuery);
      const traffic = pages.map((p) => ({ page: p, ...(perfByPage.get(p) || { clicks: 0, impressions: 0 }) }));
      const withTraffic = traffic.filter((t) => t.clicks > 0 || t.impressions > 0);
      const winner = withTraffic.length === 1 ? withTraffic[0] : null;

      if (winner) {
        const losers = pages.filter((p) => p !== winner.page);
        return makeFinding({
          id: `query-param-duplicates:key:${key}`,
          evidence: { basePath: key, variants: pages, traffic, winner: winner.page, confidence: 'high' },
          whyItMatters: `${pages.length} URL variants of the same page (${key}) — ${winner.page} has all ${winner.clicks} real click(s)/${winner.impressions} impression(s) across the last ${EVIDENCE_LOOKBACK_DAYS} days, and the other ${losers.length} variant(s) have none. Confident enough to consolidate automatically.`,
          priority: 'medium',
          recommendedAction: {
            label: `Canonicalize query-param variant → ${winner.page}`,
            generatorId: 'canonical',
            params: { page: losers[0], canonicalTarget: winner.page },
            effort: effortFromDifficulty(1),
          },
          expectedImpact: { label: impactFromPriority('medium'), basis: 'computed', value: winner.clicks },
        });
      }

      return makeFinding({
        id: `query-param-duplicates:key:${key}`,
        evidence: { basePath: key, variants: pages, traffic, confidence: withTraffic.length > 1 ? 'medium' : 'low' },
        whyItMatters: `${queryVariants.length} different query-string variants of the same page (${key}) are all separately known/crawlable — unless each one carries a canonical tag pointing back at the winning URL, Google can index them as separate, competing pages instead of one.${withTraffic.length > 1 ? ` Real traffic evidence is split across ${withTraffic.length} of the variants, so which one should win isn't unambiguous.` : ' No real click/impression evidence across the last 90 days points to a clear winner.'}`,
        priority: 'medium',
        recommendedAction: null,
        reportOnly: {
          kind: 'query-param-duplicate',
          label: `${queryVariants.length} query-param variants of the same page`,
          page: pages.find((p) => !hasQuery(p)) || pages[0],
          whyBlocked: withTraffic.length > 1
            ? 'More than one variant has real search traffic — picking a winner here would risk redirecting a URL that\'s still earning real clicks, so it needs a person to confirm which one is intended.'
            : 'No real traffic signal exists for any variant yet, so there\'s no evidence to pick a winner from — needs a person to confirm whether these already canonicalize correctly.',
        },
        expectedImpact: { label: impactFromPriority('medium'), basis: 'computed', value: 0 },
      });
    });

  const facts = {
    checkedCount: live.length, groupsWithQueryVariants: findings.length,
    autoConsolidated: findings.filter((f) => f.recommendedAction).length,
    findings,
  };
  return {
    meta, status: 'ok', facts,
    narrative: findings.length ? `${findings.length} page(s) have multiple query-param variants that may be indexing as duplicates.` : null,
    generatedAt: new Date().toISOString(),
  };
}

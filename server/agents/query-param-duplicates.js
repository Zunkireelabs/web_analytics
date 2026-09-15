import { getSiteById } from '../store/read.js';
import { listPageInventory } from '../store/page-inventory.js';
import { makeFinding, impactFromPriority, effortFromDifficulty } from './lib/findings.js';
import { evidenceWindow, fetchTraffic, decideWinner, EVIDENCE_LOOKBACK_DAYS } from './lib/duplicate-evidence.js';

export const meta = {
  id: 'query-param-duplicates',
  name: 'Query-Param Faceted URL Duplicate Detector',
  description: 'Groups a site\'s own already-known real URLs by their base path (query string stripped) and flags when two or more DIFFERENT query-string variants of the same page are all separately known/crawlable. Confidence-gated exactly like url-variant-duplicates.js: 90 days of real GSC clicks/impressions decide a clean winner outright, or — with 2+ traffic-bearing variants — a query-overlap check across every pair can still confirm shared search intent before auto-consolidating.',
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
  const { start: evidenceStart, end: evidenceEnd } = evidenceWindow(site);
  const trafficByPage = new Map(
    (await fetchTraffic(siteId, allVariants, evidenceStart, evidenceEnd)).map((t) => [t.page, t])
  );

  const findings = [];
  for (const [key, pagesSet] of [...candidateGroups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const pages = [...pagesSet].sort();
    const queryVariants = pages.filter(hasQuery);
    const traffic = pages.map((p) => trafficByPage.get(p) || { page: p, clicks: 0, impressions: 0 });

    // A query-string-free URL among the candidates is always the correct
    // canonical target, full stop — never decided by traffic. rel=canonical
    // exists to point a messy/parameterized address at its clean master
    // copy; picking a query-variant winner just because it happened to earn
    // more historical clicks (an old shared link, a tracking hash from a
    // prior site on this domain, ...) points canonicalization backwards,
    // which is exactly the bug this comment is here to prevent from being
    // reintroduced (real incident: chayceproperties.com's own homepage "/"
    // was canonicalized onto "/?h=8020347041280" because that legacy
    // tracking-hash variant had the only recorded impressions).
    const bare = pages.find((p) => !hasQuery(p));
    const decision = bare
      ? { confidence: 'high', winner: trafficByPage.get(bare) || { page: bare, clicks: 0, impressions: 0 }, withTraffic: traffic.filter((t) => t.clicks > 0 || t.impressions > 0), queryOverlap: null, preferredBare: true }
      : await decideWinner(traffic, { siteId, start: evidenceStart, end: evidenceEnd });

    if (decision.winner) {
      const losers = pages.filter((p) => p !== decision.winner.page);
      // ALWAYS 'canonical', NEVER a redirect or a query-string-stripping
      // generator — and never change this to param-strip/redirect without
      // re-reading this comment. A query parameter grouped into the same
      // baseKey here can be pure tracking noise OR genuine functional state
      // this platform has no way to tell apart from URL shape alone (real
      // case: Chayce's /get-started/index.html?package=... — the parameter
      // pre-selects a package in the wizard and is read into the CRM
      // submission payload; stripping or redirecting it away would silently
      // break package selection for every real visitor who lands via a
      // package link). A <link rel="canonical"> only changes what search
      // engines index as the authoritative URL — it never touches real
      // navigation, so it's the one remediation that's safe regardless of
      // whether the parameter turns out to be functional or not. Do not
      // "upgrade" this to a redirect/rewrite generator even for a
      // HIGH-confidence winner.
      findings.push(makeFinding({
        id: `query-param-duplicates:key:${key}`,
        evidence: { basePath: key, variants: pages, traffic, winner: decision.winner.page, confidence: 'high', queryOverlap: decision.queryOverlap, preferredBare: decision.preferredBare || false },
        whyItMatters: decision.preferredBare
          ? `${pages.length} URL variants of the same page (${key}) — ${decision.winner.page} is the clean, parameter-free address and is always the correct canonical target regardless of which variant currently earns more clicks. Confident enough to consolidate automatically.`
          : decision.queryOverlap?.overlapping
          ? `${pages.length} URL variants of the same page (${key}) — ${decision.winner.page} earns more real clicks (${decision.winner.clicks}) than every other variant, and their real search queries overlap substantially, confirming shared search intent. Confident enough to consolidate automatically.`
          : `${pages.length} URL variants of the same page (${key}) — ${decision.winner.page} has all ${decision.winner.clicks} real click(s)/${decision.winner.impressions} impression(s) across the last ${EVIDENCE_LOOKBACK_DAYS} days, and the other ${losers.length} variant(s) have none. Confident enough to consolidate automatically.`,
        priority: 'medium',
        recommendedAction: {
          label: `Canonicalize query-param variant → ${decision.winner.page}`,
          generatorId: 'canonical',
          params: { page: losers[0], canonicalTarget: decision.winner.page },
          effort: effortFromDifficulty(1),
        },
        expectedImpact: { label: impactFromPriority('medium'), basis: 'computed', value: decision.winner.clicks },
      }));
      continue;
    }

    const withTraffic = decision.withTraffic;
    findings.push(makeFinding({
      id: `query-param-duplicates:key:${key}`,
      evidence: { basePath: key, variants: pages, traffic, confidence: decision.confidence, queryOverlap: decision.queryOverlap },
      whyItMatters: `${queryVariants.length} different query-string variants of the same page (${key}) are all separately known/crawlable — unless each one carries a canonical tag pointing back at the winning URL, Google can index them as separate, competing pages instead of one.${withTraffic.length > 1 ? ` Real traffic evidence is split across ${withTraffic.length} of the variants${decision.queryOverlap && !decision.queryOverlap.overlapping ? ', and their real search queries don\'t overlap substantially, so they may genuinely serve different intents' : ''}, so which one should win isn't unambiguous.` : ' No real click/impression evidence across the last 90 days points to a clear winner.'}`,
      priority: 'medium',
      recommendedAction: null,
      reportOnly: {
        kind: 'query-param-duplicate',
        label: `${queryVariants.length} query-param variants of the same page`,
        page: pages.find((p) => !hasQuery(p)) || pages[0],
        whyBlocked: withTraffic.length > 1
          ? 'More than one variant has real search traffic and their query overlap doesn\'t confirm shared intent — picking a winner here would risk redirecting a URL that\'s still earning its own real clicks, so it needs a person to confirm which one is intended.'
          : 'No real traffic signal exists for any variant yet, so there\'s no evidence to pick a winner from — needs a person to confirm whether these already canonicalize correctly.',
      },
      expectedImpact: { label: impactFromPriority('medium'), basis: 'computed', value: 0 },
    }));
  }

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

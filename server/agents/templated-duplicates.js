import { getSiteById, getSearchPerformanceForPages } from '../store/read.js';
import { listPageInventory } from '../store/page-inventory.js';
import { getOrClassifyPageContentType } from './lib/page-content-classifier.js';
import { makeFinding, impactFromPriority, effortFromDifficulty } from './lib/findings.js';
import { daysAgoInTz } from '../util/dates.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'templated-duplicates',
  name: 'Templated Near-Duplicate Page Family Detector',
  description: 'Groups a site\'s own real pages by which url_file_map.patterns entry generated them, and flags a large templated family (e.g. a location × service combination section) as a likely near-duplicate/thin-content risk. Confidence-gated: 90 days of real GSC traffic per family member, restricted to members old enough to have had a fair chance to rank, decides whether exactly one member is the real, earning page and every other member has genuinely earned nothing — if so, the losers get the SAME evidence-gated canonical-consolidation url-variant-duplicates.js/query-param-duplicates.js/sitemap-conflict.js already use, pointing them at the one member Google actually sends traffic to.',
  category: 'seo',
  version: 1,
};

// Real, found live 2026-09-15 on site 1: a `/locations/<city>/<service>/`
// pattern generating 36 near-identical pages (differing only by city/service
// name, same schema.org types, same section structure) — each with a valid
// canonical tag, none of them caught by the existing canonical-presence
// check (server/agents/technical-seo.js), because that check only asks
// "does a canonical tag exist," never "is this page's content meaningfully
// distinct from its siblings." Below this size, a shared URL pattern is
// far more likely to be normal variation (a handful of genuinely different
// pages that happen to share a template) than a programmatic-SEO risk worth
// surfacing.
const MIN_GROUP_SIZE = 8;

// Content types where the SAME url_file_map pattern is expected to hold
// genuinely-unique, individually-authored documents (a blog post, a single
// product) — a large group under one pattern here is normal, not a signal,
// so these never trigger a finding regardless of group size.
const EXCLUDED_CONTENT_TYPES = new Set(['blog', 'product']);

// How many pages per group get classified before deciding — a sample, not
// every page, since getOrClassifyPageContentType is cached per (site, page)
// but still costs a real LLM call the first time it sees a page.
const SAMPLE_SIZE = 6;

// Same 90-day rationale as url-variant-duplicates.js: long enough that a
// genuine zero is real evidence, not a quiet week.
const EVIDENCE_LOOKBACK_DAYS = 90;

// A member younger than the lookback window hasn't had a fair chance to
// earn traffic yet — "zero clicks in its first two weeks" is not evidence
// it's a redundant doorway page, it's evidence it's new. Excluded from
// BOTH sides of the winner/loser decision (never the winner just for being
// old, never a "confirmed zero" loser while still too young to judge).
const MIN_AGE_DAYS_FOR_EVIDENCE = EVIDENCE_LOOKBACK_DAYS;

function normalizePath(pageUrl) {
  try { return new URL(pageUrl).pathname; } catch { return String(pageUrl); }
}

export async function run({ siteId }) {
  const site = await getSiteById(siteId);
  const patterns = site?.url_file_map?.patterns;
  if (!Array.isArray(patterns) || !patterns.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No url_file_map.patterns configured for this site yet — nothing to group templated pages by.',
      generatedAt: new Date().toISOString(),
    };
  }

  // Same first-match-wins convention as url-file-map.js's own
  // getMatchingPattern (not imported directly — that function is private to
  // that module), so a page's grouping here always agrees with which
  // pattern the rest of the system considers authoritative for it.
  const compiled = patterns
    .map((p) => { try { return p.match ? { pattern: p, re: new RegExp(p.match) } : null; } catch { return null; } })
    .filter(Boolean);
  if (!compiled.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No usable url_file_map.patterns regex for this site.',
      generatedAt: new Date().toISOString(),
    };
  }

  const inventory = await listPageInventory(siteId, { limit: 2000 });
  const live = inventory.filter((r) => !r.orphaned);

  const groups = new Map(); // pattern.match -> { pattern, rows: [] }
  for (const row of live) {
    const path = normalizePath(row.page);
    const hit = compiled.find(({ re }) => re.test(path));
    if (!hit) continue;
    const key = hit.pattern.match;
    if (!groups.has(key)) groups.set(key, { pattern: hit.pattern, rows: [] });
    groups.get(key).rows.push(row);
  }

  const candidateGroups = [...groups.values()].filter((g) => g.rows.length >= MIN_GROUP_SIZE);
  if (!candidateGroups.length) {
    return {
      meta, status: 'ok',
      facts: { patternsConfigured: compiled.length, groupsFound: groups.size, findings: [] },
      narrative: null, generatedAt: new Date().toISOString(),
    };
  }

  const evidenceEnd = daysAgoInTz(site.timezone || 'UTC', 0);
  const evidenceStart = daysAgoInTz(site.timezone || 'UTC', EVIDENCE_LOOKBACK_DAYS);
  const ageThreshold = new Date(daysAgoInTz(site.timezone || 'UTC', MIN_AGE_DAYS_FOR_EVIDENCE));

  const findings = [];
  for (const group of candidateGroups) {
    const pages = group.rows.map((r) => r.page);
    const sample = pages.slice(0, SAMPLE_SIZE);
    const classifications = await Promise.all(
      sample.map((p) => getOrClassifyPageContentType(siteId, p).catch(() => null))
    );
    const types = classifications.filter(Boolean).map((c) => c.contentType);
    // No classification signal at all, or a mixed bag of content types
    // under one pattern (not a clean templated family) -> insufficient
    // evidence for THIS group specifically; skip rather than guess. A site
    // can still get findings for its other, cleanly-classified groups.
    if (!types.length) continue;
    const dominant = types[0];
    if (!types.every((t) => t === dominant)) continue;
    if (EXCLUDED_CONTENT_TYPES.has(dominant)) continue;

    const priority = pages.length >= MIN_GROUP_SIZE * 2 ? 'high' : 'medium';

    const perfRows = await getSearchPerformanceForPages(siteId, evidenceStart, evidenceEnd, pages);
    const perfByPage = new Map(perfRows.map((r) => [r.dim_value, { clicks: Number(r.clicks) || 0, impressions: Number(r.impressions) || 0 }]));
    const evidenceEligible = group.rows.filter((r) => r.first_seen_at && new Date(r.first_seen_at) <= ageThreshold);
    const traffic = evidenceEligible.map((r) => ({ page: r.page, ...(perfByPage.get(r.page) || { clicks: 0, impressions: 0 }) }));
    const withTraffic = traffic.filter((t) => t.clicks > 0 || t.impressions > 0);
    // Only act when EVERY eligible member has a verdict (not just a
    // majority) — a group where most members are still too young to judge
    // has too little evidence-eligible population to trust a single
    // winner, even if the few eligible ones look clean.
    const winner = evidenceEligible.length >= MIN_GROUP_SIZE && withTraffic.length === 1 ? withTraffic[0] : null;

    if (winner) {
      const losers = evidenceEligible.map((r) => r.page).filter((p) => p !== winner.page);
      findings.push(makeFinding({
        id: `templated-duplicates:pattern:${group.pattern.match}`,
        evidence: {
          pattern: group.pattern.match, pageCount: pages.length, contentType: dominant,
          evidenceEligibleCount: evidenceEligible.length, traffic, winner: winner.page, confidence: 'high',
        },
        whyItMatters: `${pages.length} pages under the "${group.pattern.match}" URL pattern, all classified as ${dominant} content — ${winner.page} has all ${winner.clicks} real click(s)/${winner.impressions} impression(s) across the last ${EVIDENCE_LOOKBACK_DAYS} days among the ${evidenceEligible.length} members old enough to judge, and every other eligible member has earned genuinely nothing. Confident enough to consolidate automatically.`,
        priority,
        // One recommendation per losing page (each is its own file/PR
        // target), same shape as url-variant-duplicates.js — the
        // coordinator's own dedup means re-running this doesn't re-draft an
        // already-open recommendation for the same (page, 'canonical').
        recommendedAction: {
          label: `Canonicalize templated duplicate → ${winner.page}`,
          generatorId: 'canonical',
          params: { page: losers[0], canonicalTarget: winner.page },
          effort: effortFromDifficulty(1),
        },
        expectedImpact: { label: impactFromPriority(priority), basis: 'computed', value: winner.clicks },
      }));
      continue;
    }

    findings.push(makeFinding({
      id: `templated-duplicates:pattern:${group.pattern.match}`,
      evidence: {
        pattern: group.pattern.match, pageCount: pages.length, contentType: dominant,
        samplePages: [...pages].sort().slice(0, 5),
        evidenceEligibleCount: evidenceEligible.length, traffic,
        confidence: withTraffic.length > 1 ? 'medium' : 'low',
      },
      whyItMatters: `${pages.length} pages under the "${group.pattern.match}" URL pattern were classified as the same content type (${dominant}) — a templated family this large commonly reads to Google as near-duplicate/thin content even when every page has its own valid canonical tag.${withTraffic.length > 1 ? ` ${withTraffic.length} members earn real traffic independently, so there's no single winner to consolidate onto.` : evidenceEligible.length < MIN_GROUP_SIZE ? ' Most members are too new for 90 days of traffic evidence to mean anything yet.' : ' No member earns real traffic yet, so there\'s no winner to point the rest at.'}`,
      priority,
      // Differentiating each page with genuinely unique content, or
      // consolidating/pruning the weaker combinations, changes which pages
      // keep independent rankings — that's an editorial/content-strategy
      // call whenever the evidence itself doesn't establish one clear
      // winner, same reasoning as duplicate-content.js's byte-identical
      // groups.
      recommendedAction: null,
      reportOnly: {
        kind: 'templated-duplicate-family',
        label: `${pages.length} templated pages may read as near-duplicate content`,
        page: [...pages].sort()[0],
        whyBlocked: withTraffic.length > 1
          ? 'More than one member earns real search traffic — picking one to consolidate the rest onto would risk redirecting a page that\'s still earning real clicks.'
          : evidenceEligible.length < MIN_GROUP_SIZE
            ? 'Most of this family is too new for 90 days of traffic evidence to be meaningful — revisit once more members have had a fair chance to rank.'
            : 'No member of this family earns real traffic yet, so there\'s no evidenced winner to consolidate the rest onto — needs a person to decide whether to add unique content or prune the family.',
      },
      expectedImpact: { label: impactFromPriority(priority), basis: 'computed', value: 0 },
    }));
  }

  const facts = {
    patternsConfigured: compiled.length, groupsFound: groups.size,
    autoConsolidated: findings.filter((f) => f.recommendedAction).length,
    findings,
  };

  const system = 'You are a technical SEO specialist writing for a non-technical site owner. Given real templated ' +
    'page families found on this site (a URL pattern generating many pages of the same content type), write 2-3 ' +
    'sentences explaining why a large templated family can read as duplicate content to Google even with valid ' +
    'canonical tags, and that the fix is an editorial decision (more unique content, or consolidation), not a ' +
    'technical one. Use ONLY the data given, never invent a pattern or count not present in the facts. Plain text, ' +
    'no markdown, no bullets.';
  const narrative = findings.length
    ? await callLLM(system, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 250 })
      .catch((err) => { console.warn('[agents] templated-duplicates narrative failed:', err.message); return null; })
    : null;

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}

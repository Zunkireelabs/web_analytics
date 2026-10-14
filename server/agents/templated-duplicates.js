import { getSiteById } from '../store/read.js';
import { listPageInventory } from '../store/page-inventory.js';
import { getOrClassifyPageContentType } from './lib/page-content-classifier.js';
import { makeFinding, impactFromPriority, effortFromDifficulty } from './lib/findings.js';
import { daysAgoInTz } from '../util/dates.js';
import { evidenceWindow, fetchTraffic, decideWinner, EVIDENCE_LOOKBACK_DAYS, textSimilarity } from './lib/duplicate-evidence.js';
import { analyzePageUrl } from './lib/page-content.js';
import { makeVerification, VERDICT } from './lib/verdict.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'templated-duplicates',
  name: 'Templated Near-Duplicate Page Family Detector',
  description: 'Groups a site\'s own real pages by which url_file_map.patterns entry generated them, and flags a large templated family (e.g. a location × service combination section) as a likely near-duplicate/thin-content risk. Confidence-gated (lib/duplicate-evidence.js, shared with url-variant-duplicates.js/query-param-duplicates.js): 90 days of real GSC traffic per family member, restricted to members old enough to have had a fair chance to rank, decides a clean winner outright, or — with 2+ traffic-bearing members — a query-overlap check across every pair can still confirm shared search intent before auto-consolidating the rest onto it.',
  category: 'seo',
  requiresCapabilities: ['public-web'],
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

// A member younger than the lookback window hasn't had a fair chance to
// earn traffic yet — "zero clicks in its first two weeks" is not evidence
// it's a redundant doorway page, it's evidence it's new. Excluded from
// BOTH sides of the winner/loser decision (never the winner just for being
// old, never a "confirmed zero" loser while still too young to judge).
const MIN_AGE_DAYS_FOR_EVIDENCE = EVIDENCE_LOOKBACK_DAYS;

// Sharing a url_file_map pattern is a URL-SHAPE fact, not a content fact: a
// catch-all like ^/([^/]+)/?$ made all 195 distinct pages of one real site a
// "family". So a group is only a duplicate family when sampled pages' real
// main text is actually similar.
//   SIMILARITY_FLOOR — below this the pages are distinct; no finding at all.
//   IDENTICAL_FLOOR  — only at/above this is the content effectively the same
//                      page, the only case a canonical (which tells Google to
//                      DROP the loser from the index) may be auto-drafted.
const SIMILARITY_FLOOR = 0.85;
const IDENTICAL_FLOOR = 0.98;
const SIM_SAMPLE = 4;
// A pattern matching more than this share of all live pages (with a real
// absolute count) is catch-all in effect, whatever its regex looks like.
const CATCH_ALL_SHARE = 0.6;
const CATCH_ALL_MIN_PAGES = 20;

// A pattern with no literal leading path segment (^/([^/]+)/?$, ^/.*, .*)
// can match any page on the site, so it identifies no template.
export function isCatchAllPattern(matchSource) {
  const src = String(matchSource || '').replace(/^\^/, '');
  if (!src || /^\.[*+]/.test(src) || /^\(\?:?\.[*+]\)/.test(src)) return true;
  const m = src.match(/^\\?\/([A-Za-z0-9_-]+)/);
  return !m; // no literal first path segment
}

function sampleEvenly(items, n) {
  if (items.length <= n) return [...items];
  const out = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor((i * items.length) / n)]);
  return out;
}

function normalizePath(pageUrl) {
  try { return new URL(pageUrl).pathname; } catch { return String(pageUrl); }
}

export async function run({ siteId, dryRun = false, pageCache }) {
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

  const catchAllSkipped = [];
  const candidateGroups = [...groups.values()].filter((g) => {
    if (g.rows.length < MIN_GROUP_SIZE) return false;
    const catchAll = isCatchAllPattern(g.pattern.match)
      || (g.rows.length >= CATCH_ALL_MIN_PAGES && g.rows.length / live.length > CATCH_ALL_SHARE);
    if (catchAll) { catchAllSkipped.push(g.pattern.match); return false; }
    return true;
  });
  if (!candidateGroups.length) {
    return {
      meta, status: 'ok',
      facts: { patternsConfigured: compiled.length, groupsFound: groups.size, catchAllPatternsSkipped: catchAllSkipped, findings: [] },
      narrative: null, generatedAt: new Date().toISOString(),
    };
  }

  const { start: evidenceStart, end: evidenceEnd } = evidenceWindow(site);
  const ageThreshold = new Date(daysAgoInTz(site.timezone || 'UTC', MIN_AGE_DAYS_FOR_EVIDENCE));

  const fetchPage = pageCache || analyzePageUrl;
  let distinctGroups = 0;
  let unverifiableGroups = 0;
  const findings = [];
  for (const group of candidateGroups) {
    const pages = group.rows.map((r) => r.page);
    const sample = pages.slice(0, SAMPLE_SIZE);
    // dryRun runs must be side-effect free: the classifier upserts its
    // cache and can call the LLM. Skipped there — the group is then treated
    // as unclassified, which can still be reported (the similarity gate below
    // carries the proof) but is never auto-actioned.
    const classifications = dryRun ? [] : await Promise.all(
      sample.map((p) => getOrClassifyPageContentType(siteId, p).catch(() => null))
    );
    const types = classifications.filter(Boolean).map((c) => c.contentType);
    // No classification signal at all, or a mixed bag of content types
    // under one pattern (not a clean templated family) -> insufficient
    // evidence for THIS group specifically; skip rather than guess. A site
    // can still get findings for its other, cleanly-classified groups.
    if (!dryRun && !types.length) continue;
    const dominant = types.length ? types[0] : 'unclassified';
    if (!types.every((t) => t === dominant)) continue;
    if (EXCLUDED_CONTENT_TYPES.has(dominant)) continue;

    // Content-similarity gate (see SIMILARITY_FLOOR). Sample-based: fetch a
    // few evenly-spread members (skipping any that redirect) and compare real
    // main text pairwise. Too few readable pages = unverifiable, never
    // asserted; a family of distinct pages is not a defect.
    const fetchedSample = (await Promise.all(sampleEvenly(pages, SIM_SAMPLE).map(async (p) => ({ page: p, result: await fetchPage(p).catch(() => ({ ok: false })) }))))
      .filter((f) => f.result.ok && !f.result.analysis.wasRedirected && f.result.analysis.bodyText);
    if (fetchedSample.length < 2) { unverifiableGroups++; continue; }
    const sims = [];
    for (let i = 0; i < fetchedSample.length; i++) {
      for (let j = i + 1; j < fetchedSample.length; j++) {
        sims.push(textSimilarity(fetchedSample[i].result.analysis.bodyText, fetchedSample[j].result.analysis.bodyText));
      }
    }
    const meanSimilarity = sims.reduce((a, b) => a + b, 0) / sims.length;
    const minSimilarity = Math.min(...sims);
    if (meanSimilarity < SIMILARITY_FLOOR) { distinctGroups++; continue; }
    const identical = minSimilarity >= IDENTICAL_FLOOR;
    const verification = makeVerification(VERDICT.CONFIRMED, 'content-similarity', `${fetchedSample.length} sampled pages average ${meanSimilarity.toFixed(2)} main-text similarity`);
    const similarityEvidence = { meanSimilarity: Number(meanSimilarity.toFixed(3)), minSimilarity: Number(minSimilarity.toFixed(3)), sampledPages: fetchedSample.map((f) => f.page) };

    const priority = pages.length >= MIN_GROUP_SIZE * 2 ? 'high' : 'medium';

    const evidenceEligible = group.rows.filter((r) => r.first_seen_at && new Date(r.first_seen_at) <= ageThreshold);
    // Only act when EVERY eligible member has a verdict (not just a
    // majority) — a group where most members are still too young to judge
    // has too little evidence-eligible population to trust a single
    // winner, even if the few eligible ones look clean.
    if (evidenceEligible.length < MIN_GROUP_SIZE) {
      findings.push(makeFinding({
        id: `templated-duplicates:pattern:${group.pattern.match}`,
        evidence: { pattern: group.pattern.match, pageCount: pages.length, contentType: dominant, evidenceEligibleCount: evidenceEligible.length, confidence: 'low', ...similarityEvidence },
        verification,
        whyItMatters: `${pages.length} pages under the "${group.pattern.match}" URL pattern were classified as the same content type (${dominant}) — a templated family this large commonly reads to Google as near-duplicate/thin content even when every page has its own valid canonical tag. Most members are too new for 90 days of traffic evidence to mean anything yet.`,
        priority,
        recommendedAction: null,
        reportOnly: {
          kind: 'templated-duplicate-family',
          label: `${pages.length} templated pages may read as near-duplicate content`,
          page: [...pages].sort()[0],
          whyBlocked: 'Most of this family is too new for 90 days of traffic evidence to be meaningful — revisit once more members have had a fair chance to rank.',
        },
        expectedImpact: { label: impactFromPriority(priority), basis: 'computed', value: 0 },
      }));
      continue;
    }

    const eligiblePages = evidenceEligible.map((r) => r.page);
    const traffic = (await fetchTraffic(siteId, eligiblePages, evidenceStart, evidenceEnd));
    const decision = await decideWinner(traffic, { siteId, start: evidenceStart, end: evidenceEnd });

    // A canonical tells Google to drop the loser from the index, so it is only
    // ever auto-drafted when the sampled content is effectively identical AND
    // the family was classified. Similar-but-not-identical pages (the usual
    // templated family: same sections, different city/service) stay a human
    // decision even with a clean traffic winner.
    if (decision.winner && identical && dominant !== 'unclassified') {
      const losers = eligiblePages.filter((p) => p !== decision.winner.page);
      findings.push(makeFinding({
        id: `templated-duplicates:pattern:${group.pattern.match}`,
        evidence: {
          pattern: group.pattern.match, pageCount: pages.length, contentType: dominant,
          evidenceEligibleCount: evidenceEligible.length, traffic, winner: decision.winner.page, confidence: 'high', queryOverlap: decision.queryOverlap, ...similarityEvidence,
        },
        verification,
        whyItMatters: decision.queryOverlap?.overlapping
          ? `${pages.length} pages under the "${group.pattern.match}" URL pattern, all classified as ${dominant} content — ${decision.winner.page} earns more real clicks than every other eligible member, and their real search queries overlap substantially, confirming shared search intent. Confident enough to consolidate automatically.`
          : `${pages.length} pages under the "${group.pattern.match}" URL pattern, all classified as ${dominant} content — ${decision.winner.page} has all ${decision.winner.clicks} real click(s)/${decision.winner.impressions} impression(s) across the last ${EVIDENCE_LOOKBACK_DAYS} days among the ${evidenceEligible.length} members old enough to judge, and every other eligible member has earned genuinely nothing. Confident enough to consolidate automatically.`,
        priority,
        // One recommendation per losing page (each is its own file/PR
        // target), same shape as url-variant-duplicates.js — the
        // coordinator's own dedup means re-running this doesn't re-draft an
        // already-open recommendation for the same (page, 'canonical').
        recommendedAction: {
          label: `Canonicalize templated duplicate → ${decision.winner.page}`,
          generatorId: 'canonical',
          params: { page: losers[0], canonicalTarget: decision.winner.page },
          effort: effortFromDifficulty(1),
        },
        expectedImpact: { label: impactFromPriority(priority), basis: 'computed', value: decision.winner.clicks },
      }));
      continue;
    }

    const withTraffic = decision.withTraffic;
    findings.push(makeFinding({
      id: `templated-duplicates:pattern:${group.pattern.match}`,
      evidence: {
        pattern: group.pattern.match, pageCount: pages.length, contentType: dominant,
        samplePages: [...pages].sort().slice(0, 5),
        evidenceEligibleCount: evidenceEligible.length, traffic, confidence: decision.confidence, queryOverlap: decision.queryOverlap, ...similarityEvidence,
      },
      verification,
      whyItMatters: `${pages.length} pages under the "${group.pattern.match}" URL pattern were classified as the same content type (${dominant}) — a templated family this large commonly reads to Google as near-duplicate/thin content even when every page has its own valid canonical tag.${withTraffic.length > 1 ? ` ${withTraffic.length} members earn real traffic independently${decision.queryOverlap && !decision.queryOverlap.overlapping ? ' with no confirmed shared search intent' : ''}, so there's no single winner to consolidate onto.` : ' No member earns real traffic yet, so there\'s no winner to point the rest at.'}`,
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
        whyBlocked: decision.winner
          ? 'The sampled pages are similar but not identical (or the family could not be classified), so canonicalizing the rest onto one would drop pages that carry their own content from the index — needs a person to decide whether to differentiate, consolidate or prune.'
          : withTraffic.length > 1
          ? 'More than one member earns real search traffic with no confirmed shared intent — picking one to consolidate the rest onto would risk redirecting a page that\'s still earning its own real clicks.'
          : 'No member of this family earns real traffic yet, so there\'s no evidenced winner to consolidate the rest onto — needs a person to decide whether to add unique content or prune the family.',
      },
      expectedImpact: { label: impactFromPriority(priority), basis: 'computed', value: 0 },
    }));
  }

  const facts = {
    patternsConfigured: compiled.length, groupsFound: groups.size, catchAllPatternsSkipped: catchAllSkipped, distinctGroups, unverifiableGroups,
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

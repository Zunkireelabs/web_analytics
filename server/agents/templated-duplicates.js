import { getSiteById } from '../store/read.js';
import { listPageInventory } from '../store/page-inventory.js';
import { getOrClassifyPageContentType } from './lib/page-content-classifier.js';
import { makeFinding, impactFromPriority } from './lib/findings.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'templated-duplicates',
  name: 'Templated Near-Duplicate Page Family Detector',
  description: 'Groups a site\'s own real pages by which url_file_map.patterns entry generated them, and flags a large templated family (e.g. a location × service combination section) as a likely near-duplicate/thin-content risk — a class of Search Console "duplicate" report a per-page canonical-tag check can never catch, since every page in the family can have a perfectly valid self-referential canonical and still get clustered as a duplicate by Google.',
  category: 'seo',
  version: 1,
};

// Deliberately stays reportOnly, even under the confidence-gated-autonomy
// model url-variant-duplicates.js/query-param-duplicates.js now use for
// their own duplicate groups — not because evidence can't establish a
// confident answer here, but because there is no existing SAFE, reversible
// fix PRIMITIVE this platform can apply once a confident answer is reached.
// Consolidating/redirecting a page family member needs a "this page should
// noindex" or "merge page A into page B" action, and no generator for
// either exists yet (unlike url-variant-duplicates' canonical-consolidation,
// which reuses the already-safe, already-shipped canonical generator).
// Building that primitive — and proving it as safe as canonical.js's own
// exact-match-or-refuse discipline — is real, separate future work, not
// something to bolt onto detection as an afterthought.

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

  const groups = new Map(); // pattern.match -> { pattern, pages: [] }
  for (const row of live) {
    const path = normalizePath(row.page);
    const hit = compiled.find(({ re }) => re.test(path));
    if (!hit) continue;
    const key = hit.pattern.match;
    if (!groups.has(key)) groups.set(key, { pattern: hit.pattern, pages: [] });
    groups.get(key).pages.push(row.page);
  }

  const candidateGroups = [...groups.values()].filter((g) => g.pages.length >= MIN_GROUP_SIZE);
  if (!candidateGroups.length) {
    return {
      meta, status: 'ok',
      facts: { patternsConfigured: compiled.length, groupsFound: groups.size, findings: [] },
      narrative: null, generatedAt: new Date().toISOString(),
    };
  }

  const findings = [];
  for (const group of candidateGroups) {
    const sample = group.pages.slice(0, SAMPLE_SIZE);
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

    const priority = group.pages.length >= MIN_GROUP_SIZE * 2 ? 'high' : 'medium';
    findings.push(makeFinding({
      id: `templated-duplicates:pattern:${group.pattern.match}`,
      evidence: { pattern: group.pattern.match, pageCount: group.pages.length, samplePages: [...group.pages].sort().slice(0, 5), contentType: dominant },
      whyItMatters: `${group.pages.length} pages under the "${group.pattern.match}" URL pattern were classified as the same content type (${dominant}) — a templated family this large commonly reads to Google as near-duplicate/thin content even when every page has its own valid canonical tag, since a canonical only asserts a page is the authority for itself, not that its content is meaningfully distinct from its siblings.`,
      priority,
      // Differentiating each page with genuinely unique content, or
      // consolidating/pruning the weaker combinations, changes which pages
      // keep independent rankings — that's an editorial/content-strategy
      // call, not a safe automatic transform, same reasoning as duplicate-
      // content.js's byte-identical groups.
      recommendedAction: null,
      reportOnly: {
        kind: 'templated-duplicate-family',
        label: `${group.pages.length} templated pages may read as near-duplicate content`,
        page: [...group.pages].sort()[0],
        whyBlocked: 'Deciding whether to add genuinely unique content to each page, or consolidate/prune the weaker combinations, changes which pages keep independent search rankings — that\'s an editorial decision, not something safe to automate.',
      },
      expectedImpact: { label: impactFromPriority(priority), basis: 'computed', value: 0 },
    }));
  }

  const facts = { patternsConfigured: compiled.length, groupsFound: groups.size, findings };

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

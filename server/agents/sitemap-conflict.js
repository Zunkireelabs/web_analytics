import { getSiteById } from '../store/read.js';
import { discoverSitemapEntries } from './lib/site-discovery.js';
import { getTechnicalSeoSignalsForPages } from '../store/technical-seo-checks.js';
import { makeFinding, impactFromPriority } from './lib/findings.js';

export const meta = {
  id: 'sitemap-conflict',
  name: 'Sitemap/Index-Signal Conflict Detector',
  description: 'Cross-references this site\'s own sitemap against Google\'s real per-page index inspection (technical_seo_checks.index_status) and flags a listed URL that is itself blocked by robots.txt, blocked by a noindex directive, or not Google\'s chosen canonical — a sitemap should only ever list real, indexable, canonical URLs, and disagreeing with Google\'s own signal is exactly the kind of inconsistency that produces mass "duplicate"/"excluded" Search Console reports.',
  category: 'technical',
  version: 1,
};

// Google's real per-page verdict, already collected by technical-seo.js's
// existing rotation (server/ingest/gsc-technical.js's inspectUrl) — this
// check is purely a read of already-collected signals, no new fetch/API
// call of its own, so it costs nothing extra to run daily.
const BLOCKING_ROBOTS_STATES = new Set(['DISALLOWED']);
const BLOCKING_INDEXING_STATES = new Set(['BLOCKED_BY_META_TAG', 'BLOCKED_BY_HTTP_HEADER', 'BLOCKED_BY_ROBOTS_TXT']);

function normalizePath(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
    return path || '/';
  } catch {
    return pageUrl;
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

  const sitemapEntries = await discoverSitemapEntries(site);
  if (!sitemapEntries.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No sitemap entries discovered yet for this site.', generatedAt: new Date().toISOString(),
    };
  }

  const locs = sitemapEntries.map((e) => e.loc);
  const signals = await getTechnicalSeoSignalsForPages(siteId, { pages: locs });
  if (!signals.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No technical-seo inspection data yet for any sitemap URL — nothing to cross-reference.', generatedAt: new Date().toISOString(),
    };
  }

  const byPage = new Map(signals.map((s) => [s.page, s]));
  const findings = [];

  for (const loc of locs) {
    const s = byPage.get(loc);
    // No row, or a row whose index_status is still null (checked for other
    // signals but never actually inspected) -> no evidence for THIS url;
    // skip rather than guess. Other sitemap urls with real signal still get
    // evaluated below.
    if (!s || !s.index_status) continue;

    const idx = s.index_status;
    const blockedByRobots = BLOCKING_ROBOTS_STATES.has(idx.robotsTxtState);
    const blockedByIndexing = BLOCKING_INDEXING_STATES.has(idx.indexingState);
    if (blockedByRobots || blockedByIndexing) {
      findings.push(makeFinding({
        id: `sitemap-conflict:blocked:${loc}`,
        evidence: { page: loc, robotsTxtState: idx.robotsTxtState, indexingState: idx.indexingState },
        whyItMatters: `${loc} is listed in the sitemap — an explicit "please index this" signal — but Google's own inspection reports it as ${blockedByRobots ? 'disallowed by robots.txt' : idx.indexingState} — the sitemap and the site's own indexing rules disagree.`,
        priority: 'high',
        recommendedAction: null,
        reportOnly: {
          kind: 'sitemap-index-conflict',
          label: 'Sitemap lists a blocked/excluded URL',
          page: loc,
          whyBlocked: 'Fixing this means deciding which signal is wrong — the sitemap listing, or the robots/noindex block — which needs a person who knows whether this page is meant to be public.',
        },
        expectedImpact: { label: impactFromPriority('high'), basis: 'computed', value: s.last_impressions || 0 },
      }));
      continue;
    }

    const googleCanonical = idx.googleCanonical;
    if (googleCanonical && normalizePath(loc) !== normalizePath(googleCanonical)) {
      findings.push(makeFinding({
        id: `sitemap-conflict:non-canonical:${loc}`,
        evidence: { page: loc, googleCanonical },
        whyItMatters: `${loc} is listed in the sitemap, but Google has chosen a DIFFERENT URL (${googleCanonical}) as this content's real canonical — the sitemap is pointing crawl/index budget at a page Google has already decided isn't the authoritative one.`,
        priority: 'medium',
        recommendedAction: null,
        reportOnly: {
          kind: 'sitemap-index-conflict',
          label: 'Sitemap lists a non-canonical URL',
          page: loc,
          whyBlocked: 'Whether the sitemap URL or Google\'s chosen canonical is the intended one is a real technical/editorial decision, not guessable from this signal alone.',
        },
        expectedImpact: { label: impactFromPriority('medium'), basis: 'computed', value: s.last_impressions || 0 },
      }));
    }
  }

  const facts = { sitemapUrlCount: locs.length, checkedUrlCount: signals.filter((s) => s.index_status).length, findings };
  return {
    meta, status: 'ok', facts,
    narrative: findings.length ? `${findings.length} sitemap URL(s) conflict with Google's own index/canonical signal for them.` : null,
    generatedAt: new Date().toISOString(),
  };
}

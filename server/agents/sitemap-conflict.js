import { getSiteById } from '../store/read.js';
import { discoverSitemapEntries, parseRobotsDisallowRules, originForSite } from './lib/site-discovery.js';
import { fetchTextIfExists, effortForGenerator } from './lib/page-content.js';
import { getTechnicalSeoSignalsForPages } from '../store/technical-seo-checks.js';
import { makeFinding, impactFromPriority } from './lib/findings.js';
import { BLOCKING_ROBOTS_STATES, BLOCKING_INDEXING_STATES } from './lib/index-status.js';

export const meta = {
  id: 'sitemap-conflict',
  name: 'Sitemap/Index-Signal Conflict Detector',
  description: 'Cross-references this site\'s own sitemap against Google\'s real per-page index inspection (technical_seo_checks.index_status) and flags a listed URL that is itself blocked by robots.txt, blocked by a noindex directive, or not Google\'s chosen canonical. Auto-resolves the two cases where the evidence unambiguously identifies which real signal is wrong: a robots.txt Disallow rule that the site\'s own sitemap contradicts (same safe Allow-override primitive as technical-seo.js\'s robots-blocked check), and a page with no self-asserted canonical where Google has already, authoritatively, picked a different one (draft a canonical agreeing with Google\'s own verdict).',
  category: 'technical',
  version: 1,
};

// Google's real per-page verdict, already collected by technical-seo.js's
// existing rotation (server/ingest/gsc-technical.js's inspectUrl) — reading
// it here costs nothing extra; the one new live call this agent makes is
// the robots.txt fetch below, needed to compute a draftable blockedPattern
// (mirrors technical-seo.js's own robots-blocked finding exactly, just
// triggered by a different evidence source: Google's own Inspection API
// verdict for a SITEMAP-listed URL, rather than a local robots.txt parse
// against GSC-top-traffic candidate pages — the two checks' recommendations
// for the same (page, 'robots-fix') safely MERGE into one recommendation
// row via the coordinator's existing findOpenRecommendation/
// mergeIntoRecommendation dedup, they never race or double-draft).

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

  const origin = originForSite(site);
  const robotsFetch = origin ? await fetchTextIfExists(`${origin}/robots.txt`) : { ok: false };
  const robots = parseRobotsDisallowRules(robotsFetch.ok ? robotsFetch.text : '');
  // Gates the sitemap-removal fallback below — same config this platform
  // already requires before it'll touch a sitemap file at all (sitemap.js's
  // own gate). Without it, removal has nowhere safe to write, so both
  // fallback branches stay reportOnly exactly as before.
  const sitemapConfigured = Boolean(site?.url_file_map?.siteRoot?.sitemap);

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
      let path;
      try { path = new URL(loc).pathname; } catch { path = null; }
      // Only the robots.txt sub-case has a known, already-safe fix
      // primitive (robots-fix.js's narrow Allow-override). A block reported
      // as BLOCKED_BY_META_TAG/HTTP_HEADER means the exclusion lives in the
      // page's own HTML/response headers, which this platform has no
      // generic "remove a noindex directive" primitive for yet — genuinely
      // case (A): the correct fix isn't derivable from this signal alone,
      // since a human placed that noindex deliberately as often as not.
      const blockedPattern = blockedByRobots && path ? robots.matchingDisallow(path) : null;
      const canUnblock = blockedByRobots && path && blockedPattern;
      // Fallback when the block itself can't be safely undone: align the
      // sitemap with Google's own already-confirmed current state instead
      // of trying to fix the exclusion. Never touches the noindex/robots
      // signal — see generators/sitemap-removal.js's own comment for why
      // this is safe (self-correcting via sitemap.js's existing "URL
      // missing from sitemap" detection if the underlying signal changes).
      const canRemoveFromSitemap = !canUnblock && sitemapConfigured;

      findings.push(makeFinding({
        id: `sitemap-conflict:blocked:${loc}`,
        evidence: { page: loc, robotsTxtState: idx.robotsTxtState, indexingState: idx.indexingState, blockedPattern },
        whyItMatters: `${loc} is listed in the sitemap — an explicit "please index this" signal — but Google's own inspection reports it as ${blockedByRobots ? `disallowed by robots.txt (rule: "${blockedPattern || 'unknown'}")` : idx.indexingState} — the sitemap and the site's own indexing rules disagree.${canUnblock ? ' A narrow Allow-override resolves this without widening access to anything else the Disallow rule covers.' : canRemoveFromSitemap ? ' The block itself can\'t be safely undone automatically, so this instead removes the URL from the sitemap to agree with Google\'s confirmed current state — self-correcting: sitemap.js re-adds it automatically the moment the block is lifted.' : ''}`,
        priority: 'high',
        recommendedAction: canUnblock ? {
          label: `Un-block ${path} in robots.txt`,
          generatorId: 'robots-fix',
          params: { pagePath: path, blockedPattern },
          effort: effortForGenerator('robots-fix'),
        } : canRemoveFromSitemap ? {
          label: `Remove ${loc} from sitemap`,
          generatorId: 'sitemap-removal',
          params: { page: loc, removeUrls: [loc] },
          effort: effortForGenerator('sitemap-removal'),
        } : null,
        reportOnly: (canUnblock || canRemoveFromSitemap) ? null : {
          kind: 'sitemap-index-conflict',
          label: 'Sitemap lists a blocked/excluded URL',
          page: loc,
          whyBlocked: 'This site has no tracked sitemap file to safely edit (url_file_map.siteRoot.sitemap not configured), so neither the block nor the sitemap listing can be auto-resolved — needs a person to fix directly.',
        },
        expectedImpact: { label: impactFromPriority('high'), basis: 'computed', value: s.last_impressions || 0 },
      }));
      continue;
    }

    const googleCanonical = idx.googleCanonical;
    if (googleCanonical && normalizePath(loc) !== normalizePath(googleCanonical)) {
      // High confidence only when the page has asserted NO canonical of its
      // own (has_canonical === false) — Google's own algorithmic pick is
      // then the best available evidence for what this page's canonical
      // SHOULD say, and agreeing with it is a safe, narrow fix (reuses
      // canonical.js's existing evidence-gated canonicalTarget path, same
      // as url-variant-duplicates.js/query-param-duplicates.js). When the
      // page ALREADY has its own canonical that Google is simply
      // overriding, a human already made a call here Google disagrees
      // with — genuinely case (A), not guessable which one is actually
      // right.
      const hasOwnCanonical = s.has_canonical === true;
      // Fallback for the same reason as the blocked branch above: when the
      // page already asserts its own conflicting canonical, agreeing with
      // Google isn't safe (a human decision already exists) — but removing
      // the sitemap's OWN listing of a page it isn't authoritative for is
      // still safe and self-correcting.
      const canRemoveFromSitemap = hasOwnCanonical && sitemapConfigured;
      findings.push(makeFinding({
        id: `sitemap-conflict:non-canonical:${loc}`,
        evidence: { page: loc, googleCanonical, hasOwnCanonical },
        whyItMatters: `${loc} is listed in the sitemap, but Google has chosen a DIFFERENT URL (${googleCanonical}) as this content's real canonical — the sitemap is pointing crawl/index budget at a page Google has already decided isn't the authoritative one.${!hasOwnCanonical ? ' The page asserts no canonical of its own, so agreeing with Google\'s own verdict is safe to draft automatically.' : canRemoveFromSitemap ? ' The page already asserts its own conflicting canonical, so this instead removes it from the sitemap rather than overriding that existing decision — self-correcting: sitemap.js re-adds it automatically if that ever changes.' : ''}`,
        priority: 'medium',
        recommendedAction: !hasOwnCanonical ? {
          label: `Canonical → ${googleCanonical} (agreeing with Google's own verdict)`,
          generatorId: 'canonical',
          params: { page: loc, canonicalTarget: googleCanonical },
          effort: effortForGenerator('canonical'),
        } : canRemoveFromSitemap ? {
          label: `Remove ${loc} from sitemap`,
          generatorId: 'sitemap-removal',
          params: { page: loc, removeUrls: [loc] },
          effort: effortForGenerator('sitemap-removal'),
        } : null,
        reportOnly: (!hasOwnCanonical || canRemoveFromSitemap) ? null : {
          kind: 'sitemap-index-conflict',
          label: 'Sitemap lists a non-canonical URL',
          page: loc,
          whyBlocked: 'This site has no tracked sitemap file to safely edit (url_file_map.siteRoot.sitemap not configured) — needs a person to fix directly.',
        },
        expectedImpact: { label: impactFromPriority('medium'), basis: 'computed', value: s.last_impressions || 0 },
      }));
    }
  }

  const facts = {
    sitemapUrlCount: locs.length, checkedUrlCount: signals.filter((s) => s.index_status).length,
    autoFixable: findings.filter((f) => f.recommendedAction).length,
    findings,
  };
  return {
    meta, status: 'ok', facts,
    narrative: findings.length ? `${findings.length} sitemap URL(s) conflict with Google's own index/canonical signal for them.` : null,
    generatedAt: new Date().toISOString(),
  };
}

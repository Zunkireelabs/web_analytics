import { getSiteById } from '../store/read.js';
import { makeFinding, impactFromPriority } from './lib/findings.js';
import { effortForGenerator, isPrivateOrLocalHost } from './lib/page-content.js';

export const meta = {
  id: 'soft-404',
  name: 'Soft-404 Detector',
  description: 'Probes this site\'s own live server with a guaranteed-nonexistent URL and flags it if the response is 2xx instead of a real 404 — a common static-site misconfiguration where every stale, mistyped, or removed URL silently serves the homepage instead of "not found".',
  category: 'technical',
  version: 1,
};

// Real, found live 2026-09-15 on site 1 (zunkireelabs.com): nginx's
// `try_files $uri $uri/ $uri.html /index.html;` catch-all with no
// `error_page 404` served the homepage (200) for a malformed generated URL
// (`/locations//aeo-seo/`) and for a plain nonexistent path alike. Google
// then sees hundreds of distinct URLs (old removed pages, typos, malformed
// generated links) all serving identical content and buckets most of them
// as "duplicate without user-selected canonical" instead of "not found" —
// a much larger and easier-to-miss cause of mass duplicate-content reports
// than any one page-level content issue.
const FETCH_TIMEOUT_MS = 8000;

// Deliberately synthetic and namespaced so it can never collide with a real
// page on any tenant's site — the only requirement is that this path is
// guaranteed not to exist.
const PROBE_PATH = '/__action-center-soft-404-probe__/';

// Sites where a homepage/index fallback for an unmatched route is virtually
// always a misconfiguration, never intentional — unlike a real client-side-
// routed SPA, where the identical nginx pattern is correct (the app's own
// JS router decides what an unmatched path renders). tech_stack is
// free-text, staff-entered only (see site-fingerprint.js's own comment on
// why absence is treated as absence, never a guessed default) — this only
// ever offers the auto-fix when a known static-site generator was
// explicitly recorded; anything else still gets the finding, just without
// a draftable action, so a human decides.
const STATIC_SITE_GENERATORS = new Set(['eleventy', '11ty', 'hugo', 'jekyll', 'astro', 'gatsby', 'next-static']);

export async function run({ siteId }) {
  const site = await getSiteById(siteId);
  if (!site?.website_domain) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No website_domain configured for this site yet.',
      generatedAt: new Date().toISOString(),
    };
  }

  let hostname;
  try { hostname = new URL(`https://${site.website_domain}`).hostname; } catch { hostname = null; }
  if (!hostname || isPrivateOrLocalHost(hostname)) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'website_domain is not a probeable public hostname.',
      generatedAt: new Date().toISOString(),
    };
  }

  const probeUrl = `https://${site.website_domain}${PROBE_PATH}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let status;
  try {
    const res = await fetch(probeUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZunkireeAnalyticsBot/1.0; +soft-404-agent)' },
    });
    status = res.status;
  } catch (err) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: `Could not reach ${probeUrl}: ${err.message}`,
      generatedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timeout);
  }

  const isSoftNotFound = status >= 200 && status < 300;
  if (!isSoftNotFound) {
    return {
      meta, status: 'ok',
      facts: { probeUrl, responseStatus: status, findings: [] },
      narrative: null, generatedAt: new Date().toISOString(),
    };
  }

  const isKnownStaticGenerator = STATIC_SITE_GENERATORS.has(String(site.tech_stack || '').toLowerCase().trim());
  const priority = 'high';
  const finding = makeFinding({
    id: 'soft-404:site:homepage-fallback',
    evidence: { probeUrl, responseStatus: status, techStack: site.tech_stack || null },
    whyItMatters: `A guaranteed-nonexistent URL (${probeUrl}) returned HTTP ${status} instead of a real 404 — the server falls back to serving the homepage for any unmatched route. Every stale, mistyped, or removed URL search engines have ever seen for this domain now looks like duplicate homepage content instead of "not found", which is a common cause of mass "duplicate without user-selected canonical" reports in Search Console.`,
    priority,
    recommendedAction: isKnownStaticGenerator ? {
      label: 'Return a real 404 status for unmatched routes',
      generatorId: 'soft-404-nginx',
      params: {},
      effort: effortForGenerator('soft-404-nginx'),
    } : null,
    expectedImpact: { label: impactFromPriority(priority), basis: 'computed', value: 0 },
  });

  return {
    meta, status: 'ok',
    facts: { probeUrl, responseStatus: status, findings: [finding] },
    narrative: finding.whyItMatters,
    generatedAt: new Date().toISOString(),
  };
}

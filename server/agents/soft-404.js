import { getSiteById } from '../store/read.js';
import { makeFinding, impactFromPriority } from './lib/findings.js';
import { effortForGenerator, isPrivateOrLocalHost } from './lib/page-content.js';
import { safeMessage } from '../lib/errors.js';
import { makeVerification, VERDICT } from './lib/verdict.js';

export const meta = {
  id: 'soft-404',
  name: 'Soft-404 Detector',
  description: 'Probes this site\'s own live server with a guaranteed-nonexistent URL and flags it if the response is 2xx instead of a real 404 — a common static-site misconfiguration where every stale, mistyped, or removed URL silently serves the homepage instead of "not found".',
  category: 'technical',
  requiresCapabilities: ['public-web'],
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

async function fetchOnce(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZunkireeAnalyticsBot/1.0; +soft-404-agent)' },
    });
    const text = res.status >= 200 && res.status < 300 && typeof res.text === 'function'
      ? String(await res.text()).replace(/\s+/g, ' ').trim()
      : '';
    return { status: res.status, text };
  } finally {
    clearTimeout(timeout);
  }
}

export async function run({ siteId }) {
  const site = await getSiteById(siteId);
  if (!site?.website_domain) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No website_domain configured for this site yet.',
      generatedAt: new Date().toISOString(),
    };
  }

  // website_domain is stored both bare ("x.com") and as a full URL
  // ("https://x.com/") depending on the tenant — blindly prefixing https://
  // produced "https://https://x.com/", threw, and left this agent dead on
  // every site stored the second way.
  let origin;
  let hostname;
  try {
    const d = String(site.website_domain).trim();
    const u = new URL(/^https?:/i.test(d) ? d : `https://${d}`);
    origin = u.origin;
    hostname = u.hostname;
  } catch { origin = null; hostname = null; }
  if (!hostname || isPrivateOrLocalHost(hostname)) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'website_domain is not a probeable public hostname.',
      generatedAt: new Date().toISOString(),
    };
  }

  const probeUrl = `${origin}${PROBE_PATH}`;
  let status;
  let probeText;
  let homeText = null;
  try {
    // redirect:'manual' — a 301 to the canonical host (zunkireelabs.com's
    // www answers EVERY path with one) is not a soft-404; only a same-origin
    // 2xx that serves content is.
    const probe = await fetchOnce(probeUrl);
    status = probe.status;
    probeText = probe.text;
    if (status >= 200 && status < 300 && probeText) {
      const home = await fetchOnce(`${origin}/`);
      if (home.status >= 200 && home.status < 300) homeText = home.text;
    }
  } catch (err) {
    const { message } = safeMessage(`soft-404.run:${site.id}`, err, 'this site could not be probed right now');
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message,
      generatedAt: new Date().toISOString(),
    };
  }

  const is2xx = status >= 200 && status < 300;
  // A 2xx is only a homepage-fallback soft-404 when its body actually IS the
  // homepage. A normal SPA/static host answering with its own not-found page
  // or a distinct shell is legitimate; an empty body or an unfetchable
  // homepage cannot prove anything, so it is not asserted either.
  const isSoftNotFound = is2xx && Boolean(probeText) && homeText != null && probeText === homeText;
  if (!isSoftNotFound) {
    return {
      meta, status: 'ok',
      facts: {
        probeUrl, responseStatus: status, findings: [],
        ...(is2xx ? { note: homeText == null ? 'probe returned 2xx but the homepage could not be fetched to compare — not asserted' : 'probe returned 2xx but its body differs from the homepage — not a homepage fallback' } : {}),
      },
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
    verification: makeVerification(VERDICT.CONFIRMED, 'soft-404-fingerprint', 'nonexistent path returns 2xx with a body identical to the homepage'),
    recommendedAction: isKnownStaticGenerator ? {
      label: 'Return a real 404 status for unmatched routes',
      generatorId: 'soft-404-nginx',
      params: {},
      effort: effortForGenerator('soft-404-nginx'),
    } : null,
    // A confirmed, live defect (this run just observed it) with no
    // recommendedAction AND no reportOnly is silently dropped by
    // buildRecommendations (server/agents/lib/recommendations.js) — it
    // falls into evidenceOnlyFindings and never reaches Action Center at
    // all. That's the exact bug this codebase already fixed once for
    // sitemap.js/duplicate-content.js ("a real defect sat invisible
    // because nothing declared it as one"); this finding was recreating it
    // for every site whose tech_stack isn't a recognized static generator.
    reportOnly: isKnownStaticGenerator ? null : {
      kind: 'soft-404',
      label: 'Server returns 200 for a nonexistent URL',
      page: probeUrl,
      whyBlocked: `This site's tech_stack (${site.tech_stack || 'not set'}) isn't a recognized static-site generator, so the fix can't be auto-drafted — a real client-side-routed SPA can legitimately use this exact fallback pattern on purpose. A person needs to confirm whether this is a genuine misconfiguration before it's safe to patch.`,
    },
    expectedImpact: { label: impactFromPriority(priority), basis: 'computed', value: 0 },
  });

  return {
    meta, status: 'ok',
    facts: { probeUrl, responseStatus: status, findings: [finding] },
    narrative: finding.whyItMatters,
    generatedAt: new Date().toISOString(),
  };
}

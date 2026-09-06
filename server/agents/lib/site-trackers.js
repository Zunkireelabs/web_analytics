import { fetchHtml, fetchResponseHeaders } from './page-content.js';

// Real, observable facts only — used by trust-compliance.js (detection) and
// the cookie-policy/privacy-policy/terms-of-service generators (drafting),
// so a generated page only ever names a cookie or third-party service that
// was actually found on the site, never a generic/invented one.

// Script-tag signatures for the handful of trackers common enough to name
// specifically. Deliberately conservative — a service not in this list
// simply isn't named, rather than guessed.
//
// `tagManager: true` marks a container that LOADS other tags at runtime
// rather than being a tracker whose presence tells you anything about which
// tracking is actually happening. See tagManagersDetected /
// trackerAbsenceIsProvable below for why that distinction matters: every
// signature here reads STATIC HTML, and a tag manager's payload only exists
// after its JavaScript runs, so nothing in this file can see it.
const TRACKER_SIGNATURES = [
  { id: 'google-analytics-4', label: 'Google Analytics (GA4)', test: (html) => /googletagmanager\.com\/gtag\/js\?id=G-|gtag\(\s*['"]config['"]\s*,\s*['"]G-/i.test(html) },
  // Google Tag Manager, and the newer consolidated "Google tag" (GT-) — both
  // are containers, not measurement in themselves. The noscript
  // `ns.html?id=GTM-` iframe is included because a container installed by a
  // plugin/theme sometimes only leaves that fragment in the server-rendered
  // HTML.
  {
    id: 'google-tag-manager', label: 'Google Tag Manager', tagManager: true,
    test: (html) => /googletagmanager\.com\/(gtm\.js|ns\.html)\?id=GTM-|googletagmanager\.com\/gtag\/js\?id=GT-|['"]GTM-[A-Z0-9]{4,}['"]/i.test(html),
  },
  { id: 'google-ads', label: 'Google Ads', test: (html) => /googleadservices\.com|gtag\(\s*['"]config['"]\s*,\s*['"]AW-/i.test(html) },
  { id: 'facebook-pixel', label: 'Meta/Facebook Pixel', test: (html) => /connect\.facebook\.net\/[^"']*\/fbevents\.js|fbq\(\s*['"]init['"]/i.test(html) },
  { id: 'hubspot', label: 'HubSpot', test: (html) => /js\.hs-scripts\.com|js\.hs-analytics\.net/i.test(html) },
  { id: 'intercom', label: 'Intercom', test: (html) => /widget\.intercom\.io/i.test(html) },
  { id: 'hotjar', label: 'Hotjar', test: (html) => /static\.hotjar\.com/i.test(html) },
  { id: 'linkedin-insight', label: 'LinkedIn Insight Tag', test: (html) => /snap\.licdn\.com\/li\.lms-analytics/i.test(html) },
];

// Real `Set-Cookie` names off the actual HTTP response — never a hardcoded
// "typical" cookie list. `Headers.getSetCookie()` (Node 18.14+/undici)
// correctly splits multiple Set-Cookie lines; older runtimes only expose a
// single joined value via `.get('set-cookie')`, so that's the fallback.
function cookieNamesFrom(headers) {
  const lines = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
  return lines
    .map((line) => line.split(';')[0]?.split('=')[0]?.trim())
    .filter(Boolean);
}

// Whether "we did not detect tracker X" is a fact or merely the limit of
// what static HTML can show.
//
// Every signature above matches raw server-rendered HTML. Google Tag Manager
// (and any other container) loads its tags at RUNTIME from a remote
// container config — the GA4 or Meta Pixel snippet it fires is never present
// in the HTML we fetched, so a GTM-only page is indistinguishable here from
// a page with no analytics at all. Before this existed, trust-compliance.js
// read an empty trackersDetected as proof of absence and told every
// WordPress/Shopify/agency tenant deploying GA4 through GTM — the dominant
// install pattern outside the first tenant's hand-written Eleventy site —
// "No Google Analytics detected", then offered to draft an install script
// for analytics that was already live. Duplicate GA4 tags double-count every
// pageview, so acting on that finding actively corrupts the tenant's data.
//
// Returning false means: report nothing. A container proves a tag manager is
// present, NOT which tags it fires, so there is no honest finding to make in
// either direction — abstain rather than assert. A failed page fetch is
// treated the same way, and so is a facts object that predates the field
// (fails closed to "not provable" — the safe direction is silence).
export function trackerAbsenceIsProvable(facts) {
  return facts?.trackerAbsenceProvable === true;
}

// Pure, no I/O — split out of collectSiteTrackerFacts so the signatures above
// can be regression-tested against real HTML fragments without a network
// fetch. A tag manager appears in BOTH lists: it really was observed on the
// page and really does set its own cookies, so the cookie/privacy-policy
// generators (which ground their copy strictly in trackersDetected) should
// name it. tagManagersDetected answers the separate, narrower question of
// whether the OTHER entries' absence can be trusted at all.
export function detectTrackersInHtml(html) {
  const matched = TRACKER_SIGNATURES.filter((sig) => sig.test(html || ''));
  return {
    trackersDetected: matched.map((sig) => sig.label),
    tagManagersDetected: matched.filter((sig) => sig.tagManager).map((sig) => sig.label),
  };
}

// One real page's worth of facts — callers checking multiple pages should
// merge/dedupe the arrays themselves (see trust-compliance.js).
export async function collectSiteTrackerFacts(site, pageUrl) {
  const [htmlResult, headersResult] = await Promise.all([
    fetchHtml(pageUrl),
    fetchResponseHeaders(pageUrl),
  ]);

  const cookiesObserved = headersResult.ok ? cookieNamesFrom(headersResult.headers) : [];
  // A failed fetch is NOT proof of absence either — no HTML was read, so
  // nothing can be ruled out. Reported as unprovable for the same reason a
  // tag manager is, rather than as an empty "we looked and found nothing".
  const { trackersDetected, tagManagersDetected } = htmlResult.ok
    ? detectTrackersInHtml(htmlResult.html)
    : { trackersDetected: [], tagManagersDetected: [] };
  const trackerAbsenceProvable = htmlResult.ok && !tagManagersDetected.length;

  return {
    siteName: site?.name || null,
    domain: site?.website_domain || null,
    pageChecked: pageUrl,
    cookiesObserved,
    trackersDetected,
    tagManagersDetected,
    // Explicit rather than left for each caller to re-derive — a caller that
    // forgets to check is exactly how the false "no analytics installed"
    // finding shipped in the first place. Read it via
    // trackerAbsenceIsProvable() below, which defaults to "not provable" for
    // any facts object that predates this field.
    trackerAbsenceProvable,
  };
}

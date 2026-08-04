import { fetchHtml, fetchResponseHeaders } from './page-content.js';

// Real, observable facts only — used by trust-compliance.js (detection) and
// the cookie-policy/privacy-policy/terms-of-service generators (drafting),
// so a generated page only ever names a cookie or third-party service that
// was actually found on the site, never a generic/invented one.

// Script-tag signatures for the handful of trackers common enough to name
// specifically. Deliberately conservative — a service not in this list
// simply isn't named, rather than guessed.
const TRACKER_SIGNATURES = [
  { id: 'google-analytics-4', label: 'Google Analytics (GA4)', test: (html) => /googletagmanager\.com\/gtag\/js\?id=G-|gtag\(\s*['"]config['"]\s*,\s*['"]G-/i.test(html) },
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

// One real page's worth of facts — callers checking multiple pages should
// merge/dedupe the arrays themselves (see trust-compliance.js).
export async function collectSiteTrackerFacts(site, pageUrl) {
  const [htmlResult, headersResult] = await Promise.all([
    fetchHtml(pageUrl),
    fetchResponseHeaders(pageUrl),
  ]);

  const cookiesObserved = headersResult.ok ? cookieNamesFrom(headersResult.headers) : [];
  const trackersDetected = htmlResult.ok
    ? TRACKER_SIGNATURES.filter((sig) => sig.test(htmlResult.html)).map((sig) => sig.label)
    : [];

  return {
    siteName: site?.name || null,
    domain: site?.website_domain || null,
    pageChecked: pageUrl,
    cookiesObserved,
    trackersDetected,
  };
}

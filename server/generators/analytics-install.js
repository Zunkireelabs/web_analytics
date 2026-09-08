// Pure, deterministic generator — no LLM call, nothing to ground beyond the
// two real inputs: which provider (trust-compliance.js's own tracker
// detection already tells us GA4/Facebook Pixel is genuinely absent) and the
// site's own real GA4 measurement ID / Pixel ID. That ID can never be
// invented (same no-fabrication rule as every other generator here) — if it
// genuinely does not exist anywhere, the draft ships with a PLACEHOLDER_NOTE
// and placeholderFields, same contract as open-graph.js/schema.js: blocked
// from auto-publish until a human edits the draft with the site's real ID.
//
// WHERE THE ID COMES FROM, and why it is read here rather than taken on
// trust from `params` (fixed 2026-09-08). trust-compliance.js reads
// sites.ga4_measurement_id / sites.facebook_pixel_id at DETECTION time and
// copies whatever it finds into the recommendation's params, which are then
// FROZEN on the recommendation row — routes/action-center.js always drafts
// against rec.params, and nothing refreshes them between retries (see
// lib/action-center-reconciler.js's recovery pass, which exists precisely
// because frozen params go stale).
//
// So a recommendation first detected while the site had no ID configured
// carried `params` with no trackingId FOREVER. Configuring the real ID in
// the database afterwards changed nothing: every retry re-read the same
// empty frozen params, emitted the placeholder, and was refused at the
// publish gate as an "unverified placeholder field". Confirmed live on site
// 1 — drafts #631/#632 (2026-08-31, params carrying no trackingId) failed
// this way 15 times over a week while sites.ga4_measurement_id and
// sites.facebook_pixel_id both held perfectly valid IDs.
//
// The site row is the AUTHORITATIVE, current configuration, so it is what
// this reads. `params.trackingId` remains a fallback for the caller that
// passes an ID explicitly (the MCP tool, a manual API call) for a site that
// has none stored. A configured ID can therefore never be lost by a stale
// recommendation again.
// The implementer (server/implementers/backend.js) splices the resulting
// <script> block into <head> via the head-scoped marker mechanism
// (server/implementers/lib/marker-merge.js's HEAD_SCOPED_FIELDS).

import { getSiteById } from '../store/read.js';

export const meta = {
  id: 'analytics-install',
  name: 'Analytics/Pixel Install Script Generator',
  description: 'Drafts the Google Analytics (GA4) or Meta/Facebook Pixel install script for a site missing it, using the site\'s own real tracking ID.',
  recommendationTags: [],
};

const PLACEHOLDER_NOTE = '[NEEDS INPUT — not verifiable from real site data]';

const PROVIDERS = {
  ga4: {
    label: 'Google Analytics (GA4)',
    // The column on `sites` holding this provider's real, configured ID.
    siteColumn: 'ga4_measurement_id',
    idPattern: /^G-[A-Z0-9]+$/i,
    idHint: 'a GA4 measurement ID (e.g. "G-XXXXXXXXXX")',
    script: (id) => `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>\n<script>\n  window.dataLayer = window.dataLayer || [];\n  function gtag(){dataLayer.push(arguments);}\n  gtag('js', new Date());\n  gtag('config', '${id}');\n</script>`,
  },
  'facebook-pixel': {
    label: 'Meta/Facebook Pixel',
    siteColumn: 'facebook_pixel_id',
    idPattern: /^\d{10,20}$/,
    idHint: 'a Facebook Pixel ID (a numeric ID, e.g. "123456789012345")',
    script: (id) => `<script>\n  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?\n  n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;\n  n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;\n  t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,\n  document,'script','https://connect.facebook.net/en_US/fbevents.js');\n  fbq('init', '${id}');\n  fbq('track', 'PageView');\n</script>`,
  },
};

// Returns the first ID that is real AND well-formed for this provider.
// Shape is validated here, not just presence: a wrong-shaped stored value
// must fall through to the placeholder gate exactly as a missing one does,
// rather than shipping a tracking script that silently collects nothing.
function firstValidId(candidates, idPattern) {
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed && idPattern.test(trimmed)) return trimmed;
  }
  return null;
}

// params: { provider: 'ga4' | 'facebook-pixel', trackingId?: string, page?: string }
export async function generate({ siteId, params }) {
  const { provider, trackingId, page } = params || {};
  const providerConfig = PROVIDERS[provider];
  if (!providerConfig) throw Object.assign(new Error(`provider must be one of: ${Object.keys(PROVIDERS).join(', ')}`), { status: 400 });

  // Site config first — see the header. A lookup failure must not turn a
  // working generation into an error: fall back to whatever params carry,
  // which is exactly the old behavior.
  let configuredId = null;
  if (siteId != null) {
    try {
      const site = await getSiteById(siteId);
      configuredId = site?.[providerConfig.siteColumn] ?? null;
    } catch {
      configuredId = null;
    }
  }

  const resolved = firstValidId([configuredId, trackingId], providerConfig.idPattern);
  const idValid = resolved !== null;
  const resolvedId = idValid ? resolved : PLACEHOLDER_NOTE;
  const placeholderFields = idValid ? [] : ['trackingId'];

  const script = idValid
    ? providerConfig.script(resolvedId)
    : `<!-- ${PLACEHOLDER_NOTE}: replace with ${providerConfig.idHint} before publishing -->`;

  return {
    content: { provider, page: page || null, trackingId: resolvedId, script, placeholderFields },
    summary: `${providerConfig.label} install script${idValid ? '' : ' (needs real tracking ID before it can publish)'}`,
  };
}

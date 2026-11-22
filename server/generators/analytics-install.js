// Pure, deterministic generator — no LLM call, nothing to ground beyond the
// two real inputs: which provider (trust-compliance.js's own tracker
// detection already tells us GA4/Facebook Pixel is genuinely absent) and the
// site's own real GA4 measurement ID / Pixel ID. That ID can never be
// invented (same no-fabrication rule as every other generator here) — if it
// genuinely does not exist anywhere (stored, passed in, or discoverable from the
// site's connected GA4 property's web data stream — lib/ga4-measurement-id.js),
// the generator refuses with a `needsInput` error that says exactly what is
// missing. It never emits a placeholder script (changed 2026-11-22).
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

import { safeMessage } from '../lib/errors.js';
import { getSiteById } from '../store/read.js';
import { ensureMeasurementId, needsInputMessage } from '../lib/ga4-measurement-id.js';
import { fetchHtml } from '../agents/lib/page-content.js';
import { detectTrackersInHtml } from '../agents/lib/site-trackers.js';
import { scanRepoForTracking } from '../lib/repo-tracking-scan.js';
import { discoverMeasurementId, isMeasurementId } from '../lib/ga4-measurement-id.js';
import { defaultBranchName, prTargetBranchName } from '../github/client.js';

export const meta = {
  id: 'analytics-install',
  name: 'Analytics/Pixel Install Script Generator',
  description: 'Drafts the Google Analytics (GA4) or Meta/Facebook Pixel install script for a site missing it, using the site\'s own real tracking ID.',
  recommendationTags: [],
};

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
export async function generate({ siteId, params, deps = {} }) {
  const { provider, trackingId, page } = params || {};
  const providerConfig = PROVIDERS[provider];
  if (!providerConfig) throw Object.assign(new Error(`provider must be one of: ${Object.keys(PROVIDERS).join(', ')}`), { status: 400 });

  // Site config first — see the header. A lookup failure must not turn a
  // working generation into an error: fall back to whatever params carry,
  // which is exactly the old behavior.
  let configuredId = null;
  let site = null;
  if (siteId != null) {
    try {
      site = await getSiteById(siteId);
      configuredId = site?.[providerConfig.siteColumn] ?? null;
    } catch {
      configuredId = null;
    }
  }

  let resolved = firstValidId([configuredId, trackingId], providerConfig.idPattern);

  // GA4 only: the measurement ID is not something a client has to type in. When the site's connected GA4 property has a web
  // data stream for this website, that stream carries it. Discovery never guesses and never creates a stream.
  let discovery = null;
  if (!resolved && provider === 'ga4' && site) {
    discovery = await (deps.ensureMeasurementId || ensureMeasurementId)(site);
    if (discovery.measurementId) resolved = discovery.measurementId;
  }

  // No real ID means no honest draft. A placeholder draft used to be produced here and then refused at the publish gate, which
  // looked like a generator failure and was retried every day. This is missing client input, said as such, once.
  if (!resolved) {
    const message = (provider === 'ga4' && needsInputMessage(discovery?.status))
      || (provider === 'ga4' && discovery?.status === 'unavailable' ? 'Google Analytics could not be reached to look up the measurement ID. This will be tried again.' : null)
      || `Needs input: ${providerConfig.label} needs ${providerConfig.idHint} for this project.`;
    throw Object.assign(new Error(message), {
      status: 422, userFacing: true, refusal: true, needsInput: discovery?.status !== 'unavailable',
      reason: discovery?.status === 'unavailable' ? 'ga4-lookup-unavailable' : `${provider}-id-missing`,
      temporary: discovery?.status === 'unavailable',
    });
  }

  const script = providerConfig.script(resolved);
  return {
    content: { provider, page: page || null, trackingId: resolved, script, placeholderFields: [], idSource: configuredId && firstValidId([configuredId], providerConfig.idPattern) ? 'site-config' : discovery?.measurementId ? 'discovered-from-ga4-stream' : 'params' },
    summary: `${providerConfig.label} install script`,
  };
}

// Re-checks the LIVE homepage before anything is drafted. Installing a second GA4 tag double-counts every pageview, so this is the
// duplicate-install guard, and it runs on every attempt, not only at detection time:
//   the provider's tracker is already on the page  -> already_resolved (closed only with this evidence; nothing is generated)
//   a tag manager container is on the page         -> needs_human: a container can fire GA4 at runtime, which static HTML cannot show,
//                                                     so adding a direct tag could duplicate it. Never guessed either way.
//   the page cannot be read                        -> still_valid (a failed check is not evidence either way)
export async function verifyCurrentState(rec, ctx = {}) {
  const provider = rec?.params?.provider;
  const label = provider === 'ga4' ? 'Google Analytics (GA4)' : provider === 'facebook-pixel' ? 'Meta/Facebook Pixel' : null;
  const page = rec?.params?.page || rec?.page;
  if (!label || !page) return { decision: 'still_valid', reason: 'nothing-to-check', evidence: null };
  let fetched;
  try { fetched = await (ctx.fetchHtml || fetchHtml)(page); } catch (err) { const { id } = safeMessage('analytics-install.verifyCurrentState', err, 'live check failed'); return { decision: 'still_valid', reason: 'live-check-failed', evidence: { error: `live check failed (ref: ${id})` } }; }
  if (!fetched?.ok) return { decision: 'still_valid', reason: 'live-check-failed', evidence: { error: String(fetched?.error || 'unreachable').slice(0, 120) } };
  const { trackersDetected, tagManagersDetected } = detectTrackersInHtml(fetched.html);
  if (trackersDetected.includes(label)) {
    return { decision: 'already_resolved', reason: `${provider}-already-installed`, evidence: { page, tracker: label, checkedAt: new Date().toISOString() } };
  }
  if (tagManagersDetected.length) {
    return {
      decision: 'needs_human', reason: 'tag-manager-present',
      evidence: { page, tagManagers: tagManagersDetected, message: `A tag manager (${tagManagersDetected.join(', ')}) is on this site and can load ${label} without it showing in the page source. Adding a second tag could double-count visits. Confirm in the tag manager whether ${label} is already set up there.` },
    };
  }
  // Absent from the live HTML is not absent from the site: a tag can be loaded at runtime (SuperRank's consent-gated loader) or live
  // in the repository on a page this check did not read (Zennly). So the repository is read too, at the branches a change would be
  // made against, and a duplicate is impossible by construction:
  //   the project's own measurement ID is already in the repo        -> already_resolved
  //   any other GA4 ID, gtag loader or GTM container is in the repo  -> needs_human (a second tag would double-count)
  //   the repo could not be read                                     -> needs_human (we never install blind)
  const site = ctx.site || null;
  if (!site?.repo_owner || !site?.repo_name) return { decision: 'still_valid', reason: 'tracker-absent-on-live-page', evidence: { page, repoChecked: false } };
  const refs = [defaultBranchName(site), prTargetBranchName(site)];
  const scan = await (ctx.scanRepo || scanRepoForTracking)(site, refs);
  if (!scan.ok) {
    return { decision: 'needs_human', reason: 'repo-unreadable', evidence: { page, message: `${label} was not found on the live page, but ${scan.error}, so an existing installation cannot be ruled out. Nothing is installed until a person confirms.` } };
  }
  const hits = scan.refs.flatMap((r) => r.hits.map((h) => ({ ...h, ref: r.ref })));
  if (!hits.length) return { decision: 'still_valid', reason: 'tracker-absent-on-live-page-and-in-repo', evidence: { page, refs } };
  let ownId = provider === 'ga4' && isMeasurementId(site.ga4_measurement_id) ? site.ga4_measurement_id.trim() : null;
  if (provider === 'ga4' && !ownId) {
    const found = await (ctx.discover || discoverMeasurementId)(site).catch(() => null); // read-only: lists streams, saves nothing
    if (found?.measurementId) ownId = found.measurementId;
  }
  const files = [...new Set(hits.map((h) => `${h.ref}:${h.path}`))].slice(0, 8);
  if (ownId && hits.some((h) => h.ga4.includes(ownId))) {
    return { decision: 'already_resolved', reason: `${provider}-already-in-repo`, evidence: { page, measurementId: ownId, files, checkedAt: new Date().toISOString() } };
  }
  return {
    decision: 'needs_human', reason: 'other-tracking-in-repo',
    evidence: { page, files, ga4: [...new Set(hits.flatMap((h) => h.ga4))].slice(0, 5), gtm: [...new Set(hits.flatMap((h) => h.gtm))].slice(0, 5), message: `The repository already loads Google tracking (${files.join(', ')}) that is not this project's own measurement ID. Adding ${label} could double-count visits; a person should confirm which tag is correct.` },
  };
}

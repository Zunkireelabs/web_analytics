// Triggers a client site's rebuild after CMS content was published.
//
// A Sanity-backed static-export site does not show a published document until
// the site rebuilds — the content is fetched by GROQ at BUILD time, so a
// successful mutation is not a live change. That is equally true today for an
// editor publishing by hand in Studio; the difference is only that Sanity's
// own outbound webhook fires for them, and nothing fires for a publish this
// app performs through the mutation API.
//
// ONE REBUILD PER BATCH, never per document. A rebuild is a full site build
// (next build --webpack, output: "export") plus a redeploy, so publishing five
// documents individually would queue five builds of the same site for changes
// that belong in one. The caller (routes/action-center.js's publish-cms route)
// publishes every draft first and calls this once afterwards.
//
// The request is SIGNED with the same HMAC scheme the receiver verifies
// (webhook/server.mjs in the client repo: sha256 over "<timestamp>.<body>",
// sent as `t=<unix>,v1=<hex>`). That receiver used to accept an unsigned or
// mis-signed request and rebuild anyway; it now rejects both, so this signs
// properly rather than relying on the hole. Timestamp is included because the
// receiver enforces a freshness window — an unsigned or stale trigger is an
// unauthenticated deploy trigger.
//
// Config lives in sites.url_file_map.siteRoot, alongside the other per-site
// deployment facts:
//
//   "siteRoot": {
//     "cmsRebuildWebhookUrl": "https://admizzeducation.com/webhook",
//     "cmsRebuildSecretEnvVar": "ADMIZZ_WEBHOOK_SECRET"
//   }
//
// The secret is an env var NAME, never a value, and there is no default —
// same fail-closed rule as server/sanity/credentials.js. A site with no
// rebuild configured returns {triggered:false} with a reason; it is not an
// error, because the change IS published and a later rebuild (a scheduled
// deploy, or an editor's next Studio publish) will carry it live. Reporting a
// rebuild that didn't happen would be the actual failure.

import { createHmac } from 'node:crypto';

const REBUILD_TIMEOUT_MS = 15_000;

export function rebuildConfig(site) {
  const root = site?.url_file_map?.siteRoot;
  return {
    url: root?.cmsRebuildWebhookUrl || null,
    secretEnvVar: root?.cmsRebuildSecretEnvVar || null,
  };
}

export async function triggerCmsRebuild(site) {
  const { url, secretEnvVar } = rebuildConfig(site);
  if (!url) return { triggered: false, reason: 'no-rebuild-webhook-configured' };
  if (!secretEnvVar) return { triggered: false, reason: 'no-rebuild-secret-configured' };

  const secret = process.env[secretEnvVar];
  if (!secret) {
    // Configured but missing in this environment — a deploy mistake, and it
    // must read like one rather than looking like an unconfigured feature.
    return { triggered: false, reason: 'rebuild-secret-missing', error: `Site ${site?.id ?? '?'} names ${secretEnvVar} for its rebuild secret, but that variable is not set here.` };
  }

  // The receiver logs _type only; the payload's job is to be a signed,
  // fresh, authentic trigger, not to carry instructions.
  const body = JSON.stringify({ _type: 'seoai.cmsPublish', siteId: site.id, triggeredAt: new Date().toISOString() });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REBUILD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'sanity-webhook-signature': `t=${timestamp},v1=${signature}` },
      body,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      return { triggered: false, reason: 'rebuild-request-failed', error: `Rebuild webhook returned ${res.status}: ${detail}` };
    }
    // The receiver responds as soon as it has queued the build; it does not
    // wait for the build to finish. So this reports that the rebuild was
    // ACCEPTED, which is all that is actually known at this point — claiming
    // the content is live would be asserting something unverified.
    return { triggered: true, acceptedAt: new Date().toISOString() };
  } catch (err) {
    if (err.name === 'AbortError') return { triggered: false, reason: 'rebuild-request-timeout', error: `Rebuild webhook did not respond within ${REBUILD_TIMEOUT_MS}ms` };
    return { triggered: false, reason: 'rebuild-request-failed', error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

import { Router } from 'express';
import { timingSafeEqual, createHmac } from 'node:crypto';
import { getSiteByRepo } from '../store/read.js';
import { listDraftsAwaitingPrCheck } from '../store/drafts.js';
import { checkDraftPrStatus } from './action-center.js';
import { updateSiteRepoConfig, clearGithubAppInstallation } from '../db.js';
import { recordAuditEvent } from '../store/admin/audit-log.js';

const router = Router();

// Shared HMAC-SHA256-over-the-raw-body check GitHub uses for every webhook
// flavor. Two distinct trust boundaries reuse this: a per-repo webhook
// (GITHUB_WEBHOOK_SECRET, verifySignature below) and the GitHub App's own
// single webhook covering every installation (GITHUB_APP_WEBHOOK_SECRET,
// verifyAppSignature below) — kept as separate secrets/functions rather than
// one shared value so a leaked repo-webhook secret can't be used to forge
// installation events, and vice versa.
// Exported for direct unit testing (webhooks.test.js) — this repo has no
// supertest/nock convention (see action-center-safe-fix-batch.test.js's own
// note), and this is the one piece of the file with no DB/network
// dependency, so it's tested directly rather than by driving real HTTP.
export function verifyWithSecret(secret, rawBody, signatureHeader) {
  if (!secret) return false; // fail closed if the operator never configured one
  if (!signatureHeader) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

// Public endpoint — GitHub calls this, not a logged-in user or an MCP
// client, so there's no session cookie and no bearer token. Authenticity is
// proven the way GitHub webhooks always are: an HMAC-SHA256 signature over
// the *raw* request body, keyed with a secret both sides know
// (GITHUB_WEBHOOK_SECRET, entered again when the webhook is created in the
// repo's GitHub settings). Must be mounted in index.js before any router
// with a blanket, unscoped `router.use(requireAuth)` — see index.js's mount
// order comment; same hazard mcpRouter and userInvitationsRouter avoid.
function verifySignature(rawBody, signatureHeader) {
  return verifyWithSecret(process.env.GITHUB_WEBHOOK_SECRET, rawBody, signatureHeader);
}

// Same idea, keyed with the GitHub App's own webhook secret instead — see
// GITHUB_APP_WEBHOOK_SECRET in .env.example.
function verifyAppSignature(rawBody, signatureHeader) {
  return verifyWithSecret(process.env.GITHUB_APP_WEBHOOK_SECRET, rawBody, signatureHeader);
}

// A synthetic req so recordAuditEvent's resolveActor(req) records this as a
// 'system' actor rather than throwing on a missing req.userId — same shape
// connect-repo.js's systemActorReq uses for the same reason (this webhook
// has no logged-in user either).
function systemActorReq(siteId) {
  return { userId: null, siteId, ip: null, get: () => null };
}

// Matches one GitHub repo full_name ("owner/repo") to a site and, if found,
// records or clears its App installation id. Returns the updated site, or
// null if no site's repo_owner/repo_name matches (a repo the App was
// installed on that this dashboard doesn't track — not an error, just
// nothing to do).
async function applyInstallationToRepo(fullName, installationId) {
  const [owner, name] = String(fullName || '').split('/');
  if (!owner || !name) return null;
  const site = await getSiteByRepo(owner, name);
  if (!site) return null;

  const updated = await updateSiteRepoConfig({ siteId: site.id, githubAppInstallationId: installationId });
  await recordAuditEvent(systemActorReq(site.id), {
    action: installationId === null ? 'tenant.github_app_installation_removed' : 'tenant.github_app_installation_recorded',
    targetType: 'site',
    targetId: String(site.id),
    tenantSiteId: site.id,
    tenantName: site.name,
    metadata: { repo: fullName, installationId },
    success: true,
  }).catch((err) => console.error(`[webhooks] could not record audit event for site ${site.id}:`, err.message));
  return updated;
}

// GitHub App installation lifecycle, replacing the manual "copy the
// installation id off the GitHub install callback, paste it into
// connect-repo.js" step (see .env.example's GitHub App section, step 5) —
// this listens on the App's own webhook (one config covers every
// installation, unlike the per-repo GITHUB_WEBHOOK_SECRET webhook above) and
// keeps sites.github_app_installation_id in sync automatically as clients
// install the App, add/remove repos from an existing install, or uninstall
// it entirely.
async function processInstallationEvent(event, payload) {
  const installation = payload.installation;
  if (!installation) return;

  if (event === 'installation') {
    if (payload.action === 'created') {
      // `repositories` is only present when the client chose "Only select
      // repositories" at install time — an "All repositories" install omits
      // it entirely, so there's genuinely nothing to auto-match here; the
      // manual connect-repo.js fallback still applies for that case.
      for (const repo of payload.repositories || []) {
        await applyInstallationToRepo(repo.full_name, installation.id).catch((err) =>
          console.error(`[webhooks] could not record installation for ${repo.full_name}:`, err.message)
        );
      }
    } else if (payload.action === 'deleted') {
      // Match by installation id, not by the payload's repo list (which,
      // same as above, is absent for "all repositories" installs) — this
      // way every site left pointing at the now-gone installation moves
      // back onto its PAT regardless of how the App was originally scoped.
      await clearGithubAppInstallation(installation.id).catch((err) =>
        console.error(`[webhooks] could not clear installation ${installation.id}:`, err.message)
      );
    }
  } else if (event === 'installation_repositories') {
    for (const repo of payload.repositories_added || []) {
      await applyInstallationToRepo(repo.full_name, installation.id).catch((err) =>
        console.error(`[webhooks] could not record installation for ${repo.full_name}:`, err.message)
      );
    }
    for (const repo of payload.repositories_removed || []) {
      const [owner, name] = String(repo.full_name || '').split('/');
      if (!owner || !name) continue;
      try {
        const site = await getSiteByRepo(owner, name);
        // Only clear if this site is still pointing at the installation the
        // event is about — guards against clobbering a later manual
        // reassignment (e.g. connect-repo.js run by hand in between).
        // String-compared: BIGINT columns come back from pg as strings.
        if (site && String(site.github_app_installation_id) === String(installation.id)) {
          await applyInstallationToRepo(repo.full_name, null);
        }
      } catch (err) {
        console.error(`[webhooks] could not clear installation for ${repo.full_name}:`, err.message);
      }
    }
  }
}

// Looks up the drafts waiting on this PR and runs checkDraftPrStatus for
// each. Deliberately NOT awaited by the route handler below — see its
// comment for why the response can't wait on this.
async function processPrClosed(repository, pr) {
  const site = await getSiteByRepo(repository.owner?.login, repository.name);
  if (!site) return;

  const drafts = await listDraftsAwaitingPrCheck(site.id, pr.number);
  for (const draft of drafts) {
    try {
      await checkDraftPrStatus(site.id, draft.id);
    } catch (err) {
      console.error(`[webhooks] check-pr-status failed for draft ${draft.id} (PR #${pr.number}):`, err.message);
    }
  }
}

// Replaces the manual "Check PR Status" click: when a batch branch's PR
// merges (or gets closed without merging) on GitHub, this fires instead of
// a human having to notice and go click it per draft. Reuses
// checkDraftPrStatus's exact logic (re-reads the PR from GitHub itself
// rather than trusting the payload as the only source of truth) so the
// automated and manual paths can never disagree about what "merged" means.
router.post('/webhooks/github', (req, res) => {
  if (!verifySignature(req.rawBody, req.headers['x-hub-signature-256'])) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Ack anything we don't act on (wrong event type, an action other than
  // "closed", or a repo we don't track) with 2xx — GitHub retries and
  // eventually disables a webhook that keeps returning non-2xx, and none of
  // these are actually errors on our end.
  if (req.headers['x-github-event'] !== 'pull_request') return res.status(204).end();

  const { action, pull_request: pr, repository } = req.body || {};
  if (action !== 'closed' || !pr || !repository) return res.status(204).end();

  // Ack the delivery immediately, then process in the background.
  // checkDraftPrStatus's success path (finalizeImplemented) can trigger
  // job.js's runSiteDiscoveryIfDue, a real site crawl that legitimately
  // takes far longer than GitHub's ~10s webhook delivery timeout — awaiting
  // it here meant every real merge event failed delivery outright (GitHub
  // marks it a failed delivery and gives up), silently falling back to the
  // hourly cron poll (job.js's runPrStatusPollForAllSites) for a status
  // update that should have been near-instant. Nothing downstream needs the
  // HTTP response to reflect the outcome — the manual "Check PR Status"
  // button and the cron poll already treat this as fire-and-forget work on
  // its own schedule.
  res.status(202).json({ ok: true, accepted: true });

  processPrClosed(repository, pr).catch((err) => {
    console.error(`[webhooks] processing PR #${pr.number} closed event failed:`, err.message);
  });
});

// GitHub App installation events — a separate route (and separate secret,
// GITHUB_APP_WEBHOOK_SECRET) from /webhooks/github above, since the App's
// webhook config is one global endpoint covering every client's
// installation rather than a per-repo one. See .env.example's GitHub App
// section and processInstallationEvent's own comment.
router.post('/webhooks/github-app', (req, res) => {
  if (!verifyAppSignature(req.rawBody, req.headers['x-hub-signature-256'])) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.headers['x-github-event'];
  if (event !== 'installation' && event !== 'installation_repositories') {
    return res.status(204).end();
  }

  // Ack immediately, same fire-and-forget reasoning as /webhooks/github
  // above — nothing downstream needs the HTTP response to reflect the
  // outcome, and each of these writes a single row.
  res.status(202).json({ ok: true, accepted: true });

  processInstallationEvent(event, req.body || {}).catch((err) => {
    console.error(`[webhooks] processing ${event} event failed:`, err.message);
  });
});

export default router;

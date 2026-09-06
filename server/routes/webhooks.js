import { Router } from 'express';
import { timingSafeEqual, createHmac } from 'node:crypto';
import { getSiteByRepo } from '../store/read.js';
import { listDraftsAwaitingPrCheck } from '../store/drafts.js';
import { checkDraftPrStatus } from './action-center.js';

const router = Router();

// Public endpoint — GitHub calls this, not a logged-in user or an MCP
// client, so there's no session cookie and no bearer token. Authenticity is
// proven the way GitHub webhooks always are: an HMAC-SHA256 signature over
// the *raw* request body, keyed with a secret both sides know
// (GITHUB_WEBHOOK_SECRET, entered again when the webhook is created in the
// repo's GitHub settings). Must be mounted in index.js before any router
// with a blanket, unscoped `router.use(requireAuth)` — see index.js's mount
// order comment; same hazard mcpRouter and userInvitationsRouter avoid.
function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return false; // fail closed if the operator never configured one
  if (!signatureHeader) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
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

export default router;

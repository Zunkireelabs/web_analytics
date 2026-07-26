import { z } from 'zod';
import { approveAndPublishDraft, pushDraftBranch, openDraftPr, checkDraftPrStatus } from '../../routes/action-center.js';
import { jsonResult, requireLevel, withErrorHandling } from './shared.js';

// "Automation" tier tools — the line is "interacts with an external system"
// (GitHub, and in future WordPress/Shopify/Slack/Cloudflare/etc.), not just
// "writes data." Every tool here pushes a real branch and/or opens a real
// PR against a client's actual GitHub repo. approve_draft in particular
// auto-cascades into both in one call whenever the site has a repo
// connected — same behavior the dashboard's "Approve" button has today,
// just now reachable from an AI client holding an `automation`-tier token.
//
// rollback_draft is deliberately NOT here: unlike these four, it merges
// directly to `stage` with no PR/review step in between — an infrequent,
// high-impact recovery operation the product owner wants kept
// dashboard-only for now, not exposed to an AI client even at this tier.
export function registerAutomationTools(server, siteId, permissionLevel) {
  server.registerTool('approve_draft', {
    description: 'Approves a submitted draft. If the site has a GitHub repo connected, this automatically pushes a real branch and opens a real PR against main in the same call — there is no separate confirmation step.',
    inputSchema: { id: z.number().int(), renderMode: z.string().optional() },
  }, withErrorHandling('approve_draft', async ({ id, renderMode }) => {
    const denied = requireLevel(permissionLevel, 'automation'); if (denied) return denied;
    return jsonResult(await approveAndPublishDraft(siteId, id, { renderMode }));
  }));

  server.registerTool('push_draft_branch', {
    description: 'Pushes a real branch for an approved draft (forked from stage). Manual retry path for when approve_draft\'s auto-push failed; not needed on the normal path.',
    inputSchema: { id: z.number().int(), renderMode: z.string().optional() },
  }, withErrorHandling('push_draft_branch', async ({ id, renderMode }) => {
    const denied = requireLevel(permissionLevel, 'automation'); if (denied) return denied;
    return jsonResult(await pushDraftBranch(siteId, id, { renderMode }));
  }));

  server.registerTool('open_draft_pr', {
    description: 'Opens a real GitHub PR from an already-pushed branch into main. Manual retry path for when approve_draft\'s auto-PR failed; not needed on the normal path. Never merges anything.',
    inputSchema: { id: z.number().int() },
  }, withErrorHandling('open_draft_pr', async ({ id }) => {
    const denied = requireLevel(permissionLevel, 'automation'); if (denied) return denied;
    return jsonResult(await openDraftPr(siteId, id));
  }));

  server.registerTool('check_pr_status', {
    description: "Reads a draft's PR state live from GitHub. If GitHub reports it merged, finalizes the draft as implemented (this is how the app learns a PR was merged — there is no webhook).",
    inputSchema: { id: z.number().int() },
  }, withErrorHandling('check_pr_status', async ({ id }) => {
    const denied = requireLevel(permissionLevel, 'automation'); if (denied) return denied;
    return jsonResult(await checkDraftPrStatus(siteId, id));
  }));
}

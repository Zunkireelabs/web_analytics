import { z } from 'zod';
import { runAgent } from '../../agents/runner.js';
import { refreshCommandCenter } from '../../routes/command-center.js';
import { refreshRecommendations, generateDraft, markDraftImplementedIfEligible } from '../../routes/action-center.js';
import { updateDraft, deleteDraft, submitDraftForApproval } from '../../store/drafts.js';
import { deliverToAllChannels } from '../../notifications/channels/index.js';
import { dateStr, jsonResult, requireLevel, withErrorHandling } from './shared.js';

// "AI Actions" tier tools — spend LLM/API budget and write to this app's own
// database, but never touch GitHub (no branch pushes, no PRs). Everything
// here wraps the exact same function the equivalent session-authed HTTP
// route calls, so the two surfaces can never drift apart — see
// refreshCommandCenter/refreshRecommendations/generateDraft's own comments
// for why those three needed extracting out of their route handlers first.
//
// approve_draft, push_draft_branch, open_draft_pr, and check_pr_status are
// deliberately NOT here — they call GitHub, so they belong in the
// `automation` tier (server/mcp/tools/automation.js). mark_draft_implemented
// IS here despite being part of the same publish lifecycle: it only flips
// internal status + best-effort local site discovery, no external call, so
// it doesn't cross the automation boundary (defined as "touches an external
// system" — see automation.js's own comment). rollback_draft is excluded
// from MCP entirely for now — infrequent, high-impact recovery, dashboard-
// only until a future phase.
export function registerAiActionsTools(server, siteId, permissionLevel) {
  server.registerTool('run_agent', {
    description: 'Runs one growth agent fresh for this site and persists the result. Spends LLM/API budget; may take several seconds.',
    inputSchema: { agentId: z.string().min(1), start: dateStr.optional(), end: dateStr.optional(), params: z.record(z.any()).optional() },
  }, withErrorHandling('run_agent', async ({ agentId, start, end, params }) => {
    const denied = requireLevel(permissionLevel, 'ai_actions'); if (denied) return denied;
    return jsonResult(await runAgent(agentId, { siteId, start, end, params }));
  }));

  server.registerTool('refresh_command_center', {
    description: 'Re-runs the primary growth agents fresh for a date range and rebuilds Command Center data (findings, opportunities, executive narrative). Spends LLM/API budget; takes several seconds.',
    inputSchema: { start: dateStr, end: dateStr },
  }, withErrorHandling('refresh_command_center', async ({ start, end }) => {
    const denied = requireLevel(permissionLevel, 'ai_actions'); if (denied) return denied;
    return jsonResult(await refreshCommandCenter(siteId, { start, end }));
  }));

  server.registerTool('refresh_recommendations', {
    description: 'Re-runs the recommendation-bearing agents fresh for a date range and rebuilds Action Center recommendations. Spends LLM/API budget; takes several seconds.',
    inputSchema: { start: dateStr, end: dateStr },
  }, withErrorHandling('refresh_recommendations', async ({ start, end }) => {
    const denied = requireLevel(permissionLevel, 'ai_actions'); if (denied) return denied;
    return jsonResult(await refreshRecommendations(siteId, { start, end }));
  }));

  server.registerTool('generate_draft', {
    description: 'Runs one Action Center generator and persists the result as a new draft. Idempotent per findingId — a repeat call for the same finding returns the existing draft instead of creating a duplicate.',
    inputSchema: {
      generatorId: z.string().min(1),
      params: z.record(z.any()).optional(),
      source: z.string().optional(),
      findingId: z.union([z.string(), z.number()]).optional(),
    },
  }, withErrorHandling('generate_draft', async ({ generatorId, params, source, findingId }) => {
    const denied = requireLevel(permissionLevel, 'ai_actions'); if (denied) return denied;
    return jsonResult(await generateDraft(siteId, { generatorId, params, source, findingId }));
  }));

  server.registerTool('update_draft', {
    description: "Edits a draft's content. Only valid before approval (status draft or edited).",
    inputSchema: { id: z.number().int(), content: z.record(z.any()) },
  }, withErrorHandling('update_draft', async ({ id, content }) => {
    const denied = requireLevel(permissionLevel, 'ai_actions'); if (denied) return denied;
    const draft = await updateDraft(siteId, id, { content });
    if (!draft) return { isError: true, content: [{ type: 'text', text: 'Draft not found, or not in an editable state.' }] };
    return jsonResult(draft);
  }));

  server.registerTool('delete_draft', {
    description: 'Permanently deletes a draft.',
    inputSchema: { id: z.number().int() },
  }, withErrorHandling('delete_draft', async ({ id }) => {
    const denied = requireLevel(permissionLevel, 'ai_actions'); if (denied) return denied;
    const ok = await deleteDraft(siteId, id);
    if (!ok) return { isError: true, content: [{ type: 'text', text: 'Draft not found.' }] };
    return jsonResult({ ok: true });
  }));

  server.registerTool('submit_draft', {
    description: 'Submits a draft for approval (draft/edited -> submitted_for_approval). Does not touch GitHub.',
    inputSchema: { id: z.number().int() },
  }, withErrorHandling('submit_draft', async ({ id }) => {
    const denied = requireLevel(permissionLevel, 'ai_actions'); if (denied) return denied;
    const draft = await submitDraftForApproval(siteId, id);
    if (!draft) return { isError: true, content: [{ type: 'text', text: 'Draft not found, or not in a submittable state.' }] };
    return jsonResult(draft);
  }));

  server.registerTool('mark_draft_implemented', {
    description: 'Manual escape hatch: marks an already-approved draft implemented without a GitHub merge. Only needed for a draft type with no real merge strategy — every normal generator type auto-completes to implemented once its PR is confirmed merged (see check_pr_status in the automation tier).',
    inputSchema: { id: z.number().int() },
  }, withErrorHandling('mark_draft_implemented', async ({ id }) => {
    const denied = requireLevel(permissionLevel, 'ai_actions'); if (denied) return denied;
    return jsonResult(await markDraftImplementedIfEligible(siteId, id));
  }));

  server.registerTool('push_predictive_alert', {
    description: 'Pushes one or more real predictive-risk alerts (e.g. a metric forecast to decline) through this app\'s existing notification channels (in-app + email, if SMTP is configured). Intended for the Data Analyst Agent\'s nightly forecast-risk detection — never invents an alert; every field must reflect a real computed finding.',
    inputSchema: {
      alerts: z.array(z.object({
        severity: z.enum(['high', 'medium']),
        title: z.string().min(1),
        body: z.string().min(1),
      })).min(1),
    },
  }, withErrorHandling('push_predictive_alert', async ({ alerts }) => {
    const denied = requireLevel(permissionLevel, 'ai_actions'); if (denied) return denied;
    const events = alerts.map((a) => ({ type: 'predictive-risk', severity: a.severity, title: a.title, body: a.body, findingIds: [] }));
    await deliverToAllChannels(siteId, events);
    return jsonResult({ delivered: events.length });
  }));
}

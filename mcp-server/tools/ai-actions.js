import { z } from 'zod';
import { runAgent } from '../../server/agents/runner.js';
import { refreshCommandCenter } from '../../server/routes/command-center.js';
import { refreshRecommendations, generateDraft, markDraftImplementedIfEligible } from '../../server/routes/action-center.js';
import { updateDraft, deleteDraft, submitDraftForApproval } from '../../server/store/drafts.js';
import { deliverToAllChannels } from '../../server/notifications/channels/index.js';
import { updateKeywordGapStatus, saveSiteProfile, saveKeywordClusters, saveKeywordGaps } from '../../server/store/data-analyst.js';
import { createActionCenterRecommendationForGap } from '../../server/agents/lib/analyst-seo-mapping.js';
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
// `automation` tier (mcp-server/tools/automation.js). mark_draft_implemented
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

  server.registerTool('generate_geo_audit', {
    description: 'Runs the GEO audit generator for this site — produces an AI visibility score, per-page findings, and prioritized fix list mapped to generators. Uses the last 14 days of GSC data by default.',
    inputSchema: { daysBack: z.number().int().positive().optional(), topN: z.number().int().positive().optional() },
  }, withErrorHandling('generate_geo_audit', async ({ daysBack, topN }) => {
    const denied = requireLevel(permissionLevel, 'ai_actions'); if (denied) return denied;
    const params = {};
    if (daysBack != null) params.daysBack = daysBack;
    if (topN != null) params.topN = topN;
    return jsonResult(await generateDraft(siteId, { generatorId: 'geo-audit', params, source: 'mcp' }));
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
    if (!ok) return { isError: true, content: [{ type: 'text', text: 'Draft not found, or already implemented (an implemented draft is the audit record of a real shipped change and can\'t be discarded).' }] };
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

  server.registerTool('update_keyword_gap_status', {
    description: 'Staff review action on a keyword gap: approve it (queues it as a real content opportunity, entering the Action Center as a recommendation) or reject it (not worth pursuing, no Action Center effect).',
    inputSchema: { gapId: z.number().int(), status: z.enum(['approved', 'rejected']) },
  }, withErrorHandling('update_keyword_gap_status', async ({ gapId, status }) => {
    const denied = requireLevel(permissionLevel, 'ai_actions'); if (denied) return denied;
    const gap = await updateKeywordGapStatus(siteId, gapId, status);
    if (!gap) return { isError: true, content: [{ type: 'text', text: 'Keyword gap not found.' }] };
    // Same shared path server/routes/keywords.js's PUT route uses — approval
    // behaves identically regardless of which entry point (Analyst page or
    // MCP) a caller used. See createActionCenterRecommendationForGap's own
    // comment for why this is Gate 1 only, never a merge/publish action.
    const actionCenter = status === 'approved' ? await createActionCenterRecommendationForGap(siteId, gap) : null;
    return jsonResult({ ...gap, actionCenter });
  }));

  server.registerTool('save_site_profile', {
    description: "Saves the Data Analyst Agent's inferred site profile (industry, main topics, site type) from a fresh clustering run — the current-state row for this site, upserted. Never invents a profile not evidenced by real search queries.",
    inputSchema: {
      industry: z.string().min(1),
      mainTopics: z.array(z.string()).default([]),
      siteType: z.enum(['service', 'product', 'ecommerce', 'education']).nullable().optional(),
    },
  }, withErrorHandling('save_site_profile', async ({ industry, mainTopics, siteType }) => {
    const denied = requireLevel(permissionLevel, 'ai_actions'); if (denied) return denied;
    await saveSiteProfile(siteId, { industry, mainTopics, siteType: siteType ?? null });
    return jsonResult({ ok: true });
  }));

  server.registerTool('save_keyword_clusters', {
    description: "Saves a fresh run's semantic keyword clusters (grouped from this site's own real GSC queries). Append-only per run, same convention as forecast_runs — each call adds a new snapshot rather than overwriting the previous one.",
    inputSchema: {
      clusters: z.array(z.object({
        clusterName: z.string().min(1),
        clusterType: z.enum(['service', 'product', 'general']),
        keywords: z.array(z.object({ keyword: z.string(), impressions: z.number(), avgPosition: z.number().nullable().optional() })),
        avgImpressions: z.number(),
        avgPosition: z.number().nullable().optional(),
        gapScore: z.number().default(0),
      })),
    },
  }, withErrorHandling('save_keyword_clusters', async ({ clusters }) => {
    const denied = requireLevel(permissionLevel, 'ai_actions'); if (denied) return denied;
    await saveKeywordClusters(siteId, clusters.map((c) => ({
      ...c, keywords: c.keywords.map((k) => ({ keyword: k.keyword, impressions: k.impressions, avg_position: k.avgPosition ?? null })),
    })));
    return jsonResult({ saved: clusters.length });
  }));

  server.registerTool('save_keyword_gaps', {
    description: "Saves newly identified zero-coverage keyword topics as pending_review gaps — a human-review queue, never auto-applied. 'source' distinguishes the clustering-based pass from external keyword research.",
    inputSchema: {
      gaps: z.array(z.object({ topic: z.string().min(1), reason: z.string().nullable().optional(), priority: z.enum(['high', 'medium', 'low']).default('medium') })),
      source: z.enum(['internal_analysis', 'claude_research']).default('internal_analysis'),
    },
  }, withErrorHandling('save_keyword_gaps', async ({ gaps, source }) => {
    const denied = requireLevel(permissionLevel, 'ai_actions'); if (denied) return denied;
    await saveKeywordGaps(siteId, gaps, source);
    return jsonResult({ saved: gaps.length });
  }));
}

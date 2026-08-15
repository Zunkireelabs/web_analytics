import { listFindings, listUnresolved, confirmFinding, summarize } from '../store/site-understanding.js';
import { getSiteById } from '../store/read.js';
import { getLatestAgentRuns, getRecentActivity } from '../store/agent-runs.js';
import { buildRecommendations } from '../agents/lib/recommendations.js';
import { runDiscovery } from '../discovery/run-discovery.js';
import { listOpenRecommendations } from '../store/recommendations.js';
import { summarizeAutonomy } from '../agents/lib/autonomy-decision.js';
import { autoRemediateSafeRecommendations } from '../agents/lib/auto-remediation.js';
import { callDataAnalystAgent } from '../lib/data-analyst-client.js';
import { answerQuestion } from '../agents/lib/copilot.js';
import { createConversation, getConversation, getRecentMessages, saveMessage } from '../store/copilot.js';
import { query } from '../db.js';

// The Assistant's entire surface for touching the system (Phase 3, §9/§21).
//
// Two properties make this a capability registry rather than a prompt with a
// database attached:
//
//  1. siteId is NEVER a parameter. It is bound from the authenticated session
//     by the caller and closed over here, so no model output — however it is
//     phrased or manipulated — can address another tenant's data. §19 calls
//     cross-client leakage a hard requirement; making the identifier
//     unreachable from the model is the only way to enforce that structurally
//     rather than by asking the model nicely.
//
//  2. Every capability declares the role it needs, checked in one place
//     before the handler runs (§20). A capability the caller may not use is
//     not offered and not executed, so "the user asked" can never become
//     authority the user does not have.
//
// Business logic lives in the services these call. Nothing here re-implements
// discovery, configuration, or recommendation logic (§1/§26).

// Ordered least→most privileged. tenant_member may read; changing
// configuration or invoking agents requires an admin.
const ROLE_RANK = { tenant_member: 1, tenant_admin: 2, platform_admin: 3 };

export function roleAllows(actualRole, requiredRole) {
  return (ROLE_RANK[actualRole] || 0) >= (ROLE_RANK[requiredRole] || 0);
}

// Each entry: { description, requiredRole, run(ctx, args) }.
// `ctx` carries { siteId, userId, role } resolved server-side from the session.
export const CAPABILITIES = {
  get_onboarding_status: {
    description: "Current onboarding state for this site: what is ready, what is blocked, what needs a human decision.",
    requiredRole: 'tenant_member',
    run: async (ctx) => {
      const [site, summary] = await Promise.all([getSiteById(ctx.siteId), summarize(ctx.siteId)]);
      return {
        site: { name: site?.name, domain: site?.website_domain, repoConnected: !!(site?.repo_owner && site?.repo_name) },
        categories: summary,
      };
    },
  },

  list_unresolved_decisions: {
    description: "Only the items genuinely needing a human decision — never the whole configuration.",
    requiredRole: 'tenant_member',
    run: async (ctx) => {
      const rows = await listUnresolved(ctx.siteId);
      return rows.map((r) => ({
        id: r.id, category: r.category, subject: r.subject,
        finding: r.finding, evidence: r.evidence,
        confidence: Number(r.confidence), risk: r.risk,
      }));
    },
  },

  get_site_understanding: {
    description: 'Everything discovery has established about this site, with evidence.',
    requiredRole: 'tenant_member',
    run: async (ctx, { category = null } = {}) => {
      const rows = await listFindings(ctx.siteId, { category });
      return rows.map((r) => ({
        category: r.category, subject: r.subject, status: r.status,
        confidence: Number(r.confidence), risk: r.risk, evidence: r.evidence, finding: r.finding,
      }));
    },
  },

  run_discovery: {
    description: "Inspect the repository and auto-configure what can be proven. Inspection only — never modifies the client's repository.",
    requiredRole: 'tenant_admin',
    run: async (ctx, _args, deps = {}) => {
      const site = await getSiteById(ctx.siteId);
      if (!site?.repo_owner) return { ok: false, reason: 'no-repo-configured' };
      const result = await runDiscovery(site, deps.discoveryOptions || {});
      return {
        ok: result.ok,
        fileCount: result.fileCount,
        framework: result.technology?.framework?.id ?? null,
        routesResolved: result.routes?.routes?.length ?? 0,
        routeFamilies: result.routes?.families?.length ?? 0,
        pageTypes: result.structure?.pageTypes?.length ?? 0,
        autoConfigured: result.autoConfigured?.applied ?? 0,
        autoConfiguredDetail: (result.autoConfigured?.results || []).filter((r) => r.applied),
        summary: result.summary,
      };
    },
  },

  confirm_decision: {
    description: 'Record a human decision on an unresolved item, then apply and validate it.',
    requiredRole: 'tenant_admin',
    run: async (ctx, { findingId, accepted = true, chosen = null } = {}) => {
      if (!findingId) return { ok: false, reason: 'findingId is required' };
      // Re-read scoped to THIS site: a findingId is a plain integer and must
      // never be usable to reach into another tenant's row.
      const { rows } = await query('SELECT * FROM site_understanding WHERE id = $1 AND site_id = $2', [findingId, ctx.siteId]);
      if (!rows[0]) return { ok: false, reason: 'not-found-for-this-site' };

      const saved = await confirmFinding(findingId, { userId: ctx.userId, accepted, chosen });
      return { ok: true, id: saved.id, subject: saved.subject, status: saved.status, chosen: saved.finding?.chosen ?? null };
    },
  },

  get_agent_status: {
    description: 'Recent autonomous agent activity and the outcome of the latest runs.',
    requiredRole: 'tenant_member',
    run: async (ctx) => {
      const activity = await getRecentActivity(ctx.siteId, null, 10).catch(() => []);
      return { recent: activity };
    },
  },

  get_failures: {
    description: 'Recent failed jobs with their structured Phase 1 classification.',
    requiredRole: 'tenant_member',
    run: async (ctx) => {
      const { rows } = await query(
        `SELECT id, kind, status, finished_at, result
         FROM execution_jobs
         WHERE site_id = $1 AND status = 'failed'
         ORDER BY id DESC LIMIT 5`,
        [ctx.siteId]
      );
      return rows.map((r) => ({
        jobId: r.id, kind: r.kind, finishedAt: r.finished_at,
        // The structured classification worker.js persists. Absent on jobs
        // that predate Phase 1 — reported as null rather than invented.
        failure: r.result?.failure ?? null,
      }));
    },
  },

  get_autonomy_summary: {
    description: 'Which open recommendations are safe to auto-execute, need human review, or are rejected — and why.',
    requiredRole: 'tenant_member',
    run: async (ctx) => {
      const recs = await listOpenRecommendations(ctx.siteId);
      return summarizeAutonomy(recs);
    },
  },

  run_safe_remediation: {
    description: "Run the existing autonomous find-decide-act-validate-PR loop for this site's safe-tier recommendations. Ends at an open pull request; never merges.",
    requiredRole: 'tenant_admin',
    run: async (ctx) => {
      // Calls the SAME function the daily cron calls (job.js's
      // runAutoRemediationForAllSites) — the Assistant is a manual trigger
      // for it, not a second implementation of it (§1/§26).
      return autoRemediateSafeRecommendations(ctx.siteId);
    },
  },

  get_pending_approvals: {
    description: 'Recommendations awaiting human approval in the Action Center.',
    requiredRole: 'tenant_member',
    run: async (ctx) => {
      const built = await buildRecommendations(ctx.siteId).catch(() => ({ items: [] }));
      const items = built.items || [];
      return {
        total: items.length,
        blocked: items.filter((i) => i.blockedReason).length,
        actionable: items.filter((i) => !i.blockedReason).length,
        // Deliberately a count-and-sample, not the full set: the Assistant
        // summarises and links to the Action Center rather than becoming a
        // second place to work through recommendations (§26).
        sample: items.slice(0, 5).map((i) => ({ id: i.id, tag: i.tag, page: i.params?.page ?? null, blocked: !!i.blockedReason })),
      };
    },
  },

  // Every role. The Assistant's deterministic intents above only cover
  // onboarding/decisions/agent-activity — a real question about the site's
  // data itself ("why did traffic drop", "which pages have wins") needs the
  // findings-routing engine this app already had (server/agents/lib/
  // copilot.js's answerQuestion, formerly the standalone "Growth Copilot"
  // widget). Reused here rather than reimplemented: same LLM intent
  // classification across the real agent catalog, same cached-vs-fresh
  // orchestration, same cited-evidence + Generate Draft output.
  //
  // Unlike every other capability, this one manages its own conversation
  // (server/store/copilot.js) because answerQuestion's synthesis quality
  // depends on real turn history, not a single message in isolation — the
  // Assistant's other capabilities are stateless by design because they
  // re-read live system state instead.
  ask_growth_copilot: {
    description: "Ask a free-form question about this site's own data — traffic, findings, wins, why something changed — answered with cited evidence from the real agent findings.",
    requiredRole: 'tenant_member',
    run: async (ctx, { message, conversationId } = {}) => {
      if (!message) return { ok: false, reason: 'message is required' };
      let convo = conversationId ? await getConversation(ctx.siteId, conversationId) : null;
      if (!convo) convo = await createConversation(ctx.siteId, message.slice(0, 80));

      const history = await getRecentMessages(convo.id, 8);
      await saveMessage(convo.id, 'user', message);

      const result = await answerQuestion({ siteId: ctx.siteId, conversationId: convo.id, message, history, userId: ctx.userId });
      return { conversationId: convo.id, answer: result.answer, citedFindings: result.citedFindings, followUps: result.followUps };
    },
  },

  // Admin-only. Proxies to the standalone data-analyst-agent service for
  // statistical/forecasting questions (traffic trends, anomalies, keyword
  // opportunities) — everything the operational capabilities above cannot
  // answer, since they only read this app's own onboarding/recommendation
  // state. requiredRole platform_admin (not tenant_admin) because this is
  // the same staff-only surface the old /analyst page's chat used
  // (server/routes/dataAnalyst.js), just reached through the Assistant now
  // instead of a second chat widget.
  ask_analyst_data: {
    description: "Ask the statistical/forecasting analyst agent a free-form question about this site's performance data (traffic, keywords, anomalies).",
    requiredRole: 'platform_admin',
    run: async (ctx, { question } = {}) => {
      if (!question) return { ok: false, reason: 'question is required' };
      const result = await callDataAnalystAgent(`/ask/${ctx.siteId}`, { method: 'POST', body: { question } });
      return { answer: result.answer, toolCalls: result.tool_calls || [] };
    },
  },
};

// Single execution path: authorization, then the handler. Returning a typed
// refusal (rather than throwing) lets the Assistant explain what is required
// instead of surfacing an error, which is the §20 behaviour — "I can prepare
// this, but your permissions do not allow me to execute it."
export async function invokeCapability(name, ctx, args = {}, deps = {}) {
  const capability = CAPABILITIES[name];
  if (!capability) return { ok: false, error: 'unknown-capability', name };

  if (!roleAllows(ctx.role, capability.requiredRole)) {
    return {
      ok: false,
      error: 'not-authorized',
      name,
      requiredRole: capability.requiredRole,
      actualRole: ctx.role,
      // What the user would need, so the refusal is actionable rather than a
      // dead end.
      remedy: `This action requires the ${capability.requiredRole} role; your account is ${ctx.role || 'unauthenticated'}.`,
    };
  }

  const data = await capability.run(ctx, args, deps);
  return { ok: true, name, data };
}

// The catalogue a caller may actually use, filtered by role. Capabilities the
// user cannot invoke are not advertised, so the Assistant never offers an
// action it would then have to refuse.
export function capabilitiesFor(role) {
  return Object.entries(CAPABILITIES)
    .filter(([, c]) => roleAllows(role, c.requiredRole))
    .map(([id, c]) => ({ id, description: c.description, requiredRole: c.requiredRole }));
}

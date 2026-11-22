import { query } from '../db.js';
import { listUnresolved } from '../store/site-understanding.js';
import { getLatestAgentRunSummaries } from '../store/agent-runs.js';
import { getGoogleConnection } from '../store/project-google.js';
import { getPosthogConnectionState } from '../store/project-posthog.js';
import { listAgentMeta } from '../agents/registry.js';
import { inDraftScope } from '../lib/draft-scope.js';

// Everything for ONE site that is waiting on a person, in one list: approvals to give, issues the agents found, and
// decisions they cannot make alone. It is computed from the real records every time (drafts, stage_promotions, agent
// runs, site_understanding), never stored as a separate to-do list, so an item disappears the moment its record is
// resolved. The assistant's opening message and its "what did you find?" answer both read this one function.
//
// siteId is always the caller's own: nothing here accepts another site's id from a request.

export const KIND = { APPROVAL: 'approval', ISSUE: 'issue', DECISION: 'decision' };

const WAITING_FOR_APPROVAL = new Set(['draft', 'edited', 'submitted_for_approval']);
const DAY = 86_400_000;
export const OVERDUE_AFTER_DAYS = 2;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const ageDays = (at, now) => (at ? Math.max(0, Math.floor((now - new Date(at).getTime()) / DAY)) : 0);

// Pure: raw rows in, ordered items out. `now` is passed in so it is testable.
export function buildNeedsYou({ drafts = [], stagePromotions = [], agentRuns = [], unresolved = [], connections = [], stageBranch = null, now = Date.now() } = {}) {
  const items = [];

  // The agent's own pull requests into STAGE that are open and waiting for the person's word. The person answers in conversation ("looks
  // good, go ahead"); see assistant/approval-chat.js. One item per PR so a reply can name it. Never main: that PR is merged by a person on GitHub.
  if (stageBranch) {
    const byPr = new Map();
    for (const d of drafts.filter((x) => x.status === 'pr_opened' && x.pr_number && x.pr_base_branch === stageBranch && x.pr_state !== 'closed')) {
      const e = byPr.get(d.pr_number) || { pr: d.pr_number, url: d.pr_url, types: new Set(), count: 0, created: d.created_at };
      e.types.add(d.action_type); e.count += 1; byPr.set(d.pr_number, e);
    }
    for (const e of byPr.values()) {
      items.push({
        key: `approval:stage-pr:${e.pr}`, kind: KIND.APPROVAL, blocksShipping: false, prNumber: e.pr,
        title: `Ready to merge to stage: pull request #${e.pr} (${plural(e.count, 'change', 'changes')})`,
        detail: `${[...e.types].slice(0, 5).join(', ')}. Tell me to go ahead and I will merge it to ${stageBranch} once the checks pass, then open the pull request to main for you.`,
        ageDays: ageDays(e.created, now), count: e.count,
        actions: [{ id: 'merge_stage_pr', label: 'Go ahead', pr: e.pr }], link: e.url || null,
      });
    }
  }

  // Waiting for approval, one item per page it belongs to: fixes are reviewed in Action Center, writing (blog posts, landing pages,
  // translations) in Content. Each item's Review button goes to its own page. There is no "approve all" here: approving a draft is
  // done on the draft itself, where the client can see the page first.
  const waiting = drafts.filter((d) => WAITING_FOR_APPROVAL.has(d.status));
  for (const [scope, link, one, many] of [['fixes', '/action-center', 'fix is', 'fixes are'], ['content', '/content?view=review', 'piece of content is', 'pieces of content are']]) {
    const mine = waiting.filter((d) => inDraftScope(d.action_type, scope));
    if (!mine.length) continue;
    const oldest = Math.min(...mine.map((d) => new Date(d.created_at).getTime()));
    items.push({
      key: `approval:${scope}`, kind: KIND.APPROVAL, blocksShipping: false, scope,
      title: `${plural(mine.length, one, many)} waiting for your approval`,
      detail: [...new Set(mine.map((d) => d.action_type))].slice(0, 5).join(', '),
      ageDays: ageDays(oldest, now), count: mine.length, ids: mine.map((d) => d.id),
      actions: [{ id: 'review_drafts', label: 'Review' }],
      link,
    });
  }

  for (const p of stagePromotions.filter((s) => s.status === 'opened' && s.promotion_pr_url)) {
    items.push({
      key: `approval:main:${p.source_pr_number}`, kind: KIND.APPROVAL, blocksShipping: false,
      title: 'Verified on stage: ready for your approval to go live',
      detail: `The pull request to main is open (#${p.promotion_pr_number}).`,
      ageDays: ageDays(p.updated_at || p.created_at, now), count: 1,
      actions: [{ id: 'approve_main', label: 'Approve for main', pr: p.promotion_pr_number }],
      link: p.promotion_pr_url,
    });
  }

  const stuck = drafts.filter((d) => d.apply_error && !['implemented', 'abandoned'].includes(d.status));
  if (stuck.length) {
    items.push({
      key: 'issue:stuck-drafts', kind: KIND.ISSUE, blocksShipping: true,
      title: `${plural(stuck.length, 'change', 'changes')} could not be applied`,
      detail: String(stuck[0].apply_error).slice(0, 160),
      ageDays: ageDays(stuck[0].created_at, now), count: stuck.length, ids: stuck.map((d) => d.id),
      actions: [{ id: 'review_drafts', label: 'Look at it' }], link: '/action-center',
    });
  }

  const closed = drafts.filter((d) => d.pr_state === 'closed' && d.status === 'pr_opened');
  if (closed.length) {
    items.push({
      key: 'issue:closed-prs', kind: KIND.ISSUE, blocksShipping: true,
      title: `${plural(closed.length, 'pull request was', 'pull requests were')} closed without merging`,
      detail: 'The change did not go live. It can be re-opened from the Action Center.',
      ageDays: ageDays(closed[0].created_at, now), count: closed.length, ids: closed.map((d) => d.id),
      actions: [{ id: 'review_drafts', label: 'Look at it' }], link: '/action-center',
    });
  }

  const failedAgents = agentRuns.filter((r) => r.status === 'error');
  if (failedAgents.length) {
    items.push({
      key: 'issue:agent-failures', kind: KIND.ISSUE, blocksShipping: false,
      title: `${plural(failedAgents.length, 'agent', 'agents')} failed on the latest run`,
      detail: failedAgents.slice(0, 5).map((r) => r.agent_id).join(', '),
      ageDays: ageDays(failedAgents[0].created_at, now), count: failedAgents.length,
      actions: [{ id: 'open_agents', label: 'See the agents' }], link: '/ai-orchestration',
    });
  }

  // A connected source that stopped working. Only connections that EXIST are passed in, so PostHog never shows for a
  // project without it (today only SuperRank's own); Google is on every project.
  const CONNECTION = { google: { name: 'Google (Search Console and Analytics)', actionLabel: 'Reconnect Google' }, posthog: { name: 'PostHog', actionLabel: 'Reconnect PostHog' } };
  for (const c of connections.filter((x) => CONNECTION[x.provider] && x.status && !['ok', 'pending', 'connected'].includes(x.status))) {
    items.push({
      key: `issue:connection:${c.provider}`, kind: KIND.ISSUE, blocksShipping: true,
      title: `${CONNECTION[c.provider].name} is disconnected`,
      detail: String(c.status_error || 'Its data has stopped updating until it is reconnected.').slice(0, 160),
      ageDays: ageDays(c.status_at, now), count: 1,
      actions: [{ id: 'reconnect', label: CONNECTION[c.provider].actionLabel, provider: c.provider }],
      link: `/account?scope=project&proj=${c.siteId}&tab=connections`,
    });
  }

  for (const u of unresolved) {
    items.push({
      key: `decision:${u.id}`, kind: KIND.DECISION, blocksShipping: false,
      title: `I need a decision: ${u.subject || u.category}`,
      detail: String(u.finding?.summary || u.finding?.question || u.evidence || '').slice(0, 200),
      ageDays: ageDays(u.created_at, now), count: 1, findingId: u.id,
      actions: [{ id: 'confirm_decision', label: 'Decide', findingId: u.id }],
    });
  }

  // Anything that has waited on a person for OVERDUE_AFTER_DAYS or more is overdue: it says so in its title, sorts ahead of fresh approvals,
  // and is what the assistant raises unprompted and the daily reminder (lib/approval-reminders.js) is about. Computed from the record's age
  // every time, so a person who answers it makes it vanish and nothing needs "un-snoozing".
  for (const i of items) {
    if (i.kind === KIND.APPROVAL && i.ageDays >= OVERDUE_AFTER_DAYS) { i.overdue = true; i.title = `${i.title} — waiting ${plural(i.ageDays, 'day', 'days')}`; }
  }

  // Shipping blockers first, then overdue approvals, then approvals, then the rest; oldest first inside a group.
  const rank = (i) => (i.blocksShipping ? 0 : i.overdue ? 0.5 : i.kind === KIND.APPROVAL ? 1 : i.kind === KIND.DECISION ? 2 : 3);
  return items.sort((a, b) => rank(a) - rank(b) || b.ageDays - a.ageDays);
}

// The loader: reads this site's real rows. Each source is independent, so one failing read never hides the others.
export async function collectNeedsYou(siteId, { now = Date.now(), googleFn = getGoogleConnection, posthogFn = getPosthogConnectionState, db = query, unresolvedFn = listUnresolved, runsFn = async (id) => getLatestAgentRunSummaries(id, (await listAgentMeta()).map((m) => m.id)) } = {}) {
  const safe = (p) => p.catch(() => []);
  const [drafts, stagePromotions, unresolved, agentRuns, google, posthog] = await Promise.all([
    safe(db(`SELECT id, action_type, status, created_at, apply_error, pr_state, pr_number, pr_url, pr_base_branch FROM drafts
             WHERE site_id = $1 AND status NOT IN ('implemented', 'abandoned', 'rejected') ORDER BY created_at DESC LIMIT 500`, [siteId]).then((r) => r.rows)),
    safe(db(`SELECT source_pr_number, status, promotion_pr_number, promotion_pr_url, created_at, updated_at FROM stage_promotions
             WHERE site_id = $1 AND status = 'opened'`, [siteId]).then((r) => r.rows)),
    safe(Promise.resolve(unresolvedFn(siteId))),
    safe(Promise.resolve(runsFn(siteId))),
    Promise.resolve(googleFn(siteId)).catch(() => null),
    Promise.resolve(posthogFn(siteId)).catch(() => null),
  ]);
  const connections = [
    google && { provider: 'google', siteId, status: google.status, status_error: google.status_error, status_at: google.status_at },
    posthog?.connected && { provider: 'posthog', siteId, status: posthog.status },
  ].filter(Boolean);
  const stageBranch = await Promise.resolve(db(`SELECT pr_target_branch FROM sites WHERE id = $1`, [siteId]).then((r) => String(r.rows[0]?.pr_target_branch || '').trim() || null)).catch(() => null);
  return buildNeedsYou({ drafts, stagePromotions, stageBranch, unresolved, agentRuns: Array.isArray(agentRuns) ? agentRuns : [], connections, now });
}

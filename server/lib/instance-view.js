import { query as dbQuery } from '../db.js';
import { assessTenantReadiness } from './tenant-provisioning.js';
import { growthStageFor } from './growth-stage.js';
import { deriveLifecycle } from './instance-lifecycle.js';
import { surgeStatus, effectiveSiteLimit } from './surge-mode.js';
import { HARD_CEILING, AUTONOMOUS_DRAFT_SOURCES } from './autonomous-quota.js';
import { safeTimezone } from '../util/dates.js';
import { autonomyView, autonomyChanges, autonomyDraftCounts } from './autonomy-control.js';

// READ-ONLY view of each project's Growth Agent instance, for the platform admin (P1, docs/architecture/p0-master-agent-and-instances.md).
//
// An instance is not a new object: it is the project's existing state seen as one thing. Everything here is composed from data
// that already exists (the site row, the readiness check, the growth clock, surge status, run and draft counts).
//
// WHAT IS NEVER RETURNED: page URLs, queries, draft text, memory text, design notes, competitor names, credentials. Only counts,
// dates, labels and yes/no states. The response builders below are explicit allow-lists (they name each field they return), so a
// new column on `sites` cannot reach the browser by accident; instance-view.test.js plants marker text in those sources and
// checks it never comes back.

const DAY = 24 * 60 * 60 * 1000;

// removed | paused | waiting_to_connect | setting_up | running. Pure. The rule itself lives in lib/instance-lifecycle.js, shared with the
// Agent Factory and the Master Agent so the three cannot disagree.
const VIEW_STATE = { removed: 'removed', paused: 'paused', connecting: 'waiting_to_connect', baselining: 'setting_up', active: 'running', requested: 'waiting_to_connect', provisioning: 'setting_up', offboarding: 'paused' };
export function instanceState(site) {
  return VIEW_STATE[deriveLifecycle(site)];
}

export const STATE_LABEL = Object.freeze({
  removed: 'Removed', paused: 'Paused', waiting_to_connect: 'Waiting to connect', setting_up: 'Setting up', running: 'Running',
});

// Pure. The four tiles: Search Console, Analytics, GitHub, Analyst.
export function connectionsOf(site, { hasAnalystClient }) {
  return {
    searchConsole: Boolean(site.gsc_property),
    analytics: Boolean(site.ga4_property_id),
    github: Boolean(site.repo_owner && site.repo_name),
    analyst: Boolean(hasAnalystClient),
  };
}

// Pure. How much a project may take today: its own limit (raised to 100 while its first-30-days surge is on), never above the
// platform's hard ceiling.
export function capacityFor(site, now = new Date()) {
  const surge = surgeStatus(site.surge_mode_until, now);
  const limit = effectiveSiteLimit(site.auto_remediation_daily_limit, surge);
  const cap = limit == null ? HARD_CEILING : Math.max(0, Math.min(Number(limit), HARD_CEILING));
  return { surge, dailyCapacity: cap, hardCeiling: HARD_CEILING };
}

// Pure. One list row from a site and its activity numbers.
export function toListRow(site, act = {}, { hasAnalystClient = false, now = new Date() } = {}) {
  const state = instanceState(site);
  const cap = capacityFor(site, now);
  const conn = connectionsOf(site, { hasAnalystClient });
  return {
    id: site.id,
    name: site.name,
    domain: site.website_domain || null,
    state,
    stateLabel: STATE_LABEL[state],
    createdAt: site.created_at || null,
    growth: site.growth_started_at ? growthStageFor(site.growth_started_at, now) : null,
    surge: { active: cap.surge.active, day: cap.surge.day, expiresAt: cap.surge.expiresAt },
    // enabled/canEnable/blockedReason/changedAt/changedBy/last7Days come from lib/autonomy-control.js (one place); dailyCapacity is kept
    // because the existing list text reads it.
    autonomy: { ...autonomyView(site, { change: act.autonomyChange || null, drafts: act.autonomyDrafts || null }), dailyCapacity: cap.dailyCapacity },
    lastRun: {
      at: act.lastRunAt || null,
      agentsLast24h: act.runs24h ?? 0,
      failedLast24h: act.failed24h ?? 0,
    },
    connections: conn,
    connectedCount: Object.values(conn).filter(Boolean).length,
    connectionsTotal: Object.keys(conn).length,
    needs: [!conn.searchConsole && 'Search Console', !conn.analytics && 'Analytics', !conn.github && 'GitHub'].filter(Boolean),
  };
}

// Pure. The strip above the list.
export function summarize(rows, now = new Date()) {
  const running = rows.filter((r) => r.state === 'running');
  return {
    running: running.length,
    waiting: rows.filter((r) => r.state === 'waiting_to_connect' || r.state === 'setting_up').length,
    paused: rows.filter((r) => r.state === 'paused').length,
    ranLast24h: running.filter((r) => r.lastRun.at && now.getTime() - new Date(r.lastRun.at).getTime() < DAY).length,
    runningTotal: running.length,
    needAttention: running.filter((r) => r.lastRun.failedLast24h > 0 || !r.lastRun.at || now.getTime() - new Date(r.lastRun.at).getTime() >= DAY).length,
  };
}

// A table or column that a newer migration adds may not exist yet on this database: that is "not available", never a failure.
async function tolerant(fn) {
  try { return await fn(); } catch (err) { if (['42P01', '42703'].includes(err.code)) return null; throw err; }
}

// agent_runs.status values that exist: 'ok' (the agent's own status, which is 'ok' for every agent that completes), 'error' (it threw)
// and 'skipped' (capability gate; the runner returns that without writing a row, so it appears only if a future agent persists one).
// Anything else an agent returns is a completed run, not an error.
export const agentStatus = (status) => (status === 'error' ? 'failed' : status === 'skipped' ? 'skipped' : 'ok');
const titleCase = (id) => String(id || '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

// Pure. Registry meta (name, description) by id; an agent no longer in the registry still gets a readable name.
export function agentList(rows, meta = new Map()) {
  return rows.map((r) => {
    const m = meta.get(r.agent_id) || {};
    return {
      id: r.agent_id,
      name: m.name || titleCase(r.agent_id),
      description: m.description || '',
      lastRunAt: r.created_at || null,
      lastStatus: agentStatus(r.status),
      tookMs: r.took_ms == null ? null : Number(r.took_ms),
      runs7d: r.runs7d ?? 0,
    };
  }).sort((a, b) => new Date(b.lastRunAt || 0) - new Date(a.lastRunAt || 0) || a.name.localeCompare(b.name));
}

// The agents registry imports every agent module, so it is loaded only when a detail page asks, and a failure there costs the names, not the page.
async function agentMeta() {
  try {
    const { listAgentMeta } = await import('../agents/registry.js');
    return new Map((await listAgentMeta()).map((m) => [m.id, m]));
  } catch { return new Map(); }
}

export async function loadInstanceList({ query = dbQuery, now = new Date() } = {}) {
  const { rows: sites } = await query(`SELECT * FROM sites WHERE status IS DISTINCT FROM 'soft_deleted' ORDER BY id`);
  const real = sites.filter((s) => s.name !== 'design-agent-worker.test.js fixture');
  const [clients, runs] = await Promise.all([
    query(`SELECT id FROM clients`).then((r) => new Set(r.rows.map((x) => x.id))).catch(() => new Set()),
    query(`SELECT site_id, count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS runs24h,
                  count(*) FILTER (WHERE created_at > now() - interval '24 hours' AND status = 'error')::int AS failed24h,
                  max(created_at) AS last_run_at
             FROM agent_runs WHERE created_at > now() - interval '30 days' GROUP BY site_id`).then((r) => r.rows),
  ]);
  const bySite = new Map(runs.map((r) => [r.site_id, { runs24h: r.runs24h, failed24h: r.failed24h, lastRunAt: r.last_run_at }]));
  // Who last changed each project's auto-fixes and what its last 7 days produced: two batched reads for the whole list.
  const ids = real.map((s) => s.id);
  const [changes, counts] = await Promise.all([autonomyChanges(ids, { query }), autonomyDraftCounts(ids, { query })]);
  const rows = real.map((s) => toListRow(s, { ...(bySite.get(s.id) || {}), autonomyChange: changes.get(s.id) || null, autonomyDrafts: counts.get(s.id) || null }, { hasAnalystClient: clients.has(s.id), now }));
  return { instances: rows, summary: summarize(rows, now) };
}

// One project. Counts and statuses only (see the header).
export async function loadInstanceDetail(siteId, { query = dbQuery, now = new Date(), readiness = assessTenantReadiness } = {}) {
  const { rows: found } = await query('SELECT * FROM sites WHERE id = $1', [siteId]);
  const site = found[0];
  if (!site || site.status === 'soft_deleted') return null;
  const tz = safeTimezone(site.timezone);

  const [clientRow, ws, agg, daysRan, slowest, memory, outcomes, profile, drafts7d, slots, ready, agentRows, batch, changes, counts, meta] = await Promise.all([
    query(`SELECT id FROM clients WHERE id = $1`, [siteId]).then((r) => r.rows[0] || null).catch(() => null),
    site.workspace_id ? query(`SELECT name FROM workspaces WHERE id = $1`, [site.workspace_id]).then((r) => r.rows[0] || null) : null,
    query(`SELECT count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS runs24h,
                  count(*) FILTER (WHERE created_at > now() - interval '24 hours' AND status = 'error')::int AS failed24h,
                  max(created_at) AS last_run_at
             FROM agent_runs WHERE site_id = $1 AND created_at > now() - interval '30 days'`, [siteId]).then((r) => r.rows[0]),
    query(`SELECT count(DISTINCT (created_at AT TIME ZONE $2)::date)::int AS n FROM agent_runs WHERE site_id = $1 AND created_at > now() - interval '7 days'`, [siteId, tz]).then((r) => r.rows[0].n),
    query(`SELECT agent_id, max(took_ms)::int AS ms FROM agent_runs WHERE site_id = $1 AND created_at > now() - interval '7 days' AND took_ms IS NOT NULL GROUP BY agent_id ORDER BY ms DESC LIMIT 1`, [siteId]).then((r) => r.rows[0] || null),
    tolerant(() => query(`SELECT count(*)::int AS n, max(created_at) AS last_at FROM project_memory_log WHERE site_id = $1`, [siteId]).then((r) => r.rows[0])),
    tolerant(() => query(`SELECT count(*)::int AS measured, count(*) FILTER (WHERE delta->>'verdict' = 'impact-positive')::int AS improved,
                                 count(*) FILTER (WHERE delta->>'verdict' = 'impact-negative')::int AS declined
                            FROM fix_impact WHERE site_id = $1 AND status = 'measured'`, [siteId]).then((r) => r.rows[0])),
    tolerant(() => query(`SELECT industry, industry_source, industry_confidence FROM site_profiles WHERE site_id = $1`, [siteId]).then((r) => r.rows[0] || null)),
    query(`SELECT count(*)::int AS opened, count(*) FILTER (WHERE source = ANY($2))::int AS autonomous
             FROM drafts WHERE site_id = $1 AND created_at > now() - interval '7 days'`, [siteId, AUTONOMOUS_DRAFT_SOURCES]).then((r) => r.rows[0]),
    tolerant(() => query(`SELECT used FROM autonomous_daily_slots WHERE site_id = $1 AND day = (now() AT TIME ZONE $2)::date`, [siteId, tz]).then((r) => r.rows[0]?.used ?? 0)),
    readiness(site).catch(() => null),
    // Every agent with a run in the last 30 days: its latest run, and how many runs in the last 7 days.
    query(`SELECT DISTINCT ON (a.agent_id) a.agent_id, a.status, a.took_ms, a.created_at,
                  (SELECT count(*)::int FROM agent_runs r WHERE r.site_id = a.site_id AND r.agent_id = a.agent_id AND r.created_at > now() - interval '7 days') AS runs7d
             FROM agent_runs a WHERE a.site_id = $1 AND a.created_at > now() - interval '30 days'
            ORDER BY a.agent_id, a.created_at DESC`, [siteId]).then((r) => r.rows),
    // The most recent day batch (the site's own calendar day): how many agents ran, failed or skipped, and about how long it took.
    query(`WITH last AS (SELECT (max(created_at) AT TIME ZONE $2)::date AS d FROM agent_runs WHERE site_id = $1 AND created_at > now() - interval '30 days'),
                latest AS (SELECT DISTINCT ON (agent_id) agent_id, status FROM agent_runs, last
                            WHERE site_id = $1 AND (created_at AT TIME ZONE $2)::date = last.d ORDER BY agent_id, created_at DESC)
           SELECT count(*) FILTER (WHERE status NOT IN ('error','skipped'))::int AS ran,
                  count(*) FILTER (WHERE status = 'error')::int AS failed,
                  count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
                  (SELECT (extract(epoch FROM (max(created_at) - min(created_at))) * 1000)::bigint + coalesce((SELECT took_ms FROM agent_runs, last WHERE site_id = $1 AND (created_at AT TIME ZONE $2)::date = last.d ORDER BY created_at LIMIT 1), 0)
                     FROM agent_runs, last WHERE site_id = $1 AND (created_at AT TIME ZONE $2)::date = last.d) AS duration_ms
             FROM latest`, [siteId, tz]).then((r) => r.rows[0]),
    autonomyChanges([siteId], { query }),
    autonomyDraftCounts([siteId], { query }),
    agentMeta(),
  ]);

  const row = toListRow(site, { runs24h: agg.runs24h, failed24h: agg.failed24h, lastRunAt: agg.last_run_at, autonomyChange: changes.get(siteId) || null, autonomyDrafts: counts.get(siteId) || null }, { hasAnalystClient: Boolean(clientRow), now });
  const cap = capacityFor(site, now);
  return {
    ...row,
    // The most recent day batch, on top of the existing at / agentsLast24h / failedLast24h.
    lastRun: {
      ...row.lastRun,
      agentsRan: batch?.ran ?? 0, agentsFailed: batch?.failed ?? 0, agentsSkipped: batch?.skipped ?? 0,
      durationMs: batch?.duration_ms == null ? null : Number(batch.duration_ms),
    },
    agents: agentList(agentRows, meta),
    workspaceName: ws?.name || null,
    // "Linked" only when the analyst client exists AND carries this project's id (the link is a convention, not a foreign key).
    analystLink: clientRow ? 'linked' : 'missing',
    trainingPermission: { value: 'not_configured', effective: 'none' },
    industryLearning: 'included',
    capacity: { dailyCapacity: cap.dailyCapacity, hardCeiling: cap.hardCeiling, usedToday: slots == null ? null : slots },
    surgeDetail: { active: cap.surge.active, day: cap.surge.day, activatedAt: cap.surge.activatedAt, expiresAt: cap.surge.expiresAt, reason: cap.surge.reason },
    readiness: ready ? { ready: ready.ready, items: ready.items.map((i) => ({ key: i.key, label: i.label, ok: i.ok })) } : null,
    last7Days: {
      daysRan, daysTotal: 7,
      draftsOpened: drafts7d.opened, autonomousDrafts: drafts7d.autonomous,
      slowestAgent: slowest ? { id: slowest.agent_id, ms: slowest.ms } : null,
    },
    memory: memory ? { versions: memory.n, lastUpdatedAt: memory.last_at } : null,
    outcomes: outcomes ? { measured: outcomes.measured, improved: outcomes.improved, declined: outcomes.declined } : null,
    industry: profile ? { label: profile.industry || null, source: profile.industry_source || null, confidence: profile.industry_confidence || null } : null,
    configuration: {
      autonomousFixes: Boolean(site.auto_remediation_enabled),
      rankTracking: Boolean(site.rank_tracking_enabled),
      competitorGrowth: Boolean(site.competitor_growth_enabled),
      targetScope: site.target_scope || null,
      targetPlaces: Array.isArray(site.target_places) ? site.target_places.length : 0,
    },
  };
}

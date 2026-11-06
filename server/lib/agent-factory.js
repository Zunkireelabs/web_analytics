import { query as dbQuery } from '../db.js';
import { deriveLifecycle, isSchedulable } from './instance-lifecycle.js';
import { ensureAnalystRegistered, assessTenantReadiness } from './tenant-provisioning.js';
import { snapshotProjectMemory } from './project-memory.js';

// THE AGENT FACTORY (P2). Brings one project's Growth Agent instance into being and keeps it complete.
//
// It does NOT build a second system. An instance is the project's existing state (docs/architecture/p0-master-agent-and-instances.md),
// and every step below calls code that already exists: the analyst registration, the readiness check, the project-memory snapshot and
// the scheduler's own eligibility rule. What the factory adds is ONE ordered, repeatable, recorded procedure, so "onboarded" and
// "actually working" stop being different things and a half-provisioned project is visible instead of silent.
//
// Properties
//   - Idempotent: every step checks before it acts, so running the factory twice changes nothing the second time.
//   - Honest: a step reports ok / pending / failed / skipped with a reason, never a placeholder. A project that cannot run yet
//     (no Google connection) is 'pending', and the factory says exactly what it is waiting for.
//   - Isolated: every query and every called function takes this one project's id.
//   - Safe: a failing step is recorded and the later steps still run, because they are independent; one broken step never
//     hides the state of the others. Nothing here ships anything, opens a PR, or contacts a client's repository.
//   - Cheap by default: the baseline (which re-runs every analysis agent and costs real money) is NEVER started automatically.
//     It stays the existing, deliberate step (routes/clients.js runBaselineSequence); the factory reports "awaiting baseline".

export const STEP_ORDER = Object.freeze(['identity', 'growth_clock', 'analyst_client', 'readiness', 'baseline', 'memory', 'schedule']);

const ok = (detail, extra = {}) => ({ status: 'ok', detail, ...extra });
const pending = (detail, extra = {}) => ({ status: 'pending', detail, ...extra });
const failed = (detail) => ({ status: 'failed', detail });
const skipped = (detail) => ({ status: 'skipped', detail });

// Each step: (ctx) -> { status, detail }. ctx = { site, deps, autoBaseline (boolean or (site) => decision), now }. Steps never throw out of runStep (see below).
export const STEPS = {
  // The project exists, is active, and belongs to a workspace. Read only.
  async identity({ site }) {
    if (site.status === 'soft_deleted') return skipped('The project was removed.');
    if (site.status !== 'active') return pending(`The project is ${site.status}.`);
    return site.workspace_id ? ok('Has a workspace.') : pending('Has no workspace yet (a project created by the CLI, before workspaces).');
  },

  // The growth programme clock (migration 230). Read only: the factory never moves a clock.
  async growth_clock({ site }) {
    return site.growth_started_at ? ok('Growth programme clock is set.') : pending('No growth clock on this database yet (migration 230).');
  },

  // The Data Analyst side of the tenant. Registers only if the analyst does not know the project; safe to repeat.
  async analyst_client({ site, deps }) {
    if (!isSchedulable(site)) return pending('Registered when the project is connected.');
    const r = await deps.ensureAnalystRegistered(site);
    if (r.status === 'already-registered') return ok('Analyst client exists.');
    if (r.status === 'registered') return ok('Analyst client created.', { changed: true });
    if (r.status === 'skipped') return skipped('Not applicable.');
    return failed(`Analyst service: ${r.status}${r.error ? ` (${String(r.error).slice(0, 120)})` : ''}`);
  },

  // What the project still needs before it runs end to end, from the existing readiness check.
  async readiness({ site, deps }) {
    const r = await deps.assessTenantReadiness(site);
    const missing = r.items.filter((i) => i.ok === false).map((i) => i.label);
    return missing.length ? pending(`Missing: ${missing.join(', ')}.`, { missing }) : ok('Everything in place.');
  },

  // The baseline is the deliberate, costly first analysis. The factory only reports where it stands.
  async baseline({ site, autoBaseline, deps }) {
    if (site.property_type === 'product') return skipped('Not applicable to a product project.');
    if (site.onboarded_at) return ok('Baseline captured.');
    if (!isSchedulable(site)) return pending('Waiting for Search Console and Analytics to be connected.');
    // `autoBaseline` is true/false, or a function that decides per project (lib/auto-baseline.js: only projects onboarded after the
    // Master Agent went live, within a daily limit). Everything else keeps waiting for the deliberate, manual start.
    let allowed = autoBaseline; let why = null;
    if (typeof autoBaseline === 'function') { const d = await autoBaseline(site); allowed = typeof d === 'object' ? Boolean(d.ok) : Boolean(d); why = typeof d === 'object' ? d.reason : null; }
    if (!allowed) {
      if (why === 'daily-limit-reached') return pending('Connected; the automatic baseline starts tomorrow (the daily limit is reached).');
      if (why === 'already-started') return pending('The baseline has started and is still running.');
      return pending('Connected; awaiting the baseline (started from the client controls).');
    }
    const r = await deps.runBaseline(site);
    return r?.error ? failed(`Baseline: ${String(r.error).slice(0, 160)}`) : ok('Baseline started.', { changed: true });
  },

  // The first project-memory version, so the instance has a starting point. Only when it has none yet.
  async memory({ site, deps }) {
    if (!isSchedulable(site)) return pending('Starts when the project is connected.');
    const n = await deps.countMemoryVersions(site.id);
    if (n > 0) return ok(`${n} memory version(s).`);
    await deps.snapshotMemory(site.id, { reason: 'agent-factory' });
    return ok('First memory version recorded.', { changed: true });
  },

  // Does the Master Agent / daily job pick this project up? Uses the scheduler's own rule.
  async schedule({ site }) {
    return isSchedulable(site) ? ok('Joins the daily schedule.') : pending('Joins the schedule once connected.');
  },
};

function defaultDeps(query) {
  return {
    query,
    ensureAnalystRegistered,
    assessTenantReadiness,
    snapshotMemory: snapshotProjectMemory,
    countMemoryVersions: async (siteId) => {
      try { return (await query('SELECT count(*)::int AS n FROM project_memory_log WHERE site_id = $1', [siteId])).rows[0].n; }
      catch (err) { if (err.code === '42P01') return 0; throw err; }
    },
    // Deliberately not wired: see the baseline step. A caller that wants it passes its own.
    runBaseline: async () => ({ error: 'automatic baseline is not enabled' }),
  };
}

// A step that throws is a failed step, recorded; it never takes the others down.
async function runStep(key, ctx) {
  try { return await STEPS[key](ctx); }
  catch (err) { return failed(String(err?.message || err).slice(0, 200)); }
}

// Pure. Final lifecycle from the project and its steps. The stored state is a record; this is the rule.
export function lifecycleFrom(site, results) {
  const derived = deriveLifecycle(site);
  if (derived !== 'active') return derived;
  const broken = Object.values(results).some((r) => r.status === 'failed');
  return broken ? 'provisioning' : 'active';
}

/** Idempotently provision one project. Returns { siteId, lifecycle, steps, changed, ok, waitingFor }. */
export async function provisionInstance(siteId, { deps = {}, query = dbQuery, autoBaseline = false, now = new Date() } = {}) {
  const d = { ...defaultDeps(query), ...deps };
  const { rows } = await query('SELECT * FROM sites WHERE id = $1', [siteId]);
  const site = rows[0];
  if (!site) return { siteId, found: false, lifecycle: 'removed', steps: {}, changed: false, ok: false, waitingFor: [] };

  const steps = {}; let changed = false;
  for (const key of STEP_ORDER) {
    const r = await runStep(key, { site, deps: d, autoBaseline, now });
    steps[key] = { ...r, at: now.toISOString() };
    if (r.changed) changed = true;
  }
  const lifecycle = lifecycleFrom(site, steps);
  const failedSteps = Object.entries(steps).filter(([, r]) => r.status === 'failed');
  const waitingFor = Object.entries(steps).filter(([, r]) => r.status === 'pending').map(([k, r]) => ({ step: k, detail: r.detail }));
  const lastError = failedSteps.length ? failedSteps.map(([k, r]) => `${k}: ${r.detail}`).join('; ').slice(0, 500) : null;

  await query(
    `INSERT INTO agent_instances (site_id, lifecycle_state, steps, last_error, last_reconciled_at)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (site_id) DO UPDATE SET lifecycle_state = EXCLUDED.lifecycle_state, steps = EXCLUDED.steps,
       last_error = EXCLUDED.last_error, last_reconciled_at = EXCLUDED.last_reconciled_at, updated_at = now()`,
    [siteId, lifecycle, JSON.stringify(steps), lastError, now]);

  return { siteId, found: true, lifecycle, steps, changed, ok: failedSteps.length === 0, waitingFor };
}

/** Records that a project exists, with no network and no side effects. Called at project creation; never throws. */
export async function requestInstance(siteId, { query = dbQuery } = {}) {
  try {
    await query(`INSERT INTO agent_instances (site_id, lifecycle_state) VALUES ($1, 'requested') ON CONFLICT (site_id) DO NOTHING`, [siteId]);
    return true;
  } catch (err) {
    // The table does not exist until migration 243 is applied; a project must be creatable either way.
    if (err.code !== '42P01') console.warn(`[agent-factory] could not record instance for site ${siteId}: ${err.message}`);
    return false;
  }
}

/** Projects that need the factory: no instance row, not yet active, a recorded failure, or not reconciled for staleHours. */
export async function listInstancesNeedingAttention({ query = dbQuery, staleHours = 24, limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT s.id FROM sites s LEFT JOIN agent_instances i ON i.site_id = s.id
      WHERE s.status IS DISTINCT FROM 'soft_deleted'
        AND (i.site_id IS NULL OR i.lifecycle_state <> 'active' OR i.last_error IS NOT NULL
             OR i.last_reconciled_at IS NULL OR i.last_reconciled_at < now() - ($1 || ' hours')::interval)
      ORDER BY (i.site_id IS NULL) DESC, i.last_reconciled_at NULLS FIRST, s.id
      LIMIT $2`, [staleHours, limit]);
  return rows.map((r) => r.id);
}

/** Runs the factory over every project that needs it, one at a time. A failure for one never stops the rest. */
export async function reconcileInstances({ query = dbQuery, deps = {}, limit = 50, autoBaseline = false, now = new Date() } = {}) {
  const ids = await listInstancesNeedingAttention({ query, limit });
  const out = { checked: ids.length, active: 0, waiting: 0, failed: 0, changed: 0, results: [] };
  for (const id of ids) {
    let r;
    try { r = await provisionInstance(id, { query, deps, autoBaseline, now }); }
    catch (err) { out.failed++; out.results.push({ siteId: id, error: String(err.message).slice(0, 160) }); continue; }
    if (r.changed) out.changed++;
    if (!r.ok) out.failed++; else if (r.lifecycle === 'active') out.active++; else out.waiting++;
    out.results.push({ siteId: id, lifecycle: r.lifecycle, ok: r.ok, changed: r.changed });
  }
  return out;
}


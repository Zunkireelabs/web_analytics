# P2 Agent Factory and P3 Master Agent: what was built, how to use it, what is not proven

Status: BUILT LOCALLY, uncommitted, not deployed. Migration `243_agent_instances_and_queue.sql` is applied to the local database only.
Companion to `p0-master-agent-and-instances.md`. Nothing in production changes until the migration is applied and a mode is switched on.

## P2: Agent Factory (`server/lib/agent-factory.js`, `instance-lifecycle.js`)
One ordered, repeatable procedure per project: `identity, growth_clock, analyst_client, readiness, baseline, memory, schedule`.
Each step calls code that already exists (analyst registration, the readiness check, the project-memory snapshot, the scheduler's own
eligibility rule), checks before it acts, and reports `ok / pending / failed / skipped` with a reason. Results are recorded in
`agent_instances` (lifecycle: requested, provisioning, connecting, baselining, active, paused, offboarding, removed).
- Project creation records a `requested` instance (`db.js createClientSite`, no network, never fails the creation).
- The baseline (which re-runs every analysis agent and costs money) is never started automatically; the factory reports "awaiting baseline".
- A failing step is recorded and the others still run; a retry recovers.
- `reconcileInstances()` walks projects needing attention. It is called by the Master Agent in `on` mode, and can be called by hand.
- One shared lifecycle rule (`instance-lifecycle.js`) is used by the factory, the queue and the admin view; a test pins it equal to `job.js listConnectedSites`.

## P3: Master Agent (`server/lib/master-agent.js`)
A queue of per-project jobs (`instance_jobs`, unique per project, kind and day), claimed with `FOR UPDATE SKIP LOCKED`, run by a worker pool.
- Order: never-succeeded first, then longest wait, ties rotate daily.
- Limits: `MASTER_AGENT_CONCURRENCY` (default 1), `MASTER_BROWSER_SLOTS` (default 1). Defaults reproduce today's behaviour.
- Failure handling: retry once with backoff (5 / 15 / 45 min), an overrun is `timed_out` and not retried (the existing loop makes the same choice), a dead worker's job is re-taken after its lease, then closed as failed when attempts run out.
- Executor: `job.js runDailyJobForSite(site)`, the same function the existing loop calls. Shipping keeps its own cron, per-site locks and the atomic daily ceiling.
- Modes (`MASTER_AGENT_MODE`): `off` (default, nothing happens) | `shadow` (plans and records, runs nothing, provisions nothing, compares with the existing run) | `on` (provisions, plans, runs).
- Cutover hook (inert unless `on`): `cron.js` skips the 07:00 run's own detection step and schedules the queue earlier (`MASTER_AGENT_CRON_SCHEDULE`, default 05:00) plus an hourly catch-up pass.
- Safety: it refuses to claim while the existing daily run holds its lock, and never overwrites anything but its own shadow rows.
- Visibility: read-only `GET /platform/master-agent`, a status strip on the Agent instances tab, and `npm run master-agent-plan [-- --sites 100]`.

## How to prove it before trusting it (recommended order)
1. Apply migration 243 (the deploy does this).
2. `MASTER_AGENT_MODE=shadow` for several days: it plans and records, runs nothing; compare "plan vs the existing run" and the estimated day length.
3. Only then `on`, with the defaults (one worker, one slot), watching `health()`; raise slots and workers one step at a time.

## Not proven
- The default executor has never run a real daily pipeline through the queue (tests use a fake executor). First real run is the first `on` day.
- The 100-project result is a simulation (a fake pipeline of a few milliseconds) and an arithmetic estimate, not a measurement. Real limits (database connections, browser memory, GitHub budget) are unmeasured above 3 projects.
- Shipping is not queued. Only the daily detection pipeline is.
- The hourly catch-up guard in `job.js` can still re-run a project whose report is missing; in `on` mode it takes the same lock, so it cannot overlap a running day.
- Production has never run any of this; there are no cron runs to compare with yet.

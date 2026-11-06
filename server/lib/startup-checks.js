// Startup validation of everything the growth and learning system needs. Nothing here stops the server (a missing optional piece
// must not take every client's dashboard down), but nothing is allowed to fail SILENTLY either: every capability is reported as
// ok / degraded / blocked with what is wrong and the exact way to fix it, and a summary line says whether the system is fully
// operational. A deployment pipeline can also run `node server/scripts/startup-check.js` and fail on the exit code.

import { capabilityReport } from './feature-flags.js';
import { designGateMode } from '../design-agent/lib/design-completeness.js';

const present = (v) => typeof v === 'string' && v.trim() && !/^(sk-xxxx|changeme|your[-_])/i.test(v.trim());

// Tables / columns the learning system reads and writes. A missing one means a migration has not run.
export const REQUIRED_SCHEMA = Object.freeze([
  { table: 'sites', column: 'growth_started_at', migration: '230', feeds: 'growth stage' },
  { table: 'growth_stage_log', migration: '230', feeds: 'growth stage history' },
  { table: 'platform_activations', migration: '230', feeds: 'one-time activations' },
  { table: 'project_memory_log', migration: '226', feeds: 'project memory versions' },
  { table: 'industry_knowledge', migration: '227', feeds: 'industry intelligence' },
  { table: 'industry_knowledge_log', migration: '228', feeds: 'learning audit trail' },
  { table: 'model_registry', migration: '229', feeds: 'model registry' },
  { table: 'decisions', migration: '166', feeds: 'decision engine' },
  { table: 'fix_impact', migration: '104', feeds: 'outcome measurement' },
  { table: 'sites', column: 'surge_mode_until', migration: '242', feeds: 'first-30-day surge mode' },
  { table: 'autonomous_daily_slots', migration: '242', feeds: 'the atomic daily ceiling (autonomous drafting stops without it)' },
  { table: 'agent_instances', migration: '243', feeds: 'the Agent Factory (project creation still works without it)' },
  { table: 'instance_jobs', migration: '243', feeds: 'the Master Agent queue (needed only when MASTER_AGENT_MODE is shadow or on)' },
]);

// Pure: turns facts into findings. `env` and `schemaMissing` are inputs so this is testable without a server or database.
export function evaluateStartup({ env = process.env, schemaMissing = [], schemaCheckFailed = null } = {}) {
  const findings = [];
  const add = (capability, status, detail, recovery = '') => findings.push({ capability, status, detail, recovery });

  if (!present(env.ANTHROPIC_API_KEY) && !present(env.OPENAI_API_KEY)) {
    add('ai-decisions', 'blocked', 'No AI provider key is set, so the decision engine and every generator cannot run.', 'Set ANTHROPIC_API_KEY (or OPENAI_API_KEY) in the environment and restart.');
  } else add('ai-decisions', 'ok', 'AI provider key present.');

  if (!present(env.GITHUB_APP_ID) || !present(env.GITHUB_APP_PRIVATE_KEY_B64)) {
    add('pull-requests', 'blocked', 'GitHub App is not configured, so fixes cannot be turned into pull requests.', 'Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_B64.');
  } else add('pull-requests', 'ok', 'GitHub App configured. Merging stays a human step.');

  if (!present(env.SESSION_SECRET)) add('admin-auth', 'blocked', 'SESSION_SECRET is not set, so signed-in admin identity (used for learning reviews and model promotion) is unsafe.', 'Set SESSION_SECRET to a long random value.');
  else add('admin-auth', 'ok', 'Session secret present.');

  const mode = designGateMode(env);
  if (mode === 'enforce') add('design-gate', 'ok', 'Design gate enforcing: drafts without usable design memory are held.');
  else add('design-gate', 'degraded', `Design gate is "${mode}" (set explicitly): risky visual changes are NOT held for missing design memory.`, 'Unset DESIGN_GATE_MODE (or set it to "enforce").');

  for (const c of capabilityReport(env)) {
    if (c.enabled) add(c.name, 'ok', c.does);
    else add(c.name, 'degraded', `Explicitly turned off (${c.name}=${c.raw}): ${c.does} will NOT happen.`, `Remove ${c.name} from the environment (or set it to "on") and restart.`);
  }

  if (schemaCheckFailed) {
    add('learning-schema', 'degraded', `Could not verify the database schema (${schemaCheckFailed}).`, 'Check DATABASE_URL and database connectivity.');
  } else if (schemaMissing.length) {
    const list = schemaMissing.map((m) => `${m.table}${m.column ? `.${m.column}` : ''} (migration ${m.migration}, needed for ${m.feeds})`).join('; ');
    add('learning-schema', 'blocked', `Missing in the database: ${list}.`, 'Run the migrations: node server/migrations/run.js (a normal deploy does this).');
  } else add('learning-schema', 'ok', 'All learning tables and columns exist.');

  const blocked = findings.filter((f) => f.status === 'blocked');
  const degraded = findings.filter((f) => f.status === 'degraded');
  return { fullyOperational: !blocked.length && !degraded.length, blocked, degraded, findings };
}

export async function findMissingSchema({ query } = {}) {
  const q = query || (await import('../db.js')).query;
  const { rows } = await q(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [[...new Set(REQUIRED_SCHEMA.map((r) => r.table))]]
  );
  const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  const tables = new Set(rows.map((r) => r.table_name));
  return REQUIRED_SCHEMA.filter((r) => (r.column ? !have.has(`${r.table}.${r.column}`) : !tables.has(r.table)));
}

export async function runStartupChecks({ env = process.env, query, log = console } = {}) {
  let schemaMissing = [];
  let schemaCheckFailed = null;
  try { schemaMissing = await findMissingSchema({ query }); } catch (err) { schemaCheckFailed = err.message; }
  const report = evaluateStartup({ env, schemaMissing, schemaCheckFailed });
  for (const f of report.findings.filter((x) => x.status !== 'ok')) {
    log.error(`[startup] ${f.status.toUpperCase()} ${f.capability}: ${f.detail}${f.recovery ? ` FIX: ${f.recovery}` : ''}`);
  }
  log.log(report.fullyOperational
    ? '[startup] growth and learning system: FULLY OPERATIONAL'
    : `[startup] growth and learning system: ${report.blocked.length} blocked, ${report.degraded.length} degraded (see above)`);
  return report;
}

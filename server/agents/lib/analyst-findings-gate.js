import { query as defaultQuery } from '../../db.js';
import { operatorDetail } from '../../lib/errors.js';

// Did the Data Analyst CONFIRM that its findings are complete, and do they cover this site?
//
// The Python service ends every nightly pass by writing a `findings_complete` row to ai_activity_log. It is `completed` only when
// every required stage finished (data-analyst-agent/app/analysis/pass_runner.py); otherwise it is written `failed` with the
// stage-by-stage account. Until now only the optional daily-pipeline checked it. The plain nightly sync and the fusion job turned
// whatever insights were lying around into recommendations, which is how findings from a run that failed half way (or from a client
// whose inputs had gone stale) could still drive work. Both now ask this gate first.
//
// A marker also records which clients every required stage covered (`covered_clients`) and why others were left out
// (`excluded_clients`). A marker written before coverage was recorded has neither: it is treated as covering everyone, never as
// covering no one.
//
// Anything we cannot read counts as NOT confirmed. Set ANALYST_REQUIRE_FINDINGS_COMPLETE=false to switch the gate off; that is a
// deliberate operator decision, not a default.

export const FINDINGS_COMPLETE_TASK = 'findings_complete';
export const DEFAULT_MAX_AGE_HOURS = 36;

export function findingsGateEnabled(env = process.env) {
  return String(env.ANALYST_REQUIRE_FINDINGS_COMPLETE ?? 'true').trim().toLowerCase() !== 'false';
}

// state: 'complete' | 'incomplete' | 'stale' | 'missing' | 'unreadable'
export async function loadFindingsGate({ query = defaultQuery, now = new Date(), maxAgeHours = DEFAULT_MAX_AGE_HOURS } = {}) {
  let row;
  try {
    const { rows } = await query(
      `SELECT status, started_at, finished_at, detail, error FROM ai_activity_log
        WHERE task_type = $1 ORDER BY started_at DESC LIMIT 1`, [FINDINGS_COMPLETE_TASK]);
    row = rows[0];
  } catch (err) {
    return { state: 'unreadable', reason: `the analyst's findings marker could not be read: ${operatorDetail(err)}` };
  }
  if (!row) return { state: 'missing', reason: 'the analyst has never confirmed a complete analysis (no findings_complete marker)' };

  const at = new Date(row.finished_at || row.started_at);
  const ageHours = (now.getTime() - at.getTime()) / 3600000;
  const detail = row.detail || {};
  const base = { finishedAt: at.toISOString(), ageHours: Math.round(ageHours * 10) / 10, passId: detail.pass_id ?? null };

  if (row.status !== 'completed') {
    return { ...base, state: 'incomplete', reason: `the analyst's latest analysis did not complete: ${row.error || 'no reason recorded'}` };
  }
  if (!(ageHours <= maxAgeHours)) {
    return { ...base, state: 'stale', reason: `the analyst's last complete analysis is ${Math.round(ageHours)}h old (limit ${maxAgeHours}h)` };
  }
  const covered = Array.isArray(detail.covered_clients) ? new Set(detail.covered_clients.map(Number)) : null;
  return { ...base, state: 'complete', covered, excluded: detail.excluded_clients || {} };
}

// May findings be used for this site? { allowed, reason }
export function gateForSite(gate, siteId) {
  if (!gate) return { allowed: true, reason: null };
  if (gate.state !== 'complete') return { allowed: false, reason: gate.reason };
  if (gate.covered && !gate.covered.has(Number(siteId))) {
    const why = gate.excluded?.[String(siteId)];
    return { allowed: false, reason: `the latest complete analysis did not cover this project${why ? `: ${why}` : ''}` };
  }
  return { allowed: true, reason: null };
}

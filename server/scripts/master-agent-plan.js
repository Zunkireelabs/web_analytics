// READ-ONLY. Prints the Master Agent's state and a capacity estimate, so the queue can be judged before it is switched on.
//   npm run master-agent-plan                 current mode, today's jobs, shadow comparison
//   npm run master-agent-plan -- --sites 100  what a day would take for N projects at the current limits
// It writes nothing and starts nothing.
import { pool, query } from '../db.js';
import { health, shadowReport, masterMode, limits, estimateMsBySite, estimateMakespanMs, KINDS } from '../lib/master-agent.js';
import { isSchedulable } from '../lib/instance-lifecycle.js';

const args = process.argv.slice(2);
const nIdx = args.indexOf('--sites');
const hours = (ms) => `${(ms / 3600000).toFixed(1)} h`;

try {
  const mode = masterMode(); const l = limits();
  console.log(`Master Agent mode: ${mode}   workers: ${l.concurrency}   browser slots: ${l.browserSlots}   job timeout: ${Math.round(l.jobTimeoutMs / 60000)} min`);
  const h = await health({ mode });
  console.log('Today:', JSON.stringify(h.today), ` stuck: ${h.stuckRunning}`);
  const sr = await shadowReport();
  console.log(`Plan vs the existing run: planned ${sr.planned}, existing run did ${sr.legacyRan}; planned-only ${JSON.stringify(sr.plannedButLegacyDidNot)}, existing-only ${JSON.stringify(sr.legacyRanButNotPlanned)}`);

  const { rows } = await query(`SELECT * FROM sites WHERE status = 'active'`);
  const ids = rows.filter(isSchedulable).map((s) => s.id);
  const est = await estimateMsBySite(ids);
  const per = ids.map((i) => est.get(i) ?? KINDS.daily.defaultEstimateMs);
  console.log(`\nEligible projects now: ${ids.length} (measured history for ${est.size}; others use the ${KINDS.daily.defaultEstimateMs / 60000} min default)`);
  console.log(`Estimated day at today's limits: ${hours(estimateMakespanMs(per, l))}; sequential: ${hours(estimateMakespanMs(per, { concurrency: 1, browserSlots: 1 }))}`);
  if (nIdx >= 0) {
    const n = Number(args[nIdx + 1]); const avg = per.length ? per.reduce((a, b) => a + b, 0) / per.length : KINDS.daily.defaultEstimateMs;
    console.log(`\nFor ${n} projects at ${Math.round(avg / 60000)} min each (an estimate, not a measurement):`);
    for (const [c, b] of [[1, 1], [2, 2], [4, 4], [8, 4]]) console.log(`  ${c} worker(s), ${b} browser slot(s): ${hours(estimateMakespanMs(Array(n).fill(avg), { concurrency: c, browserSlots: b }))}`);
  }
} finally { await pool.end(); }

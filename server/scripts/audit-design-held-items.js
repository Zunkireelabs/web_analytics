// READ-ONLY audit: after deploying autonomous design repair, show exactly which
// stored failures change meaning, and what each one means from then on.
//
// Every recent failed/held draft is classified twice — as the system did BEFORE
// this change (classifyAbandonReason with legacy:true) and as it does NOW — and
// grouped by that transition, with counts, reasons and example text. Open
// recommendations still blocked for a design reason are listed too.
//
// Nothing here writes, and nothing needs migrating: classification is applied
// when attempts are COUNTED (store/drafts.js countFailedAttemptsByFinding), not
// when they are stored, and recommendation blocks are recomputed on every sync
// (store/recommendations.js refreshRecommendationBlockState). So old rows
// re-qualify on their own; this script is for SEEING that they will.
//
//   node server/scripts/audit-design-held-items.js            # all sites, last 30 days
//   node server/scripts/audit-design-held-items.js --site 7   # one site
//   node server/scripts/audit-design-held-items.js --days 14
//   node server/scripts/audit-design-held-items.js --json     # machine-readable
import { pathToFileURL } from 'node:url';
import { classifyAbandonReason, RETRY_POLICY } from '../lib/attempt-classification.js';

// What a policy means for the item, in plain words. `counts` = counts toward the
// 3-attempt retirement cap.
export const POLICY_MEANING = Object.freeze({
  [RETRY_POLICY.ITEM_DEFECT]: { counts: true, meaning: 'counts toward retiring the item (3 attempts), then it is withdrawn' },
  [RETRY_POLICY.RETRY]: { counts: false, meaning: 'retried on a later run; never counts against the item' },
  [RETRY_POLICY.NEEDS_HUMAN]: { counts: false, meaning: 'stops retrying; shown to a person with the reason and the diagnosis' },
  [RETRY_POLICY.ALREADY_RESOLVED]: { counts: false, meaning: 'closed as already fixed; not a failure' },
  [RETRY_POLICY.NEVER]: { counts: false, meaning: 'a person\'s decision; never retried automatically' },
});

const reasonOf = (r) => r?.abandoned_reason || r?.apply_error || '';

// Pure. rows: [{ site_id, abandoned_reason?, apply_error? }]
export function summarizeReclassification(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const transitions = new Map();
  const bySite = new Map();
  let unchanged = 0;
  for (const row of list) {
    const text = reasonOf(row);
    const before = classifyAbandonReason(text, { legacy: true });
    const after = classifyAbandonReason(text);
    const site = row?.site_id ?? 'unknown';
    const s = bySite.get(site) || { total: 0, changed: 0, noLongerCounted: 0 };
    s.total += 1;
    if (before.retryPolicy === after.retryPolicy) { unchanged += 1; bySite.set(site, s); continue; }
    s.changed += 1;
    if (POLICY_MEANING[before.retryPolicy]?.counts && !POLICY_MEANING[after.retryPolicy]?.counts) s.noLongerCounted += 1;
    bySite.set(site, s);
    const key = `${before.retryPolicy} -> ${after.retryPolicy}`;
    const t = transitions.get(key) || { from: before.retryPolicy, to: after.retryPolicy, count: 0, reasons: new Map() };
    t.count += 1;
    const label = after.summary;
    const entry = t.reasons.get(label) || { count: 0, example: text.slice(0, 140) };
    entry.count += 1;
    t.reasons.set(label, entry);
    transitions.set(key, t);
  }
  return {
    total: list.length,
    unchanged,
    changed: list.length - unchanged,
    transitions: [...transitions.values()]
      .sort((a, b) => b.count - a.count)
      .map((t) => ({
        from: t.from, to: t.to, count: t.count,
        before: POLICY_MEANING[t.from]?.meaning, after: POLICY_MEANING[t.to]?.meaning,
        reasons: [...t.reasons].map(([summary, v]) => ({ summary, count: v.count, example: v.example })).sort((a, b) => b.count - a.count),
      })),
    bySite: Object.fromEntries([...bySite].map(([k, v]) => [k, v])),
  };
}

export function formatReclassification(summary, { days = 30 } = {}) {
  const out = [`Drafts failed or held in the last ${days} day(s): ${summary.total}`, `  unchanged by this deploy: ${summary.unchanged}`, `  CHANGE meaning after deploy: ${summary.changed}`];
  for (const t of summary.transitions) {
    out.push('', `  ${t.from} -> ${t.to}   x${t.count}`, `     before: ${t.before}`, `     after:  ${t.after}`);
    for (const r of t.reasons) out.push(`     ${String(r.count).padStart(3)}  ${r.summary}`, `          e.g. "${r.example}"`);
  }
  const sites = Object.entries(summary.bySite).filter(([, v]) => v.changed);
  if (sites.length) {
    out.push('', '  By site (changed / total, and how many stop counting toward retirement):');
    for (const [site, v] of sites) out.push(`     site ${site}: ${v.changed}/${v.total} changed, ${v.noLongerCounted} no longer count toward retiring the item`);
  }
  return out.join('\n');
}

async function main() {
  await import('dotenv/config');
  const { query, pool } = await import('../db.js');
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const siteId = arg('--site');
  const days = Number(arg('--days')) || 30;

  const { rows: drafts } = await query(
    `SELECT site_id, action_type, abandoned_reason, apply_error FROM drafts
      WHERE (status = 'abandoned' OR apply_error IS NOT NULL)
        AND COALESCE(abandoned_at, updated_at) > now() - ($1::int * interval '1 day')
        AND ($2::int IS NULL OR site_id = $2::int)`,
    [days, siteId],
  );
  const { rows: blocked } = await query(
    `SELECT site_id, recommendation_type, left(blocked_reason, 140) AS blocked_reason FROM recommendations
      WHERE status = 'open' AND blocked_reason IS NOT NULL
        AND (blocked_reason ILIKE '%layout%' OR blocked_reason ILIKE '%design%' OR blocked_reason ILIKE '%measures differently%')
        AND ($1::int IS NULL OR site_id = $1::int)`,
    [siteId],
  );
  const summary = summarizeReclassification(drafts);
  if (args.includes('--json')) { console.log(JSON.stringify({ summary, blocked }, null, 2)); await pool.end(); return; }
  console.log(`\n${formatReclassification(summary, { days })}`);
  console.log(`\nOpen recommendations still blocked for a design reason: ${blocked.length}`);
  console.log('  (these are recomputed on the next sync; a block set by a failed repair clears if the cause no longer holds)');
  for (const b of blocked.slice(0, 25)) console.log(`  site ${b.site_id}  ${b.recommendation_type}  ${b.blocked_reason}`);
  console.log('\nRead-only: nothing was changed.');
  await pool.end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}

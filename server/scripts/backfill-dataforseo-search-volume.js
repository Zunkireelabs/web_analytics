// One-off backfill for keyword_gaps rows written on 2026-09-15, the day
// before commit 4a7544c1 added `search_volume: idea.searchVolume ?? null`
// to keyword-demand.js's gap object. Before that commit the field simply
// didn't exist on the object, so every dataforseo_demand row from that day
// got search_volume = null despite genuinely having real DataForSEO volume
// — the number is still sitting, unused, inside that row's own reason text
// ("Real Google search demand (~165000/mo) ...").
//
// This recovers it from the reason string rather than re-querying
// DataForSEO: no live/paid API call, just parsing back out a number this
// codebase already paid for and already computed once. Code path itself
// needs no fix — keyword-demand.js has been correct since 4a7544c1; this
// only repairs data written before that commit landed.
//
// Idempotent: only ever touches rows where search_volume IS NULL, so a
// second run is a no-op.

import { query } from '../db.js';

const REASON_VOLUME_RE = /\(~(\d+)\/mo\)/;

async function main() {
  const dryRun = !process.argv.includes('--commit');

  const { rows } = await query(
    `SELECT id, site_id, topic, reason FROM keyword_gaps
      WHERE source = 'dataforseo_demand' AND search_volume IS NULL`
  );

  const recoverable = [];
  const unrecoverable = [];
  for (const row of rows) {
    const match = row.reason?.match(REASON_VOLUME_RE);
    if (match) recoverable.push({ ...row, volume: Number(match[1]) });
    else unrecoverable.push(row);
  }

  console.log(`${rows.length} null-search_volume dataforseo_demand row(s) found.`);
  console.log(`${recoverable.length} recoverable from reason text, ${unrecoverable.length} not (would need a real re-check, not touched here).`);

  if (unrecoverable.length) {
    console.log('Unrecoverable rows (left untouched):');
    for (const row of unrecoverable) console.log(`  site ${row.site_id} #${row.id} "${row.topic}"`);
  }

  if (dryRun) {
    console.log('\nDry run — no writes. Re-run with --commit to apply.');
    for (const row of recoverable.slice(0, 10)) {
      console.log(`  site ${row.site_id} #${row.id} "${row.topic}" -> search_volume = ${row.volume}`);
    }
    if (recoverable.length > 10) console.log(`  ...and ${recoverable.length - 10} more`);
    return;
  }

  let updated = 0;
  for (const row of recoverable) {
    await query(
      `UPDATE keyword_gaps SET search_volume = $2 WHERE id = $1 AND search_volume IS NULL`,
      [row.id, row.volume]
    );
    updated++;
  }
  console.log(`\nUpdated ${updated} row(s).`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});

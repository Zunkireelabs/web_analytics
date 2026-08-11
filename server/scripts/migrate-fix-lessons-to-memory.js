import 'dotenv/config';
import { pool, query } from '../db.js';
import { topLevelCategoryForGenerator } from '../generators/lib/pattern-categories.js';

// One-time migration: fix_lessons (migration 086) -> agent_fix_memory
// (migration 097). Run once, after the runtime cutover (server/llm.js's
// withAgentMemory, action-center.js's recordFixOutcome call sites) has
// already landed, so no live code path is still writing to fix_lessons by
// the time this runs. fix_lessons itself is left untouched (not dropped) —
// a rollback window, not a second source of truth going forward.
//
//   node server/scripts/migrate-fix-lessons-to-memory.js              # dry run, prints only
//   node server/scripts/migrate-fix-lessons-to-memory.js --commit      # writes to agent_fix_memory
//
// execution_permission is derived from fix_lessons.status: 'auto_rule' rows
// already earned auto-apply trust under the old system, so they carry that
// trust forward as 'auto' (and 'trusted', mirroring agent_fix_memory's own
// promotion threshold); 'candidate' -> 'requires_approval' (not yet earned);
// 'flagged_for_review' -> 'informational' (a human already flagged it as
// unreliable — never resurface it as auto-appliable).
const STATUS_MAP = {
  auto_rule: { status: 'trusted', executionPermission: 'auto' },
  candidate: { status: 'candidate', executionPermission: 'requires_approval' },
  flagged_for_review: { status: 'flagged_for_review', executionPermission: 'informational' },
};

function parseArgs(argv) {
  return { commit: argv.includes('--commit') };
}

async function main() {
  const { commit } = parseArgs(process.argv.slice(2));

  const { rows } = await query(`SELECT * FROM fix_lessons WHERE active ORDER BY id ASC`);
  console.log(`Found ${rows.length} active fix_lessons row(s).`);
  console.log(commit ? 'Mode: WRITE (--commit passed)' : 'Mode: DRY RUN (pass --commit to write)');
  console.log('');

  let migrated = 0;
  for (const row of rows) {
    const mapped = STATUS_MAP[row.status] || STATUS_MAP.candidate;
    const category = row.generator_id ? topLevelCategoryForGenerator(row.generator_id) : 'other';
    const problemSignature = row.validation_rule_id || row.title;

    console.log(`[fix_lessons #${row.id}] ${row.title} -> category=${category} status=${mapped.status} execution_permission=${mapped.executionPermission}`);

    if (commit) {
      await query(
        `INSERT INTO agent_fix_memory
           (category, scope, execution_permission, status, site_id, generator_id, problem_signature, symptoms,
            root_cause, affected_pattern, fix_strategy, confidence, occurrence_count, source_type, validation_rule_id, created_at, updated_at)
         VALUES ($1, 'client', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'backfill-migrated', $13, $14, $15)`,
        [
          category, mapped.executionPermission, mapped.status, row.site_id, row.generator_id,
          problemSignature, row.title, row.root_cause,
          `${row.generator_id || 'any'} generator output matching "${row.title}".`, row.lesson,
          row.confidence, row.occurrence_count, row.validation_rule_id, row.created_at, row.updated_at,
        ],
      );
      migrated++;
    }
  }

  console.log('');
  console.log(commit
    ? `Done. ${migrated}/${rows.length} row(s) migrated into agent_fix_memory. fix_lessons left untouched (rollback window).`
    : `Dry run only — nothing written. Re-run with --commit to migrate ${rows.length} row(s).`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });

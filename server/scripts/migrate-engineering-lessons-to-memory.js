import 'dotenv/config';
import { pool, query } from '../db.js';

// One-time migration: engineering_fix_lessons (migration 087) -> shared
// agent_fix_memory (migration 097, category='code', scope='repo'). Run once,
// after server/scripts/engineering-lessons.js and extract-branch-lesson.js
// have already been repointed at agent_fix_memory, so no live path is still
// writing to engineering_fix_lessons by the time this runs.
// engineering_fix_lessons itself is left untouched (not dropped) — a
// rollback window, not a second source of truth going forward.
//
// Migrates every active=true row unconditionally, without re-running
// classifyBugFix's "is this generalizable" judgment — every row already
// passed that gate once, at extraction time (backfill-engineering-lessons.js
// / extract-branch-lesson.js both call classifyBugFix before ever inserting
// a row), so active=true is itself the evidence a row is a real, reusable
// lesson and not a one-off session note. Always execution_permission=
// 'informational' — a code-level lesson is never auto-appliable by any
// client-facing agent (see agent-memory.js's promoteOccurrence, which
// excludes category='code' from ever reaching 'auto').
//
//   node server/scripts/migrate-engineering-lessons-to-memory.js              # dry run, prints only
//   node server/scripts/migrate-engineering-lessons-to-memory.js --commit      # writes to agent_fix_memory

function parseArgs(argv) {
  return { commit: argv.includes('--commit') };
}

async function main() {
  const { commit } = parseArgs(process.argv.slice(2));

  const { rows } = await query(`SELECT * FROM engineering_fix_lessons WHERE active ORDER BY id ASC`);
  console.log(`Found ${rows.length} active engineering_fix_lessons row(s).`);
  console.log(commit ? 'Mode: WRITE (--commit passed)' : 'Mode: DRY RUN (pass --commit to write)');
  console.log('');

  let migrated = 0;
  for (const row of rows) {
    console.log(`[engineering_fix_lessons #${row.id}] ${row.bug_category} (${row.applies_to})`);

    if (commit) {
      await query(
        `INSERT INTO agent_fix_memory
           (category, scope, execution_permission, status, problem_signature, symptoms, root_cause,
            affected_pattern, fix_strategy, source_type, source_ref, created_at, updated_at)
         VALUES ('code', 'repo', 'informational', 'trusted', $1, $2, $3, $4, $5, 'backfill-migrated', $6, $7, $7)`,
        [row.bug_category, row.symptom, row.root_cause, row.applies_to, row.fix_pattern, row.source_ref, row.created_at],
      );
      migrated++;
    }
  }

  console.log('');
  console.log(commit
    ? `Done. ${migrated}/${rows.length} row(s) migrated into agent_fix_memory. engineering_fix_lessons left untouched (rollback window).`
    : `Dry run only — nothing written. Re-run with --commit to migrate ${rows.length} row(s).`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });

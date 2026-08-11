import 'dotenv/config';
import { pool } from '../db.js';
import { recordFixOutcome } from '../agent-memory.js';
import { topLevelCategoryForGenerator } from '../generators/lib/pattern-categories.js';

// Record a "don't repeat this" lesson into the shared agent_fix_memory
// table (migration 097) so every future call to the given generator gets it
// prepended to its system prompt — see server/llm.js's withAgentMemory().
// Use this after fixing a real recurring content/schema mistake, instead of
// only fixing it in code and hoping it doesn't resurface as a differently-
// shaped instance later. This is a manual/optional admin path — no agent's
// runtime learning loop requires it.
//
//   node server/scripts/add-fix-lesson.js --generator schema \
//     --title "Don't guess aggregateRating" \
//     --lesson "Never populate reviewRating/aggregateRating from inferred sentiment — only from an explicit numeric rating present in the page text." \
//     [--site 1] [--source manual]
//
// Omit --generator for a lesson that applies to every generator; omit
// --site for a lesson that applies to every tenant.

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) flags[a.slice(2)] = argv[i + 1];
  }
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (!flags.title || !flags.lesson) {
    console.error('Usage: node server/scripts/add-fix-lesson.js --title "..." --lesson "..." [--generator <id>] [--site <id>] [--source manual|regression]');
    process.exit(1);
  }
  const id = await recordFixOutcome({
    category: topLevelCategoryForGenerator(flags.generator || ''),
    scope: 'client',
    siteId: flags.site ? Number(flags.site) : null,
    generatorId: flags.generator || null,
    outcome: 'success',
    sourceType: flags.source || 'manual',
    problemSignature: flags.title,
    symptoms: flags.lesson,
    affectedPattern: flags.title,
    fixStrategy: flags.lesson,
  });
  console.log(`Lesson #${id} recorded (generator: ${flags.generator || 'all'}, site: ${flags.site || 'all'}).`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });

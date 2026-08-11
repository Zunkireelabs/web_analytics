import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { pool } from '../db.js';
import { addCodeLesson, getAllCodeLessons, mergeCodeLesson } from '../agent-memory.js';
import { classifyBugFix, extractLesson, findDuplicateLesson, truncateDiff } from '../engineering-lesson-extraction.js';

// The ongoing, per-PR counterpart to the one-time backfill-engineering-
// lessons.js. Run this against a fix/* branch right before `gh pr create`,
// review the extracted lesson (if any), then re-run with --commit
// --source-ref <PR URL> once the PR exists. Writes into the shared
// agent_fix_memory table (migration 097, category='code', scope='repo') —
// the same store every runtime agent learns from/writes to — but this
// script itself remains an OPTIONAL, human-reviewed admin/compatibility
// path: no agent's runtime learning loop requires it (see agent-memory.js's
// own top comment).
//
//   node server/scripts/extract-branch-lesson.js                          # dry run against current branch vs main
//   node server/scripts/extract-branch-lesson.js --base stage             # diff against a different base
//   node server/scripts/extract-branch-lesson.js --commit --source-ref <PR URL>
//
// Two-step by design: the extraction (dry run) happens before the PR exists,
// the actual insert happens after, once a real source_ref is available —
// mirrors add-fix-lesson.js's explicit, reviewed-by-a-human insert, not a
// silent background write.

function parseArgs(argv) {
  const flags = { base: 'main', commit: false, sourceRef: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') flags.base = argv[++i];
    else if (a === '--commit') flags.commit = true;
    else if (a === '--source-ref') flags.sourceRef = argv[++i];
  }
  return flags;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 20 }).trim();
}

function currentBranch() {
  return git(['rev-parse', '--abbrev-ref', 'HEAD']);
}

function branchDetail(base) {
  const message = git(['log', `${base}..HEAD`, '--format=%B']).trim();
  const diff = truncateDiff(git(['diff', `${base}...HEAD`]));
  return { message, diff };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const branch = currentBranch();

  if (flags.commit && !flags.sourceRef) {
    console.error('Usage: --commit requires --source-ref <PR URL> (run the dry run first, create the PR, then re-run with --commit --source-ref).');
    process.exit(1);
  }

  const detail = branchDetail(flags.base);
  if (!detail.message && !detail.diff) {
    console.log(`No commits between ${flags.base} and ${branch} — nothing to extract.`);
    await pool.end();
    return;
  }

  console.log(`Branch: ${branch} (vs ${flags.base})`);
  console.log(flags.commit ? `Mode: WRITE (source_ref: ${flags.sourceRef})` : 'Mode: DRY RUN (pass --commit --source-ref <PR URL> after the PR exists to write)');
  console.log('');

  let cls;
  try {
    cls = await classifyBugFix(detail);
  } catch (err) {
    console.error(`Classification failed: ${err.message}`);
    await pool.end();
    process.exit(1);
  }

  if (!cls.isCodeBugFix) {
    console.log(`Not classified as a code bug fix (${cls.reason}) — no lesson to record. If this branch does contain a real fix, review the diff/message being sent (base: ${flags.base}) or use add-fix-lesson-style manual entry instead.`);
    await pool.end();
    return;
  }

  let lesson;
  try {
    lesson = await extractLesson(detail);
  } catch (err) {
    console.error(`Extraction failed: ${err.message}`);
    await pool.end();
    process.exit(1);
  }

  if (!lesson.bugCategory) {
    console.log('Classified as a bug fix, but the diff did not contain enough to state a generalized lesson. Nothing to record.');
    await pool.end();
    return;
  }

  console.log(`--- ${lesson.bugCategory}`);
  console.log(`  symptom:      ${lesson.symptom}`);
  console.log(`  root_cause:   ${lesson.rootCause}`);
  console.log(`  fix_pattern:  ${lesson.fixPattern}`);
  console.log(`  applies_to:   ${lesson.appliesTo}`);
  console.log(`  source_ref:   ${flags.sourceRef || '(not set yet — pass --source-ref once the PR exists)'}`);

  if (flags.commit) {
    const existing = await getAllCodeLessons();
    const dup = await findDuplicateLesson(lesson, existing);
    if (dup) {
      await mergeCodeLesson(dup.existingLesson, { ...dup.merged, sourceRef: flags.sourceRef });
      console.log(`  -> merged into existing lesson #${dup.existingLesson.id} (LLM judged same underlying bug; wording updated, source_ref appended)`);
    } else {
      const id = await addCodeLesson({
        bugCategory: lesson.bugCategory,
        symptom: lesson.symptom,
        rootCause: lesson.rootCause,
        fixPattern: lesson.fixPattern,
        appliesTo: lesson.appliesTo,
        sourceRef: flags.sourceRef,
      });
      console.log(`  -> inserted as lesson #${id}`);
    }
  } else {
    console.log('  -> dry run only, not written. Review this, then re-run with --commit --source-ref <PR URL> once the PR is created.');
  }

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { pool } from '../db.js';
import { addEngineeringLesson, getAllEngineeringLessons, findSimilarLesson, mergeIntoLesson } from '../engineering-lessons.js';
import { classifyBugFix, extractLesson, consolidateDrafts, truncateDiff } from '../engineering-lesson-extraction.js';

// One-time backfill for engineering_fix_lessons (migration 087) from this
// repo's own git history — the code-bug analog of fix_lessons, which is
// populated by hand via add-fix-lesson.js. Bug fixes aren't recorded by
// hand as they happen, so this walks `git log`, finds commits that look
// like code-bug fixes, and asks the model to generalize each one into a
// lesson row instead of pasting the diff as the "fix". The classify/extract
// logic lives in ../engineering-lesson-extraction.js, shared with
// extract-branch-lesson.js (the ongoing, per-PR version of this same idea).
//
//   node server/scripts/backfill-engineering-lessons.js              # dry run, prints only
//   node server/scripts/backfill-engineering-lessons.js --commit      # writes to the DB
//   node server/scripts/backfill-engineering-lessons.js --limit 10    # cap commits scanned (newest first)
//
// Dry run is the default deliberately — this makes an LLM call per matched
// commit, so review the printed output before re-running with --commit.

const FIX_SUBJECT_RE = /\bfix|\bbug\b|\bcrash|\bbroken|\berror\b|\btimeout\b|\bhang(ing)?\b|\bleak\b|\brace\b|\bstuck\b/i;

function parseArgs(argv) {
  const flags = { commit: false, limit: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--commit') flags.commit = true;
    else if (argv[i] === '--limit') flags.limit = Number(argv[++i]);
  }
  return flags;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 20 });
}

function candidateCommits(limit) {
  const log = git(['log', '--no-merges', '--pretty=format:%H%x1f%s']);
  const commits = log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split('\x1f');
      return { sha, subject };
    })
    .filter((c) => FIX_SUBJECT_RE.test(c.subject));
  return limit ? commits.slice(0, limit) : commits;
}

function commitDetail(sha) {
  const message = git(['show', '-s', '--format=%B', sha]).trim();
  const diff = truncateDiff(git(['show', sha, '--patch', '--stat']));
  return { message, diff };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const commits = candidateCommits(flags.limit);
  console.log(`Scanning ${commits.length} candidate commit(s) (subject matched a fix-like pattern, merges excluded).`);
  console.log(flags.commit ? 'Mode: WRITE (--commit passed)' : 'Mode: DRY RUN (pass --commit to write)');
  console.log('');

  const drafts = [];
  let skipped = 0;

  for (const commit of commits) {
    const detail = commitDetail(commit.sha);
    let cls;
    try {
      cls = await classifyBugFix(detail);
    } catch (err) {
      console.warn(`[${commit.sha.slice(0, 7)}] classification failed, skipping: ${err.message}`);
      skipped++;
      continue;
    }
    if (!cls.isCodeBugFix) {
      skipped++;
      continue;
    }

    let lesson;
    try {
      lesson = await extractLesson(detail);
    } catch (err) {
      console.warn(`[${commit.sha.slice(0, 7)}] extraction failed, skipping: ${err.message}`);
      skipped++;
      continue;
    }
    if (!lesson.bugCategory) {
      skipped++;
      continue;
    }

    console.log(`[draft] ${commit.sha.slice(0, 7)} ${commit.subject} -> ${lesson.bugCategory}`);
    drafts.push({ ...lesson, ref: commit.sha, subject: commit.subject });
  }

  console.log('');
  console.log(`Extracted ${drafts.length} draft lesson(s) from ${commits.length} scanned (${skipped} skipped). Consolidating near-duplicates within each bug_category...`);
  console.log('');

  const canonical = await consolidateDrafts(drafts);

  const existing = flags.commit ? await getAllEngineeringLessons() : [];
  let inserted = 0;
  let mergedIntoExisting = 0;

  for (const lesson of canonical) {
    console.log(`--- ${lesson.bugCategory}  (from: ${lesson.refs.map((r) => r.slice(0, 7)).join(', ')})`);
    console.log(`  symptom:      ${lesson.symptom}`);
    console.log(`  root_cause:   ${lesson.rootCause}`);
    console.log(`  fix_pattern:  ${lesson.fixPattern}`);
    console.log(`  applies_to:   ${lesson.appliesTo}`);
    console.log(`  source_ref:   ${lesson.refs.join(', ')}`);

    const dup = findSimilarLesson(existing, { bugCategory: lesson.bugCategory, appliesTo: lesson.appliesTo });
    if (flags.commit) {
      if (dup) {
        await mergeIntoLesson(dup, { appliesTo: lesson.appliesTo });
        console.log(`  -> merged into existing lesson #${dup.id}`);
        mergedIntoExisting++;
      } else {
        const id = await addEngineeringLesson({
          bugCategory: lesson.bugCategory,
          symptom: lesson.symptom,
          rootCause: lesson.rootCause,
          fixPattern: lesson.fixPattern,
          appliesTo: lesson.appliesTo,
          sourceRef: lesson.refs.join(', '),
        });
        console.log(`  -> inserted as lesson #${id}`);
        inserted++;
      }
    } else {
      console.log(dup ? `  -> would merge into existing DB lesson (bug_category "${dup.bug_category}")` : '  -> would insert as new lesson');
    }
    console.log('');
  }

  console.log(`Done. ${commits.length} scanned, ${skipped} skipped, ${drafts.length} draft(s) consolidated into ${canonical.length} canonical lesson(s)${flags.commit ? ` (${inserted} inserted, ${mergedIntoExisting} merged into pre-existing rows)` : ''}.`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });

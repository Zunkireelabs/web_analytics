import 'dotenv/config';
import path from 'node:path';
import { pool } from '../db.js';
import { getAllCodeLessons, getCodeLessons } from '../agent-memory.js';

// A read-only lookup Claude Code runs against the file(s) it's about to
// modify, before making a fix, so a bug class already fixed once in this
// repo doesn't get repeated. Reads category='code', scope='repo' rows from
// the shared agent_fix_memory table (migration 097) — the same store every
// runtime agent learns from/writes to, filtered to the slice that's
// code-level and human/Claude-consumed rather than auto-appliable by any
// client-facing agent (see agent-memory.js's getAllCodeLessons/
// getCodeLessons and its clientFacing retrieval wall). See CLAUDE.md for the
// pointer that makes this part of standard workflow instead of something to
// remember by hand.
//
//   node server/scripts/engineering-lessons.js --file server/routes/webhooks.js
//   node server/scripts/engineering-lessons.js --file web/src/pages/Analyst.jsx --keywords "useEffect,hook"
//   node server/scripts/engineering-lessons.js --category hook-ordering
//   node server/scripts/engineering-lessons.js --all
//
// Multiple --file flags are allowed for a fix touching several files.
//
// Matching is deliberately a plain keyword-overlap heuristic, not an LLM
// call or embeddings — applies_to is free text describing a code pattern
// ("React components with early-return guards before hooks"), not a literal
// glob, so exact path matching would miss almost everything. Keywords are
// derived from the file's extension, path segments, and basename, plus
// whatever extra --keywords you already know about the bug (e.g. "hook",
// "race condition") from having read the crash/symptom before running this.
// If nothing surfaces, that's a real "no known lesson" signal, not
// necessarily a matching failure — rerun with --all to check by eye.

const EXT_HINTS = {
  jsx: ['react', 'component', 'jsx', 'frontend', 'hook'],
  tsx: ['react', 'component', 'tsx', 'frontend', 'hook'],
  css: ['css', 'style', 'styling'],
  scss: ['css', 'style', 'styling'],
  sql: ['sql', 'migration', 'schema', 'database'],
  py: ['python'],
};

function wordsFromSegment(segment) {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

export function deriveKeywords(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const base = path.basename(filePath, path.extname(filePath));
  const segments = filePath.split('/').filter(Boolean);
  const words = new Set();

  for (const seg of [...segments, base]) wordsFromSegment(seg).forEach((w) => words.add(w));
  (EXT_HINTS[ext] || []).forEach((w) => words.add(w));

  if (/(^|\/)routes\//.test(filePath)) ['express', 'route', 'handler', 'endpoint'].forEach((w) => words.add(w));
  if (/webhook/i.test(filePath)) words.add('webhook');
  if (/(^|\/)migrations\//.test(filePath)) words.add('migration');
  if (base.toLowerCase() === 'db') ['database', 'pool', 'connection'].forEach((w) => words.add(w));
  if (/(^|\/)generators\//.test(filePath)) words.add('generator');
  if (/(^|\/)agents\//.test(filePath)) words.add('agent');

  return [...words];
}

function scoreLesson(lesson, keywords) {
  const haystack = `${lesson.bug_category} ${lesson.applies_to}`.toLowerCase();
  let score = 0;
  const matched = [];
  for (const kw of keywords) {
    if (kw.length < 3) continue; // skip noise like "js", "to"
    if (haystack.includes(kw)) {
      score++;
      matched.push(kw);
    }
  }
  return { score, matched };
}

const DEFAULT_MIN_SCORE = 2;

function parseArgs(argv) {
  const flags = { files: [], keywords: [], category: null, all: false, minScore: DEFAULT_MIN_SCORE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') flags.files.push(argv[++i]);
    else if (a === '--keywords') flags.keywords.push(...argv[++i].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    else if (a === '--category') flags.category = argv[++i];
    else if (a === '--all') flags.all = true;
    else if (a === '--min-score') flags.minScore = Number(argv[++i]);
  }
  return flags;
}

function printBlock(lessons) {
  if (!lessons.length) {
    console.log('No engineering lessons matched. (This means no known lesson, or the keyword heuristic missed it — rerun with --all to check by eye.)');
    return;
  }
  console.log('Known engineering issues for this type of code — do not repeat these:');
  for (const l of lessons) {
    console.log(`- ${l.fix_pattern} (for: ${l.applies_to})`);
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  let lessons;
  if (flags.all) {
    lessons = await getAllCodeLessons();
  } else if (flags.category) {
    lessons = await getCodeLessons(flags.category);
  } else if (flags.files.length) {
    const keywords = new Set(flags.keywords);
    for (const f of flags.files) deriveKeywords(f).forEach((w) => keywords.add(w));
    const all = await getAllCodeLessons();
    const scored = all
      .map((l) => ({ ...l, ...scoreLesson(l, keywords) }))
      .filter((l) => l.score > 0)
      .sort((a, b) => b.score - a.score);
    lessons = scored.filter((l) => l.score >= flags.minScore);

    console.log(`Matched against: ${flags.files.join(', ')}${flags.keywords.length ? ` (+keywords: ${flags.keywords.join(', ')})` : ''} (min-score: ${flags.minScore})`);
    if (scored.length) {
      for (const l of scored) console.log(`  [score ${l.score}]${l.score < flags.minScore ? ' (below threshold)' : ''} ${l.bug_category} <- matched: ${l.matched.join(', ')}`);
    }
    console.log('');
  } else {
    console.error('Usage: node server/scripts/engineering-lessons.js --file <path> [--file <path> ...] [--keywords "a,b"] | --category <bug_category> | --all');
    process.exit(1);
  }

  printBlock(lessons);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });

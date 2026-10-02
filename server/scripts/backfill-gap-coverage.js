#!/usr/bin/env node
// One-time backfill of keyword_gaps.coverage_* using keyword-coverage.js.
//
//   node server/scripts/backfill-gap-coverage.js --site-id 1                 (dry run, no writes)
//   node server/scripts/backfill-gap-coverage.js --site-id 1 --apply         (write verdicts)
//   node server/scripts/backfill-gap-coverage.js --site-id 1 --no-llm        (deterministic only; no model calls)
//   node server/scripts/backfill-gap-coverage.js --site-id 1 --force         (re-judge even fresh verdicts)
//
// Cost control: a gap with a fresh cached verdict is skipped; an English keyword
// costs no translation call; only genuinely ambiguous gaps reach the model, once,
// and the result is cached on the row — so re-running this is cheap and idempotent.
// Dry run (the default) still reports exactly what WOULD be written.
//
// Requires migration 179 (keyword_gaps.coverage_*). It refuses to run without it.
import 'dotenv/config';
import { pool } from '../db.js';
import { getKeywordGaps } from '../store/data-analyst.js';
import { classifyGapCoverage, isCoverageFresh } from '../agents/lib/keyword-coverage-service.js';
import { translateQueries } from '../report/translate.js';
import { detectLanguage } from '../agents/lib/keyword-coverage.js';

function parseArgs(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2); const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) f[k] = true; else { f[k] = n; i++; }
  }
  return f;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const siteId = Number(flags['site-id']);
  if (!siteId) { console.error('--site-id is required'); process.exit(1); }
  const apply = flags.apply === true;
  const allowLLM = flags['no-llm'] !== true;

  const { rows } = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'keyword_gaps' AND column_name = 'coverage_status'");
  if (!rows.length) {
    console.error('keyword_gaps.coverage_status does not exist yet — migration 179 has not been applied. Nothing to do.');
    process.exit(2);
  }

  const gaps = (await getKeywordGaps(siteId)).filter((g) => g.status === 'pending_review' || g.status === 'approved');
  const todo = gaps.filter((g) => flags.force || !isCoverageFresh(g));
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — site ${siteId}: ${gaps.length} gap(s), ${todo.length} need a verdict (${gaps.length - todo.length} already cached).${allowLLM ? '' : ' (no LLM)'}`);

  // Batch the translation lookups for the non-English keywords up front: one call
  // per 60 terms instead of one per keyword, all cached in query_translations.
  const nonEnglish = todo.map((g) => g.topic).filter((t) => detectLanguage(t).lang !== 'en');
  let translations = new Map();
  if (allowLLM && nonEnglish.length) {
    for (let i = 0; i < nonEnglish.length; i += 60) {
      const part = await translateQueries(nonEnglish.slice(i, i + 60));
      for (const [k, v] of part) translations.set(k, v);
    }
  }

  const tally = {}; let llmCalls = 0;
  for (const gap of todo) {
    try {
      const r = await classifyGapCoverage(siteId, gap, { force: !!flags.force, persist: apply, allowLLM, translations });
      llmCalls += r.llmCalls;
      tally[r.status] = (tally[r.status] || 0) + 1;
      console.log(`  ${r.status.padEnd(12)} ${r.method.padEnd(13)} ${gap.topic.slice(0, 60).padEnd(60)} ${r.url ? '→ ' + r.url.replace(/^https?:\/\/[^/]+/, '') : ''}`);
    } catch (e) {
      console.warn(`  failed      ${gap.topic.slice(0, 60)}: ${e.message}`);
      tally.failed = (tally.failed || 0) + 1;
    }
  }
  console.log('\nverdicts:', tally, `| LLM judgment calls: ${llmCalls}`);
  if (!apply) console.log('Dry run — nothing was written. Re-run with --apply to commit.');
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });

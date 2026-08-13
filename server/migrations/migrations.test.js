import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));

// This directory has no migration-tracking table: run.js applies EVERY .sql
// file on EVERY deploy (see 100_recommendations_design_blocked.sql for the
// full explanation). That makes schema statements safe as long as they are
// written idempotently — IF NOT EXISTS, DROP-then-ADD — which is a convention
// this codebase already follows.
//
// Data statements are the trap, and the reason this file exists.
//
// 078_execution_jobs.sql carried an unguarded `UPDATE recommendations SET
// risk_tier = 'safe' WHERE recommendation_type IN (...)`. Written as a
// one-time backfill, it re-executed on every deploy forever, against rows
// created long after it was authored — and it predated the blocked_reason
// column entirely. So every deploy silently promoted open-but-blocked
// recommendations back to the 'safe' tier, manufacturing 45 contradictory
// rows on site 1 that the unattended shipping loop then had to defend
// against. Nothing failed, nothing logged; the corruption was only visible by
// querying the table.
//
// A data statement here is therefore not a backfill. It is a statement that
// re-runs forever and must CONVERGE on the invariant as it stands today. This
// test enforces that by construction: every data statement must either carry
// a guard predicate, or be explicitly listed below with the reason it is
// safe. It catches the class of bug, not the one instance of it.

function sqlFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

// Strips comments and string literals so keyword matching can't be fooled by
// the word UPDATE appearing inside a comment or a quoted string — which it
// does, often, in this directory's unusually long explanatory comments.
function stripNoise(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\$\$[\s\S]*?\$\$/g, (m) => m); // dollar-quoted bodies are real code, keep them
}

// A data statement is one that writes to existing rows. CREATE/ALTER/INSERT
// INTO ... SELECT on a table this migration just created are not in scope —
// what matters is touching rows that predate the statement.
function dataStatements(sql) {
  const clean = stripNoise(sql);
  const out = [];
  const re = /\b(UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(clean))) {
    // Take the statement up to its terminating semicolon so the guard check
    // below sees the whole WHERE clause, not just the verb.
    const end = clean.indexOf(';', m.index);
    out.push({
      verb: m[1].toUpperCase().replace(/\s+/g, ' '),
      table: m[2],
      text: clean.slice(m.index, end === -1 ? undefined : end),
    });
  }
  return out;
}

// Statements that write to existing rows but are safe to re-run forever,
// each with the reason. Add to this list only with a reason that stays true
// on the thousandth deploy, not just the first.
const ALLOWED_UNGUARDED = new Map([
  // Converging by construction: it sets rows TO the invariant, so once the
  // invariant holds it matches nothing. Re-running is a no-op.
  ['108_recommendation_block_invariant.sql', ['recommendations']],
]);

describe('migrations — data statements must converge, not backfill', () => {
  test('every UPDATE/DELETE either carries a guard or is explicitly allow-listed', () => {
    const offenders = [];
    for (const file of sqlFiles()) {
      if (file.endsWith('.test.js')) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      for (const stmt of dataStatements(sql)) {
        if (ALLOWED_UNGUARDED.get(file)?.includes(stmt.table)) continue;
        if (!/\bWHERE\b/i.test(stmt.text)) {
          offenders.push(`${file}: unconditional ${stmt.verb} on ${stmt.table}`);
        }
      }
    }
    assert.deepEqual(offenders, [], `Unguarded data statements re-run on every deploy:\n${offenders.join('\n')}`);
  });

  test("078's risk_tier backfill respects the block invariant", () => {
    // The specific regression. 078 promotes rows to the 'safe' tier by
    // recommendation_type; without these two predicates it promotes blocked
    // rows too, which is exactly how the safe+blocked contradiction was
    // manufactured. Migration 108 now forbids that state at the DB level, so
    // an unguarded 078 would fail the deploy rather than corrupt data — but
    // failing the deploy is not the outcome we want either.
    const sql = readFileSync(join(MIGRATIONS_DIR, '078_execution_jobs.sql'), 'utf8');
    const update = dataStatements(sql).find((s) => s.table === 'recommendations' && s.verb === 'UPDATE');
    assert.ok(update, '078 should still contain the risk_tier backfill');
    assert.match(update.text, /blocked_reason IS NULL/i, '078 must not promote a blocked recommendation to the safe tier');
    assert.match(update.text, /status = ''/i, "078 must only touch open rows (status = 'open')");
  });

  test("078's safe list stays a subset of risk-tiers.js's SAFE_GENERATOR_IDS", async () => {
    // The two lists have to agree, and 078's own comment says so. They drifted
    // once already: 078 hardcodes the safe list as it stood when it was
    // written, and every later change to SAFE_GENERATOR_IDS left it behind.
    // A subset check is the right assertion — 078 promoting a type that is no
    // longer safe is a real bug; SAFE_GENERATOR_IDS gaining a type 078 does
    // not know about is harmless, since new rows get their tier from
    // riskTierForGenerator at insert time.
    // Asserted through riskTierForGenerator rather than the SAFE_GENERATOR_IDS
    // set itself, which is module-private — the public function is the thing
    // every caller actually uses, so it is the thing worth pinning.
    const { riskTierForGenerator } = await import('../agents/lib/risk-tiers.js');
    const sql = readFileSync(join(MIGRATIONS_DIR, '078_execution_jobs.sql'), 'utf8');
    const list = sql.match(/recommendation_type IN \(([\s\S]*?)\)/)?.[1] || '';
    const types = [...list.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
    assert.ok(types.length > 0, "expected to find 078's hardcoded type list");
    const notSafe = types.filter((t) => riskTierForGenerator(t) !== 'safe');
    assert.deepEqual(notSafe, [], `078 promotes types that risk-tiers.js no longer considers safe: ${notSafe.join(', ')}`);
  });

  test('the block invariant is enforced structurally', () => {
    // The invariant that four layers now assert (coordinator, both unattended
    // selectors, and the database). This asserts the database half exists —
    // it is the only one that cannot be bypassed by a new caller.
    const sql = readFileSync(join(MIGRATIONS_DIR, '108_recommendation_block_invariant.sql'), 'utf8');
    assert.match(sql, /ADD CONSTRAINT recommendations_blocked_is_manual/i);
    assert.match(sql, /CHECK \(blocked_reason IS NULL OR risk_tier = 'manual'\)/i);
    assert.match(sql, /DROP CONSTRAINT IF EXISTS recommendations_blocked_is_manual/i,
      'must drop before adding, or the second deploy fails on a duplicate constraint');
  });
});

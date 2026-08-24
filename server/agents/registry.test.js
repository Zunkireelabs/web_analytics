import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Real DB-agnostic — registry.js just reads the directory and imports each
// module; several agent modules import server/db.js transitively (same as
// growth-queries.test.js explains), so this placeholder avoids the same
// import-time crash without ever issuing a real query.
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const { listAgentMeta } = await import('./registry.js');

describe('every registered agent', () => {
  // agent_runs.agent_version is a NOT NULL column, and runner.js's
  // saveAgentRun() failure on that constraint is caught and only
  // console.error'd, never thrown — so a missing `version` doesn't fail
  // loudly, it fails by omission: the agent runs fine forever, but no run
  // ever gets recorded, and it shows "Never run" in the Agent Taskforce no
  // matter how many times it actually fires. Confirmed live: growth-queries
  // was in exactly this state. This guards every agent, current and future,
  // against the same silent gap.
  test('declares a numeric version, or its run history silently never persists', async () => {
    const meta = await listAgentMeta();
    const missing = meta.filter((m) => typeof m.version !== 'number').map((m) => m.id);
    assert.deepEqual(missing, []);
  });

  test('declares a unique id', async () => {
    const meta = await listAgentMeta();
    const ids = meta.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

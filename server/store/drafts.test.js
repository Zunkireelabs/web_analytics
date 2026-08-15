import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let issued;

let implementedFindingIdsRows = [];

function fakeQuery(text, params = []) {
  const sql = text.replace(/\s+/g, ' ').trim();
  issued.push({ sql, params });
  if (sql.startsWith("UPDATE drafts SET status = 'branch_pushed'")) {
    return { rows: [{ id: params[1], status: 'branch_pushed' }] };
  }
  if (sql.startsWith('SELECT DISTINCT d.finding_id')) {
    return { rows: implementedFindingIdsRows };
  }
  throw new Error(`drafts.test.js fake query: unhandled SQL shape: ${sql}`);
}

const resolve = (p) => new URL(p, import.meta.url).href;
mock.module(resolve('../db.js'), {
  namedExports: { query: (text, params) => fakeQuery(text, params) },
});
const { markDraftBranchPushed, getImplementedFindingIds } = await import('./drafts.js');

beforeEach(() => { issued = []; implementedFindingIdsRows = []; });

// getImplementedFindingIds feeds Website Health's implementedFindingIds
// (job.js -> health-score.js) as well as Growth report/summary — a finding
// this excludes is treated everywhere as still-broken, not just "not shown
// in the Drafts tab". The actual still-present exclusion happens in
// Postgres (the LATERAL join + COALESCE), which a query-text fake can't
// execute — so this only asserts the query is shaped to do that filtering,
// plus that whatever rows come back become the returned Set.
describe('getImplementedFindingIds — verification-aware', () => {
  test('query excludes a finding whose latest real re-check still found the issue present', async () => {
    await getImplementedFindingIds(7);
    const select = issued.find((q) => q.sql.startsWith('SELECT DISTINCT d.finding_id'));
    assert.ok(select, 'issues the finding_id query');
    assert.match(select.sql, /LEFT JOIN LATERAL/);
    assert.match(select.sql, /fv\.site_id = d\.site_id AND fv\.finding_id = d\.finding_id/);
    assert.match(select.sql, /COALESCE\(latest_verification\.outcome, 'verified-fixed'\) != 'still-present'/);
    assert.equal(select.params[0], 7);
  });

  test('returns a Set built from whatever finding_ids the (already-filtered) query returns', async () => {
    implementedFindingIdsRows = [{ finding_id: 'security-headers:hsts' }, { finding_id: 'content-gap:/pricing:Missing FAQ' }];
    const result = await getImplementedFindingIds(7);
    assert.deepEqual(result, new Set(['security-headers:hsts', 'content-gap:/pricing:Missing FAQ']));
  });
});

// target_provenance carries page-resolution.js's resolvePageSource() output
// for the draft's target — recorded at the one point a draft's real GitHub
// branch actually gets pushed, so a reviewer can see what the change affects
// (a shared template's whole family, or just the one page) without having to
// re-derive it from the diff.
describe('markDraftBranchPushed — target_provenance', () => {
  test('persists provenance as JSONB alongside the existing branch-pushed fields', async () => {
    const provenance = { kind: 'generated-record', isSharedTemplate: true, affectedUrls: 'family' };
    await markDraftBranchPushed(1, 42, { branchName: 'auto/42', implementerId: 'backend', targetProvenance: provenance });

    const update = issued.find((q) => q.sql.includes("status = 'branch_pushed'"));
    assert.ok(update);
    assert.match(update.sql, /target_provenance = COALESCE\(\$7::jsonb, target_provenance\)/);
    assert.equal(update.params[6], JSON.stringify(provenance));
  });

  test('a null provenance leaves the column as COALESCE would — no write, not an error', async () => {
    await markDraftBranchPushed(1, 42, { branchName: 'auto/42', implementerId: 'backend' });
    const update = issued.find((q) => q.sql.includes("status = 'branch_pushed'"));
    assert.equal(update.params[6], null, 'COALESCE($7, target_provenance) with a null $7 preserves whatever was already stored');
  });

  test('appliedFiles and target_provenance are independent — passing one does not require the other', async () => {
    await markDraftBranchPushed(1, 42, {
      branchName: 'auto/42', implementerId: 'backend', appliedFiles: ['src/a.njk'], targetProvenance: null,
    });
    const update = issued.find((q) => q.sql.includes("status = 'branch_pushed'"));
    assert.equal(update.params[5], JSON.stringify(['src/a.njk']));
    assert.equal(update.params[6], null);
  });
});

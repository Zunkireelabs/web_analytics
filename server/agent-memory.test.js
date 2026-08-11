import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Exercises the real runtime loop (RETRIEVE -> REUSE -> VALIDATE -> LEARN)
// against an in-memory fake of the agent_fix_memory table, since this repo
// has no existing DB-mocking convention for its generator/store tests (see
// server/generators/breadcrumbs.test.js's comment) — node:test's
// `mock.module` (Node 20.6+, --experimental-test-module-mocks, wired into
// this repo's `npm test` script) lets us swap db.js's `query` for a fake
// that implements just the handful of SQL shapes server/agent-memory.js
// actually issues, in the same param order, so what's under test is the
// real module logic (ranking, dedup, confidence/status transitions), not a
// hand-rolled substitute for it.
let store;
let nextId;

function resetStore() {
  store = [];
  nextId = 1;
}

function fakeQuery(text, params = []) {
  const sql = text.replace(/\s+/g, ' ').trim();

  if (sql.startsWith('SELECT * FROM agent_fix_memory')) {
    const [category, clientFacing, scope, generatorId, siteId] = params;
    let rows = store.filter((r) => r.status !== 'flagged_for_review' && r.status !== 'deprecated');
    if (category != null) rows = rows.filter((r) => r.category === category);
    if (clientFacing) rows = rows.filter((r) => r.category !== 'code');
    rows = rows.filter((r) => r.scope === 'global' || r.scope === scope);
    rows = rows.filter((r) => r.generator_id == null || r.generator_id === generatorId);
    rows = rows.filter((r) => r.site_id == null || r.site_id === siteId);
    rows = rows.sort((a, b) => b.confidence - a.confidence || b.occurrence_count - a.occurrence_count).slice(0, 20);
    return { rows: rows.map((r) => ({ ...r })) };
  }

  if (sql.includes('WHERE validation_rule_id = $1')) {
    const [validationRuleId, generatorId, siteId] = params;
    const rows = store.filter((r) => r.validation_rule_id === validationRuleId
      && (generatorId == null ? r.generator_id == null : r.generator_id === generatorId)
      && (siteId == null ? r.site_id == null : r.site_id === siteId)
      && r.status !== 'deprecated');
    return { rows: rows.map((r) => ({ id: r.id })) };
  }

  if (sql.startsWith('SELECT id FROM agent_fix_memory') && sql.includes('WHERE category = $1')) {
    const [category, scope, generatorId, siteId, problemSignature] = params;
    const rows = store.filter((r) => r.category === category && r.scope === scope
      && (generatorId == null ? r.generator_id == null : r.generator_id === generatorId)
      && (siteId == null ? r.site_id == null : r.site_id === siteId)
      && r.problem_signature.toLowerCase() === problemSignature.toLowerCase()
      && r.status !== 'deprecated');
    return { rows: rows.map((r) => ({ id: r.id })) };
  }

  if (sql.startsWith('INSERT INTO agent_fix_memory')) {
    const [category, scope, execution_permission, site_id, generator_id, problem_signature, symptoms,
      root_cause, affected_pattern, fix_strategy, fix_pattern, validation_rule_id, source_type, source_ref] = params;
    const id = nextId++;
    store.push({
      id, category, scope, execution_permission, status: 'candidate', site_id, generator_id, problem_signature,
      symptoms, root_cause, affected_pattern, fix_strategy, fix_pattern, confidence: 0.5, occurrence_count: 1,
      successful_reuse_count: 0, failed_reuse_count: 0, reuse_history: [], validation_rule_id, source_type, source_ref,
    });
    return { rows: [{ id }] };
  }

  if (sql.includes('occurrence_count = occurrence_count + 1')) {
    const [id, threshold] = params;
    const row = store.find((r) => r.id === id);
    row.occurrence_count += 1;
    row.confidence = Math.min(0.95, row.confidence + 0.10);
    if (row.occurrence_count >= threshold && row.status === 'candidate') row.status = 'trusted';
    if (row.occurrence_count >= threshold && row.category !== 'code' && row.execution_permission === 'requires_approval') {
      row.execution_permission = 'auto';
    }
    return { rows: [{ id }] };
  }

  if (sql.startsWith('SELECT reuse_history FROM agent_fix_memory')) {
    const [id] = params;
    const row = store.find((r) => r.id === id);
    return { rows: row ? [{ reuse_history: row.reuse_history }] : [] };
  }

  if (sql.includes('reuse_history = $2::jsonb')) {
    const [id, historyJson, isSuccess, flip] = params;
    const row = store.find((r) => r.id === id);
    row.reuse_history = JSON.parse(historyJson);
    if (isSuccess) { row.successful_reuse_count += 1; row.confidence = Math.min(0.95, row.confidence + 0.10); }
    else { row.failed_reuse_count += 1; row.confidence = Math.max(0.05, row.confidence - 0.15); }
    if (flip) row.status = 'flagged_for_review';
    return { rows: [{ id }] };
  }

  throw new Error(`agent-memory.test.js fake query: unhandled SQL shape: ${sql}`);
}

mock.module('/Users/yukta/Travel/analytics/server/db.js', {
  namedExports: { query: (text, params) => fakeQuery(text, params) },
});
const { findRelevantMemory, recordFixOutcome } = await import('./agent-memory.js');

describe('agent_fix_memory runtime loop', () => {
  beforeEach(() => resetStore());

  test('a validated success writes memory automatically — no PR merge, no human, no extract-branch-lesson.js', async () => {
    const id = await recordFixOutcome({
      memoryRefId: null,
      category: 'content',
      scope: 'client',
      siteId: 1,
      generatorId: 'alt-text',
      problemSignature: 'missing-alt-text:decorative-svg',
      symptoms: 'Decorative inline SVG icons were missing alt text, failing the accessibility check.',
      affectedPattern: 'Decorative <svg> elements rendered without an accompanying alt/aria-hidden attribute.',
      fixStrategy: 'Add aria-hidden="true" to purely decorative inline SVGs instead of an empty alt.',
      outcome: 'success',
      agentId: 'alt-text-generator',
    });
    assert.equal(store.length, 1);
    assert.equal(store[0].id, id);
    assert.equal(store[0].status, 'candidate');
    assert.equal(store[0].source_type, 'runtime-auto');
  });

  test('a different generator on a different site retrieves the memory by pattern, not identity', async () => {
    await recordFixOutcome({
      category: 'content', scope: 'global', siteId: null, generatorId: null,
      problemSignature: 'missing-alt-text:decorative-svg',
      symptoms: 'Decorative inline SVG icons were missing alt text, failing the accessibility check.',
      affectedPattern: 'Decorative <svg> elements rendered without alt/aria-hidden.',
      fixStrategy: 'Add aria-hidden="true" to purely decorative inline SVGs.',
      outcome: 'success',
    });

    const results = await findRelevantMemory({
      scope: 'client', siteId: 999, generatorId: 'schema-repair', clientFacing: true,
      problemSignature: 'missing-alt-text:decorative-svg',
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].relevanceReason, 'exact-pattern-match');
    assert.equal(results[0].executionPermission, 'requires_approval');
  });

  test('a validated reuse increments successful_reuse_count and raises confidence', async () => {
    const memId = await recordFixOutcome({
      category: 'technical-seo', scope: 'client', siteId: 1, generatorId: 'schema-repair',
      problemSignature: 'jsonld-missing-context', symptoms: 'JSON-LD block missing @context.',
      affectedPattern: 'Generated JSON-LD omits @context.', fixStrategy: 'Always include "@context": "https://schema.org".',
      outcome: 'success',
    });
    const before = store.find((r) => r.id === memId);
    assert.equal(before.successful_reuse_count, 0);
    const confidenceBefore = before.confidence;

    await recordFixOutcome({
      memoryRefId: memId, outcome: 'success', agentId: 'schema-repair', generatorId: 'schema-repair', siteId: 2,
    });

    const after = store.find((r) => r.id === memId);
    assert.equal(after.successful_reuse_count, 1);
    assert.ok(after.confidence > confidenceBefore);
    assert.equal(after.reuse_history.length, 1);
    assert.equal(after.reuse_history[0].outcome, 'success');
  });

  test('a failed reuse is recorded and repeated failure stops future blind reuse', async () => {
    const memId = await recordFixOutcome({
      category: 'technical-seo', scope: 'client', siteId: 1, generatorId: 'broken-link-fix',
      problemSignature: 'redirect-loop-fix', symptoms: 'Broken link pointed at a page returning a redirect loop.',
      affectedPattern: 'Internal link target 301-redirects back to itself.', fixStrategy: 'Repoint the link at the final resolved URL.',
      outcome: 'success',
    });

    await recordFixOutcome({ memoryRefId: memId, outcome: 'failure', generatorId: 'broken-link-fix', siteId: 3 });
    let row = store.find((r) => r.id === memId);
    assert.equal(row.failed_reuse_count, 1);
    assert.equal(row.status, 'candidate'); // one failure alone doesn't blacklist it

    await recordFixOutcome({ memoryRefId: memId, outcome: 'failure', generatorId: 'broken-link-fix', siteId: 4 });
    row = store.find((r) => r.id === memId);
    assert.equal(row.failed_reuse_count, 2);
    assert.equal(row.status, 'flagged_for_review');

    const results = await findRelevantMemory({
      scope: 'client', siteId: 5, generatorId: 'broken-link-fix', clientFacing: true,
      problemSignature: 'redirect-loop-fix',
    });
    assert.equal(results.length, 0, 'a twice-failed reuse must not be blindly retrieved/reused again');
  });

  test('a client-facing retrieval never returns a category=code row, even when maximally similar', async () => {
    await recordFixOutcome({
      category: 'code', scope: 'repo', siteId: null, generatorId: null,
      problemSignature: 'missing-alt-text:decorative-svg',
      symptoms: 'Decorative inline SVG icons were missing alt text, failing the accessibility check.',
      affectedPattern: 'Decorative <svg> elements rendered without alt/aria-hidden.',
      fixStrategy: 'Add aria-hidden="true" to purely decorative inline SVGs.',
      outcome: 'success', sourceType: 'human-edit',
    });

    const clientResults = await findRelevantMemory({
      scope: 'client', siteId: 1, generatorId: 'alt-text', clientFacing: true,
      problemSignature: 'missing-alt-text:decorative-svg',
      symptoms: 'Decorative inline SVG icons were missing alt text, failing the accessibility check.',
    });
    assert.equal(clientResults.length, 0, 'category=code must be structurally unreachable from a client-facing lookup');

    const codeResults = await findRelevantMemory({
      category: 'code', scope: 'repo', clientFacing: false, problemSignature: 'missing-alt-text:decorative-svg',
    });
    assert.equal(codeResults.length, 1, 'the same row must still be retrievable from a non-client-facing (code) lookup');
  });

  test('occurrence promotes candidate/requires_approval to trusted/auto after repeated validated occurrences (never for category=code)', async () => {
    const params = {
      category: 'content', scope: 'client', siteId: 1, generatorId: 'meta-title',
      problemSignature: 'duplicate-meta-title', symptoms: 'Two pages shared an identical meta title.',
      affectedPattern: 'Generated meta title duplicates another page on the same site.',
      fixStrategy: 'Include a page-distinguishing qualifier in the generated title.',
      validationRuleId: 'duplicate-meta-title-rule', outcome: 'success',
    };
    const id1 = await recordFixOutcome(params);
    await recordFixOutcome(params);
    await recordFixOutcome(params);
    const row = store.find((r) => r.id === id1);
    assert.equal(row.occurrence_count, 3);
    assert.equal(row.status, 'trusted');
    assert.equal(row.execution_permission, 'auto');

    const codeParams = {
      category: 'code', scope: 'repo', problemSignature: 'hook-ordering-crash',
      symptoms: 'React hook called after an early return crashed the component.',
      affectedPattern: 'Components with early-return guards before hooks.',
      fixStrategy: 'Move all hook calls above any early return.',
      validationRuleId: 'hook-ordering-rule', outcome: 'success',
    };
    const codeId = await recordFixOutcome(codeParams);
    await recordFixOutcome(codeParams);
    await recordFixOutcome(codeParams);
    const codeRow = store.find((r) => r.id === codeId);
    assert.equal(codeRow.occurrence_count, 3);
    assert.equal(codeRow.execution_permission, 'informational', 'category=code must never auto-promote to auto-appliable');
  });
});

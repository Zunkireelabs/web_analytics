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

  // Must be tested BEFORE the findRelevantMemory shape below — both start
  // with "SELECT * FROM agent_fix_memory", and this one is the stricter,
  // cross-tenant path (findPortableRepairs).
  if (sql.startsWith('SELECT * FROM agent_fix_memory') && sql.includes("status = 'trusted'")) {
    const [category, problemSignature] = params;
    let rows = store.filter((r) => r.status === 'trusted'
      && r.execution_permission === 'auto'
      && r.category !== 'code'
      && (r.scope === 'client' || r.scope === 'global')
      && r.repair_recipe != null
      && r.site_fingerprint != null
      && r.failed_reuse_count === 0
      && r.problem_signature.toLowerCase() === String(problemSignature).toLowerCase());
    if (category != null) rows = rows.filter((r) => r.category === category);
    rows = rows.sort((a, b) => b.confidence - a.confidence || b.successful_reuse_count - a.successful_reuse_count).slice(0, 20);
    return { rows: rows.map((r) => ({ ...r })) };
  }

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
      root_cause, affected_pattern, fix_strategy, fix_pattern, validation_rule_id, source_type, source_ref,
      site_fingerprint, repair_recipe] = params;
    const id = nextId++;
    store.push({
      id, category, scope, execution_permission, status: 'candidate', site_id, generator_id, problem_signature,
      symptoms, root_cause, affected_pattern, fix_strategy, fix_pattern, confidence: 0.5, occurrence_count: 1,
      successful_reuse_count: 0, failed_reuse_count: 0, reuse_history: [], validation_rule_id, source_type, source_ref,
      // Stored parsed, matching how pg returns a jsonb column.
      site_fingerprint: site_fingerprint ? JSON.parse(site_fingerprint) : null,
      repair_recipe: repair_recipe ? JSON.parse(repair_recipe) : null,
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

  if (sql.startsWith('UPDATE agent_fix_memory') && sql.includes("SET status = 'deprecated'")) {
    const [id, suffix] = params;
    const row = store.find((r) => r.id === id && r.status !== 'deprecated');
    if (!row) return { rows: [] };
    row.status = 'deprecated';
    row.root_cause = `${row.root_cause || ''}${suffix}`;
    return { rows: [{ id }] };
  }

  if (sql.startsWith('SELECT id, generator_id FROM agent_fix_memory')) {
    // No registry filter in SQL any more — every non-null producer is
    // returned and classified in JS by lesson-producers.js.
    const rows = store.filter((r) => r.status !== 'deprecated' && r.generator_id != null);
    return { rows: rows.map((r) => ({ id: r.id, generator_id: r.generator_id })) };
  }

  throw new Error(`agent-memory.test.js fake query: unhandled SQL shape: ${sql}`);
}

// Resolved RELATIVE to this file, never as an absolute path. A hardcoded
// '/Users/<someone>/...' specifier here matched only one developer's own
// checkout: everywhere else — a git worktree, CI, a second clone, the Docker
// build — the specifier simply never matched the module being imported, so
// the mock silently did not apply, `query` reached the real db.js, and all 31
// tests below failed on a machine where nothing was actually wrong. Silently,
// because a mock that matches nothing is not an error.
mock.module(new URL('./db.js', import.meta.url).href, {
  namedExports: { query: (text, params) => fakeQuery(text, params) },
});
const { findRelevantMemory, recordFixOutcome, findPortableRepairs, deprecateMemory, deprecateObsoleteMemories, sanitizeLessonText } = await import('./agent-memory.js');

// Promotes a freshly-recorded row to the exact state findPortableRepairs
// requires, without hand-writing a store row — so these tests exercise the
// real promotion ladder rather than a fixture that assumes its outcome.
function makePortable(id, { successSites = [] } = {}) {
  const row = store.find((r) => r.id === id);
  row.status = 'trusted';
  row.execution_permission = 'auto';
  row.reuse_history = successSites.map((siteId) => ({ siteId, outcome: 'success' }));
  return row;
}

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

// findPortableRepairs is the ONLY retrieval path allowed to return a lesson
// learned on a different client's site, and the only one whose result can
// lead to a real PR against a repo the lesson was never proven on. Every
// clause below is a safety requirement, so each gets its own refusal test.
describe('findPortableRepairs — cross-client retrieval', () => {
  beforeEach(() => resetStore());

  const FP = ['render:eleventy', 'target-ext:.njk'];
  const RECIPE = { kind: 'generator-chain', generatorId: 'alt-text' };
  const base = {
    category: 'content', scope: 'client', generatorId: 'alt-text',
    problemSignature: 'alt-text:missing-alt',
    symptoms: 'Images were missing alt text.',
    affectedPattern: 'Pages with img tags lacking an alt attribute.',
    fixStrategy: 'Add a grounded alt attribute via the exact-match injector.',
    outcome: 'success', siteFingerprint: FP, repairRecipe: RECIPE,
  };

  async function seed(overrides = {}) {
    return recordFixOutcome({ ...base, siteId: 1, ...overrides });
  }

  test('returns a trusted, auto, recipe-bearing row proven on enough distinct sites', async () => {
    const id = await seed();
    makePortable(id, { successSites: [2] }); // learned on site 1, reused on site 2
    const found = await findPortableRepairs({ problemSignature: base.problemSignature, targetSiteId: 7 });
    assert.equal(found.length, 1);
    assert.equal(found[0].id, id);
    assert.equal(found[0].provenSiteCount, 2);
    assert.deepEqual(found[0].siteFingerprint, FP);
    assert.deepEqual(found[0].repairRecipe, RECIPE);
  });

  test('the default floor (minDistinctSites=1) still returns a row proven on exactly one OTHER site', async () => {
    // 1 is the absolute floor: zero cross-site evidence is never portable,
    // but the module itself does not know any generator's real evidence
    // bar — that is applied by the caller (agents/lib/learned-repair.js),
    // strictly after its own technical/structural/content-context
    // compatibility check. See that module's decision-chain comment.
    const id = await seed({ siteId: 7 }); // learned on the target site itself, so it contributes no evidence
    makePortable(id, { successSites: [2] }); // reused successfully on exactly one OTHER site
    const found = await findPortableRepairs({ problemSignature: base.problemSignature, targetSiteId: 7 });
    assert.equal(found.length, 1);
    assert.equal(found[0].provenSiteCount, 1);
  });

  test('an explicit higher minDistinctSites still refuses a row proven on only ONE other site — correct is not the same as portable', async () => {
    const id = await seed();
    makePortable(id, { successSites: [1] }); // same site as it was learned on
    assert.deepEqual(await findPortableRepairs({ problemSignature: base.problemSignature, targetSiteId: 7, minDistinctSites: 2 }), []);
  });

  test('refuses a row with NO cross-site evidence at all, even against the default floor', async () => {
    // Learned directly ON the target site, with no other site's success —
    // distinctSuccessSites excludes the target site itself, so this is
    // genuinely zero cross-site evidence, not just "below some tier".
    const id = await seed({ siteId: 7 });
    makePortable(id, { successSites: [] });
    assert.deepEqual(await findPortableRepairs({ problemSignature: base.problemSignature, targetSiteId: 7 }), []);
  });

  test('does not count the target site as its own evidence', async () => {
    // Learned ON the target site (7) and "reused" there too — if the target
    // site were ever wrongly counted as its own evidence this would show one
    // distinct site and pass even the default floor; correctly excluded, it
    // is zero and must refuse.
    const id = await seed({ siteId: 7 });
    makePortable(id, { successSites: [7] });
    assert.deepEqual(await findPortableRepairs({ problemSignature: base.problemSignature, targetSiteId: 7 }), []);
  });

  test('refuses a row that is still only a candidate', async () => {
    const id = await seed();
    makePortable(id, { successSites: [2] });
    store.find((r) => r.id === id).status = 'candidate';
    assert.deepEqual(await findPortableRepairs({ problemSignature: base.problemSignature, targetSiteId: 7 }), []);
  });

  test('refuses a row still at requires_approval', async () => {
    const id = await seed();
    makePortable(id, { successSites: [2] });
    store.find((r) => r.id === id).execution_permission = 'requires_approval';
    assert.deepEqual(await findPortableRepairs({ problemSignature: base.problemSignature, targetSiteId: 7 }), []);
  });

  test('refuses after a SINGLE past failure — stricter than same-site retrieval', async () => {
    const id = await seed();
    makePortable(id, { successSites: [2] });
    store.find((r) => r.id === id).failed_reuse_count = 1;
    assert.deepEqual(await findPortableRepairs({ problemSignature: base.problemSignature, targetSiteId: 7 }), []);
  });

  test('refuses a legacy row with no fingerprint — no evidence of WHERE it worked', async () => {
    const id = await seed({ siteFingerprint: null });
    makePortable(id, { successSites: [2] });
    assert.deepEqual(await findPortableRepairs({ problemSignature: base.problemSignature, targetSiteId: 7 }), []);
  });

  test('refuses an advisory row with no repair recipe', async () => {
    const id = await seed({ repairRecipe: null });
    makePortable(id, { successSites: [2] });
    assert.deepEqual(await findPortableRepairs({ problemSignature: base.problemSignature, targetSiteId: 7 }), []);
  });

  test('a code lesson can never be returned, however it is promoted', async () => {
    const id = await recordFixOutcome({
      ...base, siteId: 1, category: 'code', scope: 'repo', problemSignature: 'code:some-bug',
    });
    const row = makePortable(id, { successSites: [2] });
    row.execution_permission = 'auto'; // force past the code-stays-informational rule
    assert.deepEqual(await findPortableRepairs({ problemSignature: 'code:some-bug', targetSiteId: 7 }), []);
  });

  test('requires an exact problem_signature — no keyword fallback on this path', async () => {
    const id = await seed();
    makePortable(id, { successSites: [2] });
    assert.deepEqual(await findPortableRepairs({ problemSignature: 'alt-text:something-else', targetSiteId: 7 }), []);
  });

  test('returns nothing when given no signature at all', async () => {
    assert.deepEqual(await findPortableRepairs({ targetSiteId: 7 }), []);
  });
});

// Cross-site reuse is intentional (findPortableRepairs above deliberately
// does NOT filter by site_id — see learned-repair.js's "CROSS-SITE SAFETY
// BOUNDARY" comment). What must never happen is a client-specific detail —
// a URL, a client name, reproduced draft copy — riding along inside a row
// that another client's repair-reuse can read. Two independent nets: (1)
// sanitizeLessonText redacts every free-text field on the INSERT path, and
// (2) findPortableRepairs' own returned shape never exposes those free-text
// fields at all, so even an unsanitized value couldn't reach the reuse path.
describe('cross-site content safety — a shared lesson can never carry client-specific content', () => {
  beforeEach(() => resetStore());

  test('sanitizeLessonText redacts URLs, emails and long quoted spans', () => {
    assert.equal(sanitizeLessonText('See https://client-a.example/products/widget for the broken page.'), 'See <url> for the broken page.');
    assert.equal(sanitizeLessonText('Contact ops@client-a.example about this.'), 'Contact <email> about this.');
    const longQuote = 'x'.repeat(90);
    assert.equal(sanitizeLessonText(`The draft said "${longQuote}" verbatim.`), 'The draft said "<quoted-content>" verbatim.');
  });

  test('a URL/email/long-quote written through recordFixOutcome is redacted before it ever reaches the row', async () => {
    const id = await recordFixOutcome({
      category: 'content', scope: 'client', siteId: 1, generatorId: 'faq',
      problemSignature: 'faq:leaky-symptom',
      symptoms: `Reproduced from https://client-a.example/pricing — contact billing@client-a.example. Quote: "${'y'.repeat(90)}"`,
      affectedPattern: 'faq generation output',
      fixStrategy: 'Rewrite the section',
      outcome: 'success',
    });
    const row = store.find((r) => r.id === id);
    assert.doesNotMatch(row.symptoms, /https?:\/\//);
    assert.doesNotMatch(row.symptoms, /client-a\.example/);
    assert.doesNotMatch(row.symptoms, /y{80,}/);
  });

  test('findPortableRepairs never returns symptoms/root_cause/affected_pattern/fix_strategy/fix_pattern — a cross-site reader has no way to read free text even if it were unsanitized', async () => {
    const id = await recordFixOutcome({
      category: 'content', scope: 'client', siteId: 1, generatorId: 'alt-text',
      problemSignature: 'alt-text:leak-shape-check',
      symptoms: 'Images were missing alt text.',
      affectedPattern: 'Pages with img tags lacking an alt attribute.',
      fixStrategy: 'Add a grounded alt attribute.',
      outcome: 'success',
      siteFingerprint: ['render:eleventy'], repairRecipe: { kind: 'generator-chain', generatorId: 'alt-text' },
    });
    makePortable(id, { successSites: [2] });
    const [found] = await findPortableRepairs({ problemSignature: 'alt-text:leak-shape-check', targetSiteId: 7 });
    assert.ok(found);
    for (const field of ['symptoms', 'rootCause', 'affectedPattern', 'fixStrategy', 'fixPattern', 'notes']) {
      assert.ok(!(field in found), `findPortableRepairs leaked a free-text field: ${field}`);
    }
    assert.deepEqual(Object.keys(found).sort(), [
      'confidence', 'generatorId', 'id', 'problemSignature', 'provenSiteCount', 'repairRecipe', 'siteFingerprint', 'successfulReuseCount',
    ]);
  });

  test('repair_recipe carries only a generator routing decision, never client content', async () => {
    // buildRepairRecipe (learned-repair.js) only ever produces
    // {kind, generatorId, version} — asserted here at the storage boundary,
    // since this is the one thing that DOES travel from site A to site B.
    const id = await recordFixOutcome({
      category: 'content', scope: 'client', siteId: 1, generatorId: 'faq',
      problemSignature: 'faq:recipe-shape-check',
      symptoms: 'x', affectedPattern: 'y', fixStrategy: 'z', outcome: 'success',
      siteFingerprint: ['render:eleventy'],
      repairRecipe: { kind: 'generator-chain', generatorId: 'faq', version: 1 },
    });
    const row = store.find((r) => r.id === id);
    assert.deepEqual(Object.keys(row.repair_recipe).sort(), ['generatorId', 'kind', 'version']);
  });
});

// The guarantee that merging this changes nothing for anyone: every existing
// caller of findRelevantMemory passes no fingerprint, and must keep getting
// byte-identical results.
describe('no-production-change proof', () => {
  beforeEach(() => resetStore());

  test('findRelevantMemory is unaffected by the new columns', async () => {
    await recordFixOutcome({
      category: 'content', scope: 'client', siteId: 1, generatorId: 'alt-text',
      problemSignature: 'alt-text:missing-alt', symptoms: 'Images were missing alt text.',
      affectedPattern: 'Pages with img tags lacking an alt attribute.',
      fixStrategy: 'Add a grounded alt attribute.', outcome: 'success',
      siteFingerprint: ['render:eleventy'], repairRecipe: { kind: 'generator-chain' },
    });
    const found = await findRelevantMemory({ scope: 'client', siteId: 1, generatorId: 'alt-text' });
    assert.equal(found.length, 1);
    // The new columns are deliberately absent from the returned shape — a
    // prompt-injection consumer has no business seeing an executable recipe.
    assert.ok(!('siteFingerprint' in found[0]));
    assert.ok(!('repairRecipe' in found[0]));
    assert.equal(found[0].executionPermission, 'requires_approval');
  });
});

// Two capabilities that existed in the schema but had never once run: the
// fix_pattern prompt branch (0 of 58 live rows had one, making
// withAgentMemory's "Fix: ..." form unreachable) and status='deprecated'
// (in every read filter, written by nothing).
describe('fix_pattern reaches the prompt only when trusted', () => {
  beforeEach(() => resetStore());

  const lesson = {
    category: 'content', scope: 'client', siteId: 1, generatorId: 'faq',
    problemSignature: 'todo-marker', validationRuleId: 'todo-marker',
    symptoms: 'Past faq drafts left a TODO marker.',
    affectedPattern: 'faq generation output matching Quality Gate pattern "todo-marker".',
    fixStrategy: 'Avoid "todo-marker" on the first attempt.',
    fixPattern: 'Never emit TODO/TBD/FIXME markers — write the finished text.',
    outcome: 'success',
  };

  test('a candidate lesson stores its directive but is not yet auto-appliable', async () => {
    const id = await recordFixOutcome(lesson);
    const row = store.find((r) => r.id === id);
    assert.equal(row.fix_pattern, lesson.fixPattern);
    assert.equal(row.execution_permission, 'requires_approval', 'one occurrence is not enough to inline a directive');
  });

  test('after the trust threshold it becomes auto, which is what unlocks the "Fix:" prompt form', async () => {
    const id = await recordFixOutcome(lesson);
    await recordFixOutcome(lesson);
    await recordFixOutcome(lesson);
    const row = store.find((r) => r.id === id);
    assert.equal(row.status, 'trusted');
    assert.equal(row.execution_permission, 'auto');
    assert.equal(row.fix_pattern, lesson.fixPattern, 'the directive survives promotion');
  });

  test('a lesson with no directive stays advisory rather than carrying invented guidance', async () => {
    const id = await recordFixOutcome({ ...lesson, fixPattern: null, validationRuleId: 'unknown-pattern', problemSignature: 'unknown-pattern' });
    assert.equal(store.find((r) => r.id === id).fix_pattern, null);
  });
});

describe('deprecation — retiring obsolete lessons', () => {
  beforeEach(() => resetStore());

  const base = {
    category: 'content', scope: 'client', siteId: 1,
    symptoms: 'x', affectedPattern: 'y', fixStrategy: 'z', outcome: 'success',
  };

  test('REGRESSION: a Design Agent lesson survives a sweep with the full registry', async () => {
    // The exact row the old registry-absence rule would have destroyed. Its
    // producer is not a generator and never will be, so no registry list can
    // ever vouch for it.
    const design = await recordFixOutcome({ ...base, generatorId: 'design-agent-component-templates', problemSignature: 'missing-placeholders:faq' });
    const { retired, skipped } = await deprecateObsoleteMemories(['faq', 'meta-title', 'alt-text']);
    assert.deepEqual(retired, []);
    assert.equal(store.find((r) => r.id === design).status, 'candidate');
    assert.equal(skipped.find((s) => s.id === design).status, 'active');
  });

  test('REGRESSION: a Design Agent lesson survives a sweep with an EMPTY registry', async () => {
    // Simulates running the sweep from a checkout where the Design Agent code
    // does not exist — which is the real situation on the stage line.
    const design = await recordFixOutcome({ ...base, generatorId: 'design-agent-component-templates', problemSignature: 'missing-placeholders:qa-content' });
    const { retired } = await deprecateObsoleteMemories([]);
    assert.deepEqual(retired, []);
    assert.equal(store.find((r) => r.id === design).status, 'candidate');
  });

  test('an unrecognised producer is kept and reported, never retired', async () => {
    const unknown = await recordFixOutcome({ ...base, generatorId: 'mystery-producer', problemSignature: 'g' });
    const { retired, skipped } = await deprecateObsoleteMemories(['faq']);
    assert.deepEqual(retired, []);
    assert.equal(store.find((r) => r.id === unknown).status, 'candidate');
    assert.equal(skipped.find((s) => s.id === unknown).status, 'unknown');
  });

  test('nothing is retired today, because nothing is declared retired', async () => {
    await recordFixOutcome({ ...base, generatorId: 'faq', problemSignature: 'h' });
    await recordFixOutcome({ ...base, generatorId: 'design-agent-component-templates', problemSignature: 'i' });
    await recordFixOutcome({ ...base, generatorId: null, problemSignature: 'j' });
    const { retired } = await deprecateObsoleteMemories(['faq']);
    assert.deepEqual(retired, [], 'a sweep run right now must be a no-op');
  });

  test('never touches generator_id NULL rows — those are cross-generator by design', async () => {
    const structural = await recordFixOutcome({ ...base, generatorId: null, problemSignature: 'c' });
    const { retired } = await deprecateObsoleteMemories(['faq']);
    assert.deepEqual(retired, []);
    assert.equal(store.find((r) => r.id === structural).status, 'candidate');
  });

  test('an empty generator list cannot wipe the table', async () => {
    const id = await recordFixOutcome({ ...base, generatorId: 'faq', problemSignature: 'd' });
    assert.deepEqual((await deprecateObsoleteMemories([])).retired, []);
    assert.deepEqual((await deprecateObsoleteMemories(null)).retired, []);
    assert.equal(store.find((r) => r.id === id).status, 'candidate');
  });

  test('a deprecated lesson is excluded from retrieval', async () => {
    const id = await recordFixOutcome({ ...base, generatorId: 'faq', problemSignature: 'e' });
    await deprecateMemory(id, 'superseded');
    assert.deepEqual(await findRelevantMemory({ scope: 'client', siteId: 1, generatorId: 'faq' }), []);
  });

  test('deprecating twice is a no-op, not a double write', async () => {
    const id = await recordFixOutcome({ ...base, generatorId: 'faq', problemSignature: 'f' });
    assert.equal(await deprecateMemory(id, 'first'), id);
    assert.equal(await deprecateMemory(id, 'second'), null);
  });
});

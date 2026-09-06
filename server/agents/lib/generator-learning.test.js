import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../../db.js';
import { recordOutcome, getLearnedConfidenceMap, attributeOutcome } from './generator-learning.js';
import { classifyRecommendation } from './autonomy-decision.js';

// Real DB coverage — the whole point of this module is a query over real
// persisted rows, which a mock cannot meaningfully stand in for.

const siteIds = [];
async function makeSite() {
  const stamp = `generator-learning-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone)
     VALUES ('generator-learning.test.js fixture', $1, $2, 'UTC') RETURNING id`,
    [stamp, stamp]
  );
  siteIds.push(rows[0].id);
  return rows[0].id;
}

after(async () => {
  if (siteIds.length) {
    await query('DELETE FROM generator_outcomes WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  }
  await pool.end();
});

describe('recordOutcome / getLearnedConfidenceMap', () => {
  test('with no history, a generator has no entry — never demoted on silence', async () => {
    const siteId = await makeSite();
    const map = await getLearnedConfidenceMap(siteId);
    assert.equal(map.has('schema'), false);
  });

  test('below the minimum sample size, confidence is null and nothing is demoted', async () => {
    const siteId = await makeSite();
    await recordOutcome(siteId, 'schema', 'failed');
    await recordOutcome(siteId, 'schema', 'failed');
    const map = await getLearnedConfidenceMap(siteId);
    const entry = map.get('schema');
    assert.equal(entry.confidence, null, 'two samples is not evidence of a pattern yet');
    assert.equal(entry.demote, false);
  });

  test('a real pattern of repeated failure demotes the generator', async () => {
    const siteId = await makeSite();
    await recordOutcome(siteId, 'meta-title', 'shipped');
    await recordOutcome(siteId, 'meta-title', 'failed');
    await recordOutcome(siteId, 'meta-title', 'failed');
    await recordOutcome(siteId, 'meta-title', 'failed');
    const map = await getLearnedConfidenceMap(siteId);
    const entry = map.get('meta-title');
    assert.equal(entry.demote, true);
    assert.match(entry.reason, /3 of 4/);
  });

  test('repeated success keeps a generator eligible and raises its confidence', async () => {
    const siteId = await makeSite();
    for (let i = 0; i < 5; i++) await recordOutcome(siteId, 'faq', 'shipped');
    const map = await getLearnedConfidenceMap(siteId);
    const entry = map.get('faq');
    assert.equal(entry.demote, false);
    assert.equal(entry.confidence, 1);
  });

  test('refusals are logged but never count toward demotion either way', async () => {
    const siteId = await makeSite();
    for (let i = 0; i < 6; i++) await recordOutcome(siteId, 'llms-txt', 'refused');
    const map = await getLearnedConfidenceMap(siteId);
    const entry = map.get('llms-txt');
    // 6 refusals, 0 scored — not enough SCORED samples, regardless of total.
    assert.equal(entry.confidence, null);
    assert.equal(entry.demote, false);
    assert.equal(entry.refused, 6);
  });

  test('a genuine human rejection counts as a negative outcome, same as a failure', async () => {
    const siteId = await makeSite();
    await recordOutcome(siteId, 'blog-outline', 'shipped');
    await recordOutcome(siteId, 'blog-outline', 'rejected');
    await recordOutcome(siteId, 'blog-outline', 'rejected');
    const map = await getLearnedConfidenceMap(siteId);
    assert.equal(map.get('blog-outline').demote, true);
  });

  test('a merged outcome is the strongest positive signal, same weight as shipped', async () => {
    const siteId = await makeSite();
    for (let i = 0; i < 3; i++) await recordOutcome(siteId, 'canonical', 'merged');
    const map = await getLearnedConfidenceMap(siteId);
    assert.equal(map.get('canonical').confidence, 1);
  });
});

describe('learning integrates with classifyRecommendation without weakening the safety boundary', () => {
  test('a demoted generator is routed to NEEDS_HUMAN_REVIEW even though risk_tier says safe', async () => {
    const siteId = await makeSite();
    for (let i = 0; i < 4; i++) await recordOutcome(siteId, 'schema-repair', 'failed');
    const learnedMap = await getLearnedConfidenceMap(siteId);
    const decision = classifyRecommendation({ risk_tier: 'safe', blocked_reason: null, status: 'open', recommendation_type: 'schema-repair' }, learnedMap);
    assert.equal(decision.decision, 'NEEDS_HUMAN_REVIEW');
    assert.match(decision.reason, /^learned:/);
  });

  test('learning can never promote a manual-tier generator to auto-execute', async () => {
    const siteId = await makeSite();
    for (let i = 0; i < 10; i++) await recordOutcome(siteId, 'broken-link-fix', 'shipped');
    const learnedMap = await getLearnedConfidenceMap(siteId);
    // This generator is risk_tier 'manual' in real risk-tiers.js regardless
    // of any outcome history — asserted here directly on the row shape.
    const decision = classifyRecommendation({ risk_tier: 'manual', blocked_reason: null, status: 'open', recommendation_type: 'broken-link-fix' }, learnedMap);
    assert.equal(decision.decision, 'NEEDS_HUMAN_REVIEW', 'a perfect success streak still cannot cross the risk-tier safety boundary');
  });

  test('omitting the learned map entirely preserves the exact Phase 4 behavior', () => {
    // Every pre-Phase-5 call site (and every Phase 4 test) calls this with
    // no second argument — learning must be additive, never a prerequisite.
    const decision = classifyRecommendation({ risk_tier: 'safe', blocked_reason: null, status: 'open', recommendation_type: 'schema' });
    assert.equal(decision.decision, 'SAFE_TO_AUTO_EXECUTE');
  });
});

// Attribution: the fix for the misattribution that demoted seven generators
// and removed 398 of site 1's 569 open recommendations from the autonomous
// shipping loop while the daily budget sat at 5 of 60 used (2026-09-04).
// Pure — no database needed, the decision is a function of the detail text.
describe('attributeOutcome', () => {
  test('a genuine, item-specific defect stays a failure', () => {
    assert.equal(attributeOutcome('failed', 'This content-expansion draft has no sections.'), 'failed');
    assert.equal(attributeOutcome('failed', '1 anchor(s) no longer found verbatim in src/pages/about.njk'), 'failed');
  });

  test('an unexplained failure stays a failure — unattributable is treated as real', () => {
    assert.equal(attributeOutcome('failed', null), 'failed');
    assert.equal(attributeOutcome('failed', '   '), 'failed');
  });

  test('infrastructure and human causes become infra, never the generator’s fault', () => {
    for (const detail of [
      'Auto-ship failed: getBranchSha failed (403): API rate limit exceeded for user ID 286862633',
      'Batch push/PR failed: This pull request could not be opened right now',
      "Auto-ship failed: Today's batch branch (action-center/batch-1-2026-08-30) has diverged from main",
      'Citation search is temporarily unavailable — try again shortly',
      'No GitHub PAT set in env var "GITHUB_PAT"',
      'Draft was not in a submittable state',
      'sent_back_to_recommendations',
      'pr_closed_without_merge',
    ]) {
      assert.equal(attributeOutcome('failed', detail), 'infra', `should not be scored as a failure: ${detail}`);
    }
  });

  test('a human’s own rejection reason is a real signal and stays rejected', () => {
    assert.equal(attributeOutcome('rejected', 'The tone is wrong for our brand.'), 'rejected');
  });

  test('a reconciler sentinel recorded as rejected is not a human verdict', () => {
    // RECLAIM_REASON (action-center-reconciler.js) means only "withdrawn and
    // returned to the board". These rows alone kept alt-text, broken-link-fix
    // and schema-repair demoted after the failure-side fix.
    assert.equal(attributeOutcome('rejected', 'sent_back_to_recommendations'), 'infra');
  });

  test('positive and refusal outcomes are never touched', () => {
    assert.equal(attributeOutcome('shipped', null), 'shipped');
    assert.equal(attributeOutcome('merged', 'anything at all'), 'merged');
    assert.equal(attributeOutcome('refused', 'citation-grounding-unavailable'), 'refused');
  });
});
